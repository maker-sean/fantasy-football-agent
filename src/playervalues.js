/**
 * Community trade values, dated, from a source we do not control.
 *
 * WHY THIS IS SWAPPABLE BY CONSTRUCTION. The numbers are KeepTradeCut's, and
 * KTC's terms forbid reproducing their values in a tool. Using them for a free
 * bot in three friends' leagues is Sean's call and a defensible one; it stops
 * being defensible the day somebody pays. So a source is a named entry in
 * SOURCES with a fetch function, `source` is a column on every row, and
 * replacing KTC later is a new entry rather than a rewrite under pressure.
 *
 * WHY THE HISTORICAL TAB RATHER THAN THE CURRENT ONES. The sheet's "current"
 * tabs were stamped 06/18/26 when this was written — over two months stale —
 * while the historical tab had a row for that morning. The freshness is
 * inverted from what the tab names suggest, and the historical tab also
 * carries the whole series back to 2020-04-01 rather than one day's snapshot.
 * It is both fresher and strictly more data.
 *
 * NOT FOR RETROSPECTIVE GRADING. src/trades.js already judges a trade three
 * weeks later on points actually scored, which is ground truth. These values
 * answer the other question — is a trade being proposed right now fair — and
 * the history answers "was it fair at the time", which is a different and much
 * weaker question than "did it work out".
 */

const db = require('./db');

const SHEET = process.env.KTC_SHEET_ID
  || '1n5aqip8iFCpltO8deiS7q9m3u_dFvKTZpwzfZXVTpgs';

/*
 * A source is a list of series to pull. Adding a provider means adding a key
 * here; nothing downstream knows the difference.
 */
const SOURCES = {
  ktc: {
    label: 'KeepTradeCut, via the community sheet',
    series: [
      { gid: '699541356', superflex: false },
      { gid: '991742784', superflex: true },
    ],
    fetch: fetchSheetSeries,
  },
};

const csvUrl = gid =>
  `https://docs.google.com/spreadsheets/d/${SHEET}/export?format=csv&gid=${gid}`;

/**
 * One row per line, respecting quoted commas.
 *
 * Hand-rolled because the only alternative is a dependency for a file whose
 * shape we control the parsing of, and the failure mode of a bad parse here is
 * a wrong VALUE rather than a crash — worth keeping in sight.
 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * The sheet is WIDE — a row per date, a column per asset. Unpivoted here into
 * one record per asset per date, which is the shape everything downstream
 * wants and the shape the table is.
 */
/*
 * ISO-week key, so "one capture a week" means the same week for every asset
 * regardless of which weekday the sheet happened to record.
 */
