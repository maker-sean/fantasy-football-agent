/**
 * Every season this league has ever played.
 *
 * The reply context carried ONE snapshot of the current season plus ONE
 * archived season, both `limit 1`. That is enough to answer "who is winning"
 * and nothing else — and "who is winning" is the least interesting thing a
 * league group chat asks. The material that lands is the long memory: who has
 * never won, who folds in November every single year, who has finished last
 * twice.
 *
 * Sleeper keeps it all. Each league row carries previous_league_id, so the
 * chain walks back season by season — this one goes to 2020.
 *
 * WHY A SUMMARY AND NOT MORE CONTEXT. The obvious move is to raise the limit
 * and hand the model six seasons of tables. That does not fit, and it would not
 * help if it did: a model given 1,200 rows of weekly scores writes worse jokes
 * than one given "Marcus: 6 seasons, 41-61, never made a final". Facts per
 * MANAGER, computed once, is both smaller and better material.
 *
 * The join across seasons is sleeper_user_id. Team names change every year and
 * half of them are jokes; the account does not.
 */

const db = require('./db');
const sleeper = require('./sleeper');

/** Walk previous_league_id back to the beginning. Newest first. */
async function chain(sleeperLeagueId, { max = 20 } = {}) {
  const out = [];
  let id = sleeperLeagueId;
  while (id && out.length < max) {
    const lg = await sleeper.league(id).catch(() => null);
    if (!lg) break;
    out.push(lg);
    id = lg.previous_league_id;
  }
  return out;
}

/**
 * The archive row for one past season.
 *
 * provider='archive', no chat_id, active=false — the same shape
 * scripts/backfill.js uses, so a historical season can never become a target
 * for outbound messages. That is not tidiness: leagues are iterated by the
 * worker, and a season from 2021 receiving a recap would be memorable for the
 * wrong reasons.
 */
async function archiveLeague(lg) {
  const { rows: existing } = await db.query(
    'select * from leagues where sleeper_league_id = $1 and chat_id is null limit 1',
    [lg.league_id]
  );
  if (existing[0]) return existing[0];
  const { rows } = await db.query(
    `insert into leagues (name, sleeper_league_id, provider, chat_id, active, season)
     values ($1, $2, 'archive', null, false, $3) returning *`,
    [`${lg.name} ${lg.season}`, lg.league_id, lg.season]
  );
  return rows[0];
}

/**
 * Capture one completed season.
 *
 * The FINAL week only. Every week would be 17 times the calls and rows to
 * answer questions nobody asks — a roster's cumulative wins and points already
 * sit in its settings at the end of the year, so the last week carries the
 * whole season's record. Weekly detail is a separate feature if head-to-head
 * ever becomes worth it.
 */
async function captureSeason(lg, { week = 17 } = {}) {
  const league = await archiveLeague(lg);
  const payload = await sleeper.weekSnapshot(lg.league_id, week);

  // Who actually won it. Sleeper knows, and "you have never won this" is worth
  // more than any number in a standings table.
  let champion = null;
  try {
    const bracket = await sleeper.get(`/league/${lg.league_id}/winners_bracket`);
    const final = (bracket || []).filter(m => m.w).sort((a, b) => (b.r || 0) - (a.r || 0))[0];
    if (final?.w) champion = final.w;            // roster_id
  } catch { /* older seasons may not expose one */ }

  await db.recordSnapshot({
    leagueId: league.id,
    season: lg.season,
    week,
    kind: 'final',
    payload: { ...payload, champion_roster_id: champion },
  });
  return { league, season: lg.season, champion };
}

/**
 * Career facts per manager, across every archived season of this league line.
 *
 * Returns one compact row per Sleeper account. Deliberately small: this goes
 * into a prompt on every reply, so it has to earn its tokens.
 */
