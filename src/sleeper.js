/**
 * Sleeper read-only client.
 *
 * Public API, no auth, no key. Verified live: GET /v1/state/nfl returns
 * { week, leg, season, season_type, display_week, season_start_date, ... }.
 *
 * The one hard rule from Sleeper's own docs: /v1/players/nfl is ~15 MB and
 * must not be called more than once per day. Everything else is cheap.
 */

const BASE = 'https://api.sleeper.app/v1';

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'accept': 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`Sleeper GET ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** { week, season, season_type: 'pre'|'regular'|'post', display_week, ... } */
const state = () => get('/state/nfl');

const league = id => get(`/league/${encodeURIComponent(id)}`);
const rosters = id => get(`/league/${encodeURIComponent(id)}/rosters`);
const users = id => get(`/league/${encodeURIComponent(id)}/users`);
const matchups = (id, week) => get(`/league/${encodeURIComponent(id)}/matchups/${Number(week)}`);
const transactions = (id, week) => get(`/league/${encodeURIComponent(id)}/transactions/${Number(week)}`);

/** ~15 MB. Daily at most. Slimmed before it ever touches the database. */
async function allPlayers() {
  const raw = await get('/players/nfl');
  const out = [];
  for (const [id, p] of Object.entries(raw)) {
    if (!p) continue;
    const name = p.full_name
      || [p.first_name, p.last_name].filter(Boolean).join(' ')
      || null;
    out.push({
      player_id: id,
      full_name: name,
      position: p.position || null,
      team: p.team || null,
      // Injury fields drive the pre-kickoff alert. They were trimmed out of the
      // original slim, which is why nothing could warn about an inactive
      // starter until now.
      injury_status: p.injury_status || null,
      injury_body_part: p.injury_body_part || null,
      player_status: p.status || null,
    });
  }
  return out;
}

/**
 * Everything needed to reconstruct "who started whom, and what happened" for
 * one week. This object IS the snapshot payload — if it isn't captured at
 * kickoff, the starting lineup is unrecoverable afterward.
 */
async function weekSnapshot(leagueId, week) {
  const [lg, rs, us, mu] = await Promise.all([
    league(leagueId),
    rosters(leagueId),
    users(leagueId),
    matchups(leagueId, week),
  ]);

  // Transactions are nice-to-have; a 404 on an unplayed week must not sink
  // the capture we actually care about.
  let tx = [];
  try {
    tx = await transactions(leagueId, week);
  } catch (err) {
    tx = [];
  }

  return {
    captured_at: new Date().toISOString(),
    league: {
      league_id: lg.league_id,
      name: lg.name,
      season: lg.season,
      status: lg.status,
      total_rosters: lg.total_rosters,
      scoring_settings: lg.scoring_settings,
      roster_positions: lg.roster_positions,
      // waiver_type lives in here, and nothing else does today. Captured so a
      // league's waiver format is recoverable from the snapshot rather than
      // requiring a live call months later. Snapshots taken before this exist
      // without it, which is why the recap gates waiver drama on the bids
      // themselves and not on this field.
      settings: lg.settings,
    },
    week: Number(week),
    rosters: rs,
    users: us,
    matchups: mu,
    transactions: tx,
  };
}

/** Maps Sleeper users/rosters onto our member records. */
function rosterOwners(snapshotPayload) {
  const byUser = new Map((snapshotPayload.users || []).map(u => [u.user_id, u]));
  return (snapshotPayload.rosters || []).map(r => {
    const u = byUser.get(r.owner_id);
    return {
      sleeperUserId: r.owner_id,
      sleeperRosterId: r.roster_id,
      displayName: u?.metadata?.team_name || u?.display_name || u?.username || null,
    };
  });
}

module.exports = {
  BASE, get, state, league, rosters, users, matchups, transactions,
  allPlayers, weekSnapshot, rosterOwners,
};
