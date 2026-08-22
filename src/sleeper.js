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
    // Recorded at the single funnel every Sleeper call goes through. Many
    // callers catch and continue by design — a missing snapshot is degraded,
    // not broken — which is exactly why the failure has to be written down
    // somewhere before it is swallowed.
    require('./errorlog').record({
      system: 'sleeper', operation: `GET ${path.split('/').slice(0, 3).join('/')}`,
      status: res.status, message: err.message,
    });
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
 * The season's draft, trimmed to what a recap can use.
 *
 * Sleeper returns each pick with metadata and reactions attached, which is a
 * lot of bytes to store in every weekly snapshot to answer one question: who
 * took this player, and how early. Only those three fields are kept.
 *
 * Two calls because the draft id is not the league id. Static for the season,
 * so re-fetching weekly is waste, but it is small waste and it keeps the
 * snapshot self-contained, which is what makes src/stats.js testable without a
 * network.
 */
async function draft(leagueId) {
  const ds = await get(`/league/${leagueId}/drafts`);
  if (!ds?.length) return null;
  const d = ds[0];
  const picks = await get(`/draft/${d.draft_id}/picks`);
  return {
    draft_id: d.draft_id,
    rounds: d.settings?.rounds ?? null,
    picks: (picks || []).map(pk => ({
      player_id: pk.player_id,
      roster_id: Number(pk.roster_id),
      round: pk.round,
    })),
  };
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

  // Same deal: a league with no draft on file, or an endpoint having a bad day,
  // must not sink the capture. src/churn.js degrades to counting drops without
  // it, which is exactly how every snapshot taken before today behaves.
  let dr = null;
  try {
    dr = await draft(leagueId);
  } catch (err) {
    dr = null;
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
    draft: dr,
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
      // Two separate facts, kept separate. Collapsing them into one label is
      // what let the nightly sync overwrite people's real names with their team
      // names — see 0017_member_labels.sql.
      username: u?.display_name || u?.username || null,
      teamName: u?.metadata?.team_name || null,
      // Retained for callers that just want something printable. It is NOT a
      // person's name and must never be written to members.display_name.
      displayName: u?.metadata?.team_name || u?.display_name || u?.username || null,
    };
  });
}

module.exports = {
  BASE, get, state, league, rosters, users, matchups, transactions,
  allPlayers, weekSnapshot, rosterOwners, draft,
};