async function career(sleeperLeagueId) {
  const seasons = await chain(sleeperLeagueId);
  const ids = seasons.map(s => s.league_id);
  if (!ids.length) return [];

  const { rows } = await db.query(
    `select s.season, s.payload
       from snapshots s
       join leagues l on l.id = s.league_id
      where l.sleeper_league_id = any($1::text[]) and s.kind = 'final'
      order by s.season asc`,
    [ids]
  );
  if (!rows.length) return [];

  const byUser = new Map();
  for (const { season, payload } of rows) {
    const users = new Map((payload.users || []).map(u => [u.user_id, u]));
    const standings = (payload.rosters || [])
      .map(r => ({
        userId: r.owner_id,
        wins: r.settings?.wins ?? 0,
        losses: r.settings?.losses ?? 0,
        ties: r.settings?.ties ?? 0,
        points: Number(r.settings?.fpts ?? 0) + Number(r.settings?.fpts_decimal ?? 0) / 100,
        rosterId: r.roster_id,
      }))
      // Sleeper's own tiebreak: record first, then points scored.
      .sort((a, b) => (b.wins - a.wins) || (b.points - a.points));

    standings.forEach((s, i) => {
      if (!s.userId) return;
      const u = byUser.get(s.userId) || {
        userId: s.userId,
        name: users.get(s.userId)?.display_name || null,
        seasons: 0, wins: 0, losses: 0, ties: 0, points: 0,
        best: null, worst: null, titles: 0, lasts: 0, finishes: [],
      };
      u.name = users.get(s.userId)?.display_name || u.name;
      u.seasons += 1;
      u.wins += s.wins; u.losses += s.losses; u.ties += s.ties;
      u.points += s.points;
      const place = i + 1;
      u.finishes.push({ season, place });
      if (u.best === null || place < u.best) u.best = place;
      if (u.worst === null || place > u.worst) u.worst = place;
      if (place === standings.length) u.lasts += 1;
      if (payload.champion_roster_id && payload.champion_roster_id === s.rosterId) u.titles += 1;
      byUser.set(s.userId, u);
    });
  }

  return [...byUser.values()]
    .map(u => ({ ...u, points: Math.round(u.points) }))
    .sort((a, b) => (b.wins / Math.max(1, b.wins + b.losses)) - (a.wins / Math.max(1, a.wins + a.losses)));
}

/**
 * One line per manager, for the prompt. Short on purpose.
 *
 * `names` maps sleeper_user_id to the person's real name, and passing it is not
 * optional in practice. KNOWN PEOPLE is keyed on display names and this block
 * is keyed on Sleeper usernames, so without the join the model cannot tell that
 * Sean is smeadows — and it does not guess, because PERSONA forbids it. Asked "is
 * Sean any good" it correctly answered that it had nothing to judge, while the
 * answer sat four lines below in a block it could not connect.
 *
 * Both labels are printed. Somebody may ask about "Sean" or about "smeadows", and
 * the model should not have to pick.
 */
function careerBlock(rows, names = new Map()) {
  if (!rows.length) return '';
  const span = rows.reduce((n, r) => Math.max(n, r.seasons), 0);
  const L = [`CAREER (${span} season${span === 1 ? '' : 's'} of league history — use for colour, not for current standings):`];
  for (const r of rows) {
    const bits = [`${r.wins}-${r.losses}${r.ties ? '-' + r.ties : ''} over ${r.seasons} seasons`];
    bits.push(r.titles ? `${r.titles} title${r.titles === 1 ? '' : 's'}` : 'no titles');
    /*
     * "no titles, best finish 1st" reads as a contradiction and is not one:
     * the finish is REGULAR SEASON rank, the title is the playoff bracket.
     * Topping the table for a year and still never winning the thing is one of
     * the better facts in here — but only if it is unmistakable which is which.
     */
    bits.push(`best regular season ${ordinal(r.best)}`);
    if (r.lasts) bits.push(`finished last ${r.lasts === 1 ? 'once' : r.lasts + ' times'}`);
    const known = names.get(r.userId);
    const who = known && r.name && known !== r.name ? `${known} (${r.name})`
              : known || r.name || r.userId;
    L.push(`  ${who} = ${bits.join(', ')}`);
  }
  return L.join('\n');
}

const ordinal = n => {
  if (n == null) return 'unknown';
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

module.exports = { chain, archiveLeague, captureSeason, career, careerBlock, ordinal };
