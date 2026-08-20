/**
 * Warn a league when someone is starting a player who will not play.
 *
 * This is the first feature where being wrong costs more than staying silent.
 * A recap that misfires is embarrassing; a false injury alert makes someone
 * bench a healthy starter, and a late one is worthless. So it is deliberately
 * narrow: only players who are CERTAIN not to play, only before their own
 * kickoff, and only once per player per week.
 *
 * Timing comes from the real schedule (src/espn.js), never a fixed cron. Week 10
 * of 2025 kicked off at 09:30 ET in Berlin; a Sunday-noon job would have fired
 * three and a half hours too late and told nobody.
 */

const db = require('./db');

/**
 * Statuses where the player is not playing, full stop.
 *
 * "Questionable" is excluded on purpose. Roughly 380 players carry it in a
 * normal week and most of them play — alerting on those trains the league to
 * ignore the bot, which costs more than the handful of catches it would add.
 */
const CERTAIN_OUT = new Set(['Out', 'IR', 'PUP', 'Sus', 'DNR', 'NFI', 'COV']);

/** How far ahead of a kickoff to warn. Long enough to act, close enough to matter. */
const DEFAULT_LEAD_MS = 90 * 60 * 1000;

function isCertainOut(player) {
  if (!player) return false;
  if (player.injury_status && CERTAIN_OUT.has(player.injury_status)) return true;
  // Inactive with any injury flag is also a zero.
  if (player.player_status && /inactive/i.test(player.player_status) && player.injury_status) return true;
  return false;
}

/**
 * Find starters who will score nothing, in games that have not started.
 *
 * @param league   league row
 * @param snapshot latest snapshot payload (rosters + users + starters)
 * @param opts.leadMs  only warn within this window before kickoff
 * @returns [{ rosterId, team, manager, player, game }]
 */
async function findRisks(league, snapshot, opts = {}) {
  const { leadMs = DEFAULT_LEAD_MS, now = Date.now() } = opts;
  const season = String(snapshot.league?.season || '');
  const week = Number(snapshot.week);
  if (!season || !week) return [];

  const { rows: gameRows } = await db.query(
    'select * from games where season = $1 and week = $2',
    [season, week]
  );
  if (!gameRows.length) return [];

  // team -> game
  const byTeam = new Map();
  for (const g of gameRows) { byTeam.set(g.home_team, g); byTeam.set(g.away_team, g); }

  const starterIds = new Set();
  for (const m of snapshot.matchups || []) {
    for (const pid of m.starters || []) if (pid && pid !== '0') starterIds.add(pid);
  }
  if (!starterIds.size) return [];

  const { rows: players } = await db.query(
    `select player_id, full_name, position, team, injury_status, injury_body_part, player_status
     from players where player_id = any($1)`,
    [[...starterIds]]
  );
  const byId = new Map(players.map(p => [p.player_id, p]));

  // Who owns which roster, for naming the manager.
  const byUser = new Map((snapshot.users || []).map(u => [u.user_id, u]));
  const rosterOwner = new Map();
  for (const r of snapshot.rosters || []) {
    const u = byUser.get(r.owner_id);
    rosterOwner.set(r.roster_id, u?.metadata?.team_name || u?.display_name || u?.username || `Roster ${r.roster_id}`);
  }

  const risks = [];
  for (const m of snapshot.matchups || []) {
    for (const pid of m.starters || []) {
      if (!pid || pid === '0') continue;
      const p = byId.get(pid);
      if (!isCertainOut(p)) continue;

      const game = p.team ? byTeam.get(p.team) : null;
      // No game found means a free agent or a bye — either way there is nothing
      // to be before, and warning would be noise.
      if (!game) continue;

      const kickoff = new Date(game.kickoff_at).getTime();
      // Already started: too late to be useful, and saying so is just rubbing it in.
      if (kickoff <= now) continue;
      if (kickoff - now > leadMs) continue;   // too early; we'll catch it on a later tick

      risks.push({
        rosterId: m.roster_id,
        team: rosterOwner.get(m.roster_id) || `Roster ${m.roster_id}`,
        player: p,
        game,
        kickoffAt: new Date(game.kickoff_at),
        minutesToKickoff: Math.round((kickoff - now) / 60000),
      });
    }
  }
  return risks;
}

/** Drop anything already alerted for this league-week. */
async function filterAlreadySent(leagueId, season, week, risks) {
  if (!risks.length) return [];
  const { rows } = await db.query(
    'select player_id from injury_alerts where league_id = $1 and season = $2 and week = $3',
    [leagueId, String(season), Number(week)]
  );
  const sent = new Set(rows.map(r => r.player_id));
  return risks.filter(r => !sent.has(r.player.player_id));
}

async function markSent(leagueId, season, week, risk) {
  const { rows } = await db.query(
    `insert into injury_alerts (league_id, season, week, roster_id, player_id,
                                player_name, injury_status, kickoff_at, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (league_id, season, week, player_id) do nothing
     returning *`,
    [leagueId, String(season), Number(week), risk.rosterId, risk.player.player_id,
     risk.player.full_name, risk.player.injury_status, risk.kickoffAt,
     { team: risk.team, game: risk.game.short_name, bodyPart: risk.player.injury_body_part }]
  );
  return rows[0] || null;   // null means another tick already sent it
}

/**
 * Compose the message. Deliberately plain — this is the utility feature, not
 * the comedy one, and someone may be reading it with minutes to spare.
 */
function composeAlert(risks) {
  if (!risks.length) return null;

  const line = r => {
    const part = r.player.injury_body_part ? ` (${r.player.injury_body_part.toLowerCase()})` : '';
    const when = r.minutesToKickoff < 60
      ? `${r.minutesToKickoff}m`
      : `${Math.round(r.minutesToKickoff / 60)}h`;
    return `${r.player.full_name} is ${r.player.injury_status}${part} and ${r.game.short_name} kicks in ${when}`;
  };

  // A bit of voice, but the facts stay in the first clause. Somebody may be
  // reading this with four minutes to spare and one hand on the app, so the
  // name, the status and the clock come before any of the personality.
  if (risks.length === 1) {
    return `${risks[0].team}, before this costs you: ${line(risks[0])}. `
         + `That is a zero sitting in your lineup right now.`;
  }
  return `Lineup check, and the clock is running:\n`
       + `${risks.map(r => `• ${r.team}: ${line(r)}`).join('\n')}\n\n`
       + `Those are zeros unless somebody moves.`;
}

module.exports = {
  findRisks, filterAlreadySent, markSent, composeAlert,
  isCertainOut, CERTAIN_OUT, DEFAULT_LEAD_MS,
};
