/**
 * The trade ledger, announced rather than asked for — twice a season.
 *
 * WHY NOT A FROZEN GRADE. A dynasty trade is not over for years, so nothing is
 * stored: the ledger is recomputed at the moment it is sent, and the same
 * question asked in March gets a different and equally honest answer. That is
 * the same reason this project has never written a dynasty verdict.
 *
 * WHY TWICE. Once at the season's start, when the offseason's trading is done
 * and everyone wants to know who won it; once at the end, when a year has
 * passed and the picks people argued about have played. Quarterly would pester
 * a group about the same trade four times, and a rookie needs a full season
 * before "did it work out" means anything.
 *
 * TOP AND BOTTOM ONLY. A league can carry hundreds of trades and a dozen
 * managers, and the full table is a wall nobody reads. The ends are the
 * argument; the middle is available by asking for a name, and the message says
 * so rather than leaving it to look like nobody else has traded.
 */

const db = require('./db');

/** Sent once per league per phase per season, and this is the key. */
const flagKey = (leagueId, season, phase) => `ledger_recap:${leagueId}:${season}:${phase}`;

/**
 * Which moment we are in, or null for the rest of the year.
 *
 * Deliberately narrow. 'start' is the opening week of the regular season, when
 * the offseason ledger is final; 'end' is the week after the last one, when the
 * season just played can be judged. Everything between is silence.
 */
function phaseFor(state, { finalWeek = 17 } = {}) {
  if (!state) return null;
  const type = String(state.season_type || '').toLowerCase();
  const week = Number(state.week) || 0;
  if (type === 'regular' && week === 1) return 'start';
  if (type === 'post' || (type === 'regular' && week > finalWeek)) return 'end';
  return null;
}

async function alreadySent(leagueId, season, phase) {
  const { rows } = await db.query('select 1 from system_flags where key = $1',
    [flagKey(leagueId, season, phase)]);
  return rows.length > 0;
}

