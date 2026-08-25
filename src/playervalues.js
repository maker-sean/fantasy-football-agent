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
async function fetchSheetSeries({ gid, superflex }, { since = null } = {}) {
  const res = await fetch(csvUrl(gid), { redirect: 'follow' });
  if (!res.ok) throw new Error(`sheet gid ${gid} -> ${res.status}`);
  const rows = parseCsv(await res.text());
  if (!rows.length) return [];

  const header = rows[0];
  const out = [];
  for (const row of rows.slice(1)) {
    const day = (row[0] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (since && day < since) continue;

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

async function playerIndex() {
  const { rows } = await db.query(
    "select player_id, full_name, position, team from players where position in ('QB','RB','WR','TE')");
  const byName = new Map();
  for (const p of rows) {
    const k = normalise(p.full_name);
    // First writer wins: the players table carries retired duplicates and the
    // active one sorts first often enough that guessing is worse than not.
    if (!byName.has(k)) byName.set(k, p);
  }
  return byName;
}

/**
 * Pull a source into player_values.
 *
 * Past dates are never rewritten — `do nothing` rather than `do update` — so a
 * source revising its own history cannot quietly change what we already told a
 * league. A day we have is a day we keep.
 */
async function ingest({ source = 'ktc', since = null, dryRun = false } = {}) {
  const spec = SOURCES[source];
  if (!spec) throw new Error(`unknown value source: ${source}`);

  const index = await playerIndex();
  const summary = { source, series: 0, rows: 0, matched: 0, picks: 0, unmatched: new Set(), written: 0 };

  for (const s of spec.series) {
    const records = await spec.fetch(s, { since });
    summary.series++;
    summary.rows += records.length;

    const batch = [];
    for (const r of records) {
      const pick = isPick(r.name);
      let player = null;
      if (pick) summary.picks++;
      else {
        const key = normalise(r.name);
        player = index.get(ALIASES.get(key) || key) || null;
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
  return summary;
}

/** The most recent value we hold for a player, in one league's settings. */
async function valueFor(sleeperId, { superflex = false, source = 'ktc' } = {}) {
  const { rows } = await db.query(
    `select value, captured_on, name from player_values
      where source = $1 and sleeper_id = $2 and superflex = $3
      order by captured_on desc limit 1`, [source, sleeperId, superflex]);
  return rows[0] || null;
}

module.exports = { ingest, valueFor, SOURCES, normalise, isPick, parseCsv };