function weekKey(day) {
  const d = new Date(day + 'T00:00:00Z');
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-${Math.ceil(((t - start) / 86400000 + 1) / 7)}`;
}

/**
 * @param o.weekly  keep one capture per ISO week rather than every day.
 * @param o.until   ignore days on or after this, so a backfill stops where the
 *                  daily history already begins instead of duplicating it.
 */
async function fetchSheetSeries({ gid, superflex }, { since = null, weekly = false, until = null } = {}) {
  const res = await fetch(csvUrl(gid), { redirect: 'follow' });
  if (!res.ok) throw new Error(`sheet gid ${gid} -> ${res.status}`);
  const rows = parseCsv(await res.text());
  if (!rows.length) return [];

  const header = rows[0];
  const out = [];
  /*
   * WEEKLY IS THE DEFAULT SHAPE FOR HISTORY, and it costs almost nothing.
   *
   * The sheet carries a row a day back to 2020-04-01. Ingested daily that is
   * 1.62M rows and about 633MB against a 27MB database — past the tier ceiling
   * on this one table. Weekly is 231k rows and about 90MB.
   *
   * The accuracy given up is not the reason to prefer it, but it is the reason
   * it is safe: these values answer "what was this worth around the time of
   * that trade", the nearest capture is then at most three days off, and
   * dynasty values drift a percent or two a week absent injury news. That sits
   * far below the noise in any verdict built on top of it.
   */
  const seenWeek = new Set();
  for (const row of rows.slice(1)) {
    const day = (row[0] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (since && day < since) continue;
    if (until && day >= until) continue;
    if (weekly) {
      const k = weekKey(day);
      if (seenWeek.has(k)) continue;
      seenWeek.add(k);
    }

    for (let c = 1; c < header.length; c++) {
      const asset = (header[c] || '').trim();
      const raw = (row[c] || '').trim();
      if (!asset || !raw) continue;
      const value = Number(raw.replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      out.push({ capturedOn: day, name: asset, value: Math.round(value), superflex });
    }
  }
  return out;
}

/** A draft pick, not a person. No Sleeper id will ever exist for these. */
const isPick = name => /\b(1st|2nd|3rd|4th)\b/.test(name);

/*
 * Names, normalised to survive the differences the sheet warns about: KTC has
 * "Josh Palmer" where Sleeper has "Joshua Palmer", "Jeffery Wilson" for "Jeff
 * Wilson Jr.". Suffixes and punctuation go; the rest is matched exactly,
 * because a fuzzy match that silently pairs two different players is worse
 * than an unmatched row we can see and fix.
 */
const normalise = s => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  // Punctuation is REMOVED, not turned into a space. The sheet writes "D.J.
  // Moore" where Sleeper writes "DJ Moore"; replacing the periods with spaces
  // gives "d j moore" against "dj moore" and they never meet.
  .replace(/[^a-z ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
  .replace(/\s+/g, ' ').trim();

/*
 * Nicknames, which no normaliser reaches. Keyed by what the SOURCE calls them,
 * valued at what Sleeper does — the direction matters and I had it backwards
 * first time, which is why every one of these was verified against the players
 * table rather than assumed.
 */
const ALIASES = new Map(Object.entries({
  'chigoziem okonkwo': 'chig okonkwo',
  'kenneth gainwell': 'kenny gainwell',
  'gabriel davis': 'gabe davis',
}));

/*
 * Sleeper's own placeholders, which are not people and must never win a match.
 */
const JUNK = /^(player invalid|duplicate player)$/;

/**
 * Name to player, with the tie broken on purpose.
 *
 * The historical series is a date and a column of names — no position, no team
 * — so the name is all there is to match on, and names are not unique. There
 * are two Kenneth Walkers in Sleeper's database: a teamless WR and the Seattle
 * running back. "First writer wins" picked the WR, and the bot would have
 * offered a retired receiver as the most valuable asset on the board.
 *
 * A CURRENT TEAM IS THE TIEBREAK. Somebody on an NFL roster is overwhelmingly
 * the one a trade-value list means; a teamless duplicate is a retired player
 * keeping his row. Where both are teamed the collision is recorded rather than
 * guessed at, because two active players sharing a name is a case worth seeing.
 */
function playerIndex(rows) {
  const byName = new Map();
  const ambiguous = new Set();
  for (const p of rows) {
    const k = normalise(p.full_name);
    if (!k || JUNK.test(k)) continue;
    const held = byName.get(k);
    if (!held) { byName.set(k, p); continue; }
    const heldTeamed = Boolean(held.team);
    const nextTeamed = Boolean(p.team);
    if (nextTeamed && !heldTeamed) byName.set(k, p);
    else if (nextTeamed && heldTeamed) ambiguous.add(k);
  }
  return { byName, ambiguous };
}

async function loadPlayerIndex() {
  const { rows } = await db.query(
    "select player_id, full_name, position, team from players where position in ('QB','RB','WR','TE')");
  return playerIndex(rows);
}

/**
 * Pull a source into player_values.
 *
 * Past dates are never rewritten — `do nothing` rather than `do update` — so a
 * source revising its own history cannot quietly change what we already told a
 * league. A day we have is a day we keep.
 */
async function ingest({ source = 'ktc', since = null, until = null, weekly = false, dryRun = false } = {}) {
  const spec = SOURCES[source];
  if (!spec) throw new Error(`unknown value source: ${source}`);

  const { byName: index, ambiguous } = await loadPlayerIndex();
  const summary = { source, series: 0, rows: 0, matched: 0, picks: 0,
    unmatched: new Set(), ambiguous: new Set(), written: 0 };

  for (const s of spec.series) {
    const records = await spec.fetch(s, { since, weekly, until });
    summary.series++;
    summary.rows += records.length;

    const batch = [];
    for (const r of records) {
      const pick = isPick(r.name);
      let player = null;
      if (pick) summary.picks++;
      else {
        const key = ALIASES.get(normalise(r.name)) || normalise(r.name);
        player = index.get(key) || null;
        if (ambiguous.has(key)) summary.ambiguous.add(r.name);
        if (player) summary.matched++; else summary.unmatched.add(r.name);
      }
      batch.push({
        ...r,
        sleeperId: player?.player_id || null,
        position: pick ? 'PICK' : (player?.position || null),
        team: pick ? null : (player?.team || null),
      });
    }

    if (dryRun) continue;
    for (let i = 0; i < batch.length; i += 500) {
      const chunk = batch.slice(i, i + 500);
      const vals = chunk.map((_, n) => {
        const b = n * 9;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
      }).join(',');
      const params = chunk.flatMap(b =>
        [source, b.capturedOn, b.sleeperId, b.name, b.position, b.team, b.superflex, 'none', b.value]);
      const { rowCount } = await db.query(
        `insert into player_values
           (source, captured_on, sleeper_id, name, position, team, superflex, tep, value)
         values ${vals}
         on conflict (source, captured_on, name, superflex, tep) do nothing`, params);
      summary.written += rowCount;
    }
  }

  summary.unmatched = [...summary.unmatched];
  summary.ambiguous = [...summary.ambiguous];
  return summary;
}

/**
 * Which price list a league is actually entitled to.
 *
 * The values are dimensioned, not universal. The same player is worth eight
 * different numbers depending on settings, and a ninth thing decides whether
 * any of them apply at all:
 *
 *   FORMAT      dynasty values price a 21-year-old above a 30-year-old star.
 *               In a REDRAFT league that is not slightly off, it is inverted —
 *               and Sleeper says which outright in settings.type, so nothing
 *               here has to guess. Halcyon Kings is type 0 and would have
 *               been handed dynasty prices without this.
 *   SUPERFLEX   a quarterback is worth roughly double where two can start.
 *   TEP         a tight-end premium lifts every TE, on the sheet's own scale.
 *
 * Returned rather than applied, so the caller can say "we do not hold prices
 * for this league" instead of quietly serving the wrong ones — which is the
 * only failure mode here that a chat would never catch.
 */
function leagueVariant(settings) {
  const positions = settings?.roster_positions || [];
  const scoring = settings?.scoring_settings || {};
  const teSlots = positions.filter(p => p === 'TE').length;
  const qbSlots = positions.filter(p => p === 'QB').length;
  const teBonus = Number(scoring.bonus_rec_te || 0);

  // The sheet's own thresholds: a mild bonus is TE+, an extreme one or a second
  // TE slot is TE++, and both together is TE+++.
  let tep = 'none';
  if (teSlots >= 2 && teBonus > 0) tep = 'te+++';
  else if (teSlots >= 2 || teBonus >= 1) tep = 'te++';
  else if (teBonus > 0) tep = 'te+';

  return {
    // 2 is dynasty, 1 keeper, 0 redraft. Keeper is NOT treated as dynasty: it
    // sits between the two and guessing which way costs the same either way.
    dynasty: settings?.settings?.type === 2,
    format: ({ 0: 'redraft', 1: 'keeper', 2: 'dynasty' })[settings?.settings?.type] ?? 'unknown',
    superflex: positions.includes('SUPER_FLEX') || qbSlots >= 2,
    tep,
  };
}

/** Do we actually hold prices for this variant? */
async function haveValuesFor({ superflex, tep = 'none', source = 'ktc' } = {}) {
  const { rows } = await db.query(
    `select count(*)::int n, max(captured_on) as latest from player_values
      where source = $1 and superflex = $2 and tep = $3`, [source, superflex, tep]);
  return { held: rows[0].n > 0, rows: rows[0].n, latest: rows[0].latest };
}

/**
 * Who is still on the board, ranked by what the community thinks they are
 * worth.
 *
 * This is the question a draft actually asks, and projections cannot answer it:
 * a 21-year-old who projects for 40 points this season can be the most valuable
 * asset available in a DYNASTY league, and season projections rank him near
 * nobody. Community value prices the future; projections price September.
 *
 * Availability is computed from the league's own rosters rather than from a
 * draft's pick list, because a dynasty startup is not the only way players
 * leave the board — anyone already rostered is gone whether they were drafted
 * this week or three years ago.
 *
 * Names, not ids, on the exclusion. Roughly a third of the value list is
 * unmatched to a Sleeper id in any given week (retired players keep their
 * column), and excluding on id alone would offer those back as "available".
 */
async function bestAvailable(rosters, { superflex = false, source = 'ktc', limit = 8 } = {}) {
  const ownedIds = new Set((rosters || []).flatMap(r => (r.players || []).map(String)));

  const { rows } = await db.query(
    `select name, position, team, sleeper_id, value
       from player_values
      where source = $1 and superflex = $2
        and captured_on = (select max(captured_on) from player_values
                            where source = $1 and superflex = $2)
        and position <> 'PICK'
      order by value desc`, [source, superflex]);

  const open = rows.filter(r => !r.sleeper_id || !ownedIds.has(String(r.sleeper_id)));
  return { asOf: null, players: open.slice(0, limit), considered: rows.length, open: open.length };
}

/** The most recent value we hold for a player, in one league's settings. */
async function valueFor(sleeperId, { superflex = false, source = 'ktc' } = {}) {
  const { rows } = await db.query(
    `select value, captured_on, name from player_values
      where source = $1 and sleeper_id = $2 and superflex = $3
      order by captured_on desc limit 1`, [source, sleeperId, superflex]);
  return rows[0] || null;
}


/**
 * Thin old captures down to one a week.
 *
 * The daily cron adds about 692 rows a day, which is ~99MB a year — so the
 * table outgrows the historical backfill inside a year and then keeps going.
 * Recent days stay daily because "what is this worth now" and any sense of
 * which way a value is moving both want them; beyond the window the only
 * question these rows answer is "what was this worth around then", and a week
 * is finer than that question needs.
 *
 * DELETES ROWS, so it is written to be boring: nothing inside the window is
 * ever touched, the FIRST capture of each week survives, and dryRun reports
 * exactly what would go without going.
 */
async function thin({ days = 90, dryRun = false } = {}) {
  const { rows: [before] } = await db.query(
    `select count(*)::int n, count(distinct captured_on)::int days from player_values`);

  const scope = `captured_on < (current_date - ($1 || ' days')::interval)`;
  const { rows: [doomed] } = await db.query(
    `select count(*)::int n from player_values
      where ${scope}
        and captured_on not in (
          select min(captured_on) from player_values
           where ${scope}
           group by date_trunc('week', captured_on))`, [String(days)]);

  if (dryRun) return { before, wouldDelete: doomed.n, deleted: 0, dryRun: true };

  const { rowCount } = await db.query(
    `delete from player_values
      where ${scope}
        and captured_on not in (
          select min(captured_on) from player_values
           where ${scope}
           group by date_trunc('week', captured_on))`, [String(days)]);

  const { rows: [after] } = await db.query(
    `select count(*)::int n, count(distinct captured_on)::int days from player_values`);
  return { before, after, deleted: rowCount, dryRun: false };
}

module.exports = { ingest, thin, weekKey, valueFor, bestAvailable, leagueVariant, haveValuesFor, playerIndex, SOURCES, normalise, isPick, parseCsv };