async function markSent(leagueId, season, phase, detail) {
  await db.query(
    `insert into system_flags (key, value, updated_by) values ($1, $2, 'ledger-recap')
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [flagKey(leagueId, season, phase), JSON.stringify(detail || {})]);
}

/**
 * Build the message for one league. Returns null when there is nothing to say,
 * which is a real outcome for a league that has not traded.
 */
async function build(league, { top = 4 } = {}) {
  const dv = require('./dynastyvalue');
  const sleeper = require('./sleeper');
  const { leagueContext } = require('./context');

  const ctx = await leagueContext(league.id);
  if (!ctx) return null;

  const nameFor = rid => {
    const m = (ctx.members || []).find(x => Number(x.rosterId) === Number(rid));
    return m?.name || `roster ${rid}`;
  };

  /*
   * REDRAFT IS ALREADY SETTLED, so it does not get a market estimate.
   *
   * A redraft trade is judged three weeks later on points the players actually
   * scored in a lineup, which is ground truth and beats anything a value sheet
   * can say. Pricing one of those leagues on dynasty values produced "4 of 16
   * trades valued" — a market guess replacing a measured result, on trades that
   * were graded years ago.
   *
   * There is no then-and-now here either: points do not move once scored.
   */
  if (!ctx.valueVariant?.dynasty) {
    const { rows: graded } = await db.query(
      `select t.verdict from trades t join leagues l on l.id = t.league_id
        where l.sleeper_league_id = any($1::text[]) and t.verdict is not null`,
      [ctx.chainIds || []]);
    if (graded.length < 2) return null;

    const per = new Map();
    for (const g of graded) {
      const sides = g.verdict?.sides;
      if (!sides || sides.length !== 2 || g.verdict.margin == null) continue;
      for (const [rid, d] of [[sides[0].rosterId, g.verdict.margin], [sides[1].rosterId, -g.verdict.margin]]) {
        const k = nameFor(rid);
        const e = per.get(k) || { name: k, points: 0, won: 0, lost: 0 };
        e.points += d;
        if (d > 0) e.won++; else e.lost++;
        per.set(k, e);
      }
    }
    const rows = [...per.values()]
      .map(r => ({ ...r, points: Math.round(r.points * 10) / 10 }))
      .sort((a, b) => b.points - a.points);
    if (!rows.length) return null;

    const n = Math.min(top, Math.max(1, Math.floor(rows.length / 3)));
    /*
     * Points stay as points here — a redraft league already thinks in them and
     * "+335 points" is a sentence anybody in one understands. Only the letter
     * is added, since a total on its own gives no sense of where that sits.
     */
    const dv2 = require('./dynastyvalue');
    const sign = v => (v > 0 ? `+${v}` : `${v}`);
    const lines = [`Trade ledger, ${graded.length} settled trades, judged on points actually scored.`];
    const say2 = r => {
      const g = dv2.traderGrade(rows.indexOf(r) + 1, rows.length);
      return `  ${r.name} ${g.grade}, ${sign(r.points)} points (${r.won}-${r.lost})`;
    };
    lines.push('Up:');
    for (const r of rows.slice(0, n)) lines.push(say2(r));
    lines.push('Down:');
    for (const r of rows.slice(-n).reverse()) lines.push(say2(r));
    const mid = rows.length - 2 * n;
    if (mid > 0) lines.push(`${mid} others in the middle, ask me for a name.`);
    return { text: lines.join('\n'), basis: 'points', rows };
  }

  const { rows: trades } = await db.query(
    `select t.* from trades t join leagues l on l.id = t.league_id
      where l.sleeper_league_id = any($1::text[]) and t.status = 'complete'`,
    [ctx.chainIds || []]);
  if (trades.length < 2) return null;

  const superflex = Boolean(ctx.valueVariant?.superflex);
  const book = await dv.loadValueBook({
    dates: [...trades.map(t => t.status_updated_at), null], superflex });
  if (!book) return null;

  const slotMap = await sleeper.draftSlots(ctx.draftSchedule?.draftId).catch(() => null);
  const out = await dv.tradeLedger({
    trades, book, slots: slotMap ? dv.slotsFromDraft(slotMap) : new Map(),
    teams: ctx.draftSchedule?.teams || 12, slotSeason: ctx.draftSchedule?.season,
    nameOf: nameFor,
  });
  if (!out.rows.length) return null;

  const n = Math.min(top, Math.max(1, Math.floor(out.rows.length / 3)));
  const best = out.rows.slice(0, n);
  const worst = out.rows.slice(-n).reverse();
  const middle = out.rows.length - 2 * n;

  /*
   * IN PICKS, WITH A LETTER. A raw market total is a number off a value sheet
   * and means nothing to anybody reading a group chat; "up about an early 1st"
   * is a thing people trade in and argue about. The numbers stay out of the
   * broadcast entirely — anyone who wants them can ask, and the ledger lookup
   * still has them.
   */
  const { rows: pickRows } = await db.query(
    `select name, value from player_values
      where position = 'PICK' and superflex = $1
        and captured_on = (select max(captured_on) from player_values)`, [superflex]);
  const ladder = dv.pickLadder(pickRows);
  const say = (r, i, list) => {
    const rank = out.rows.indexOf(r) + 1;
    const g = dv.traderGrade(rank, out.rows.length);
    const dir = r.now >= 0 ? 'up' : 'down';
    return `  ${r.name} ${g.grade}, ${dir} ${dv.inPicks(r.now, ladder) || r.now}`;
  };

  const lines = [];
  lines.push(`Trade ledger, ${out.coverage.bothPriced} of ${out.coverage.total} trades valued.`);
  lines.push('Up:');
  for (const r of best) lines.push(say(r));
  lines.push('Down:');
  for (const r of worst) lines.push(say(r));
  if (middle > 0) lines.push(`${middle} others in the middle, ask me for a name.`);

  return { text: lines.join('\n'), basis: 'market', ledger: out };
}

/**
 * Send the ledger to every active league, once per phase per season.
 *
 * MARKED BEFORE THE SEND IS TRUSTED, but only AFTER it succeeds — the same
 * lesson the introduction path already paid for. Stamping first marks a league
 * told on a message that never arrived and it is never told again; stamping
 * only on success means the worst case is a retry tomorrow, which for a message
 * about a season-long ledger is no cost at all.
 */
async function run(provider, { dryRun = false, force = null } = {}) {
  const sleeper = require('./sleeper');
  const state = await sleeper.state().catch(() => null);
  const phase = force || phaseFor(state);
  const detail = { phase, season: state?.season || null, sent: [], skipped: [] };
  if (!phase) { detail.skipped.push('not a sending week'); return detail; }

  const leagues = await db.activeLeagues();
  for (const lg of leagues) {
    const season = String(state?.season || new Date().getFullYear());
    if (await alreadySent(lg.id, season, phase)) {
      detail.skipped.push({ league: lg.name, why: 'already sent this phase' });
      continue;
    }
    let msg;
    try {
      msg = await build(lg);
    } catch (err) {
      detail.skipped.push({ league: lg.name, why: `build failed: ${err.message}` });
      continue;
    }
    // A league with nothing to say is not an error and must not be marked, or
    // it would stay silent through the phase in which it finally trades.
    if (!msg) { detail.skipped.push({ league: lg.name, why: 'nothing to report' }); continue; }

    const opener = phase === 'start'
      ? 'Season is here. Who won the offseason:'
      : 'Season done. How the trades actually turned out:';
    const text = `${opener}\n${msg.text}`;

    if (dryRun) { detail.sent.push({ league: lg.name, dryRun: true, text }); continue; }
    try {
      await provider.send(lg.chat_id, text, { leagueId: lg.id });
      await markSent(lg.id, season, phase, { at: new Date().toISOString() });
      detail.sent.push({ league: lg.name });
    } catch (err) {
      detail.skipped.push({ league: lg.name, why: `send failed: ${err.message}` });
    }
  }
  return detail;
}

module.exports = { build, run, phaseFor, alreadySent, markSent, flagKey };
