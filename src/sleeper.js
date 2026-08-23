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

/*
 * Sleeper's projections. Undocumented, live, and NOT under /v1 — so this cannot
 * go through get(), which prepends the versioned base.
 *
 * Cached in process for half an hour. The full slate is 3,297 rows and two
 * megabytes; fetching that per question would be absurd, and the numbers move
 * a few times a week rather than a few times a minute. A long-lived worker
 * pays for it once.
 */
const PROJ_TTL_MS = Number(process.env.PROJECTIONS_TTL_MS || 30 * 60 * 1000);
const projCache = new Map();

async function projections(season, week) {
  const key = `${season}:${week}`;
  const hit = projCache.get(key);
  if (hit && Date.now() - hit.at < PROJ_TTL_MS) return hit.byPlayer;

  const pos = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(p => `position[]=${p}`).join('&');
  const url = `https://api.sleeper.app/projections/nfl/${season}/${week}`
            + `?season_type=regular&${pos}&order_by=pts_ppr`;

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`Sleeper projections ${season}/${week} -> ${res.status}`);
    err.status = res.status;
    require('./errorlog').record({
      system: 'sleeper', operation: 'projections', status: res.status, message: err.message,
    });
    throw err;
  }

  const byPlayer = new Map();
  for (const row of await res.json()) {
    const pts = row?.stats?.pts_ppr;
    if (!row.player_id || pts == null) continue;
    byPlayer.set(String(row.player_id), {
      name: [row.player?.first_name, row.player?.last_name].filter(Boolean).join(' '),
      position: row.player?.position || null,
      team: row.team || null,
      opponent: row.opponent || null,
      points: Math.round(pts * 10) / 10,
    });
  }
  projCache.set(key, { at: Date.now(), byPlayer });
  return byPlayer;
}


/*
 * Season-long actual stats, by position. Same undocumented host as projections,
 * so it also cannot go through get().
 *
 * The field that matters here is pos_rank_half_ppr, which is Sleeper's own
 * end-of-season positional finish — "ended WR5". Computing that ourselves from
 * raw stat lines would mean reimplementing a scoring engine to arrive at a
 * number Sleeper already publishes.
 *
 * WHY HALF PPR IS A PARAMETER AND NOT A CONSTANT. It is the right default for
 * a league scoring rec = 0.5, and wrong for the other two. The caller knows
 * the league's scoring settings; this does not.
 *
 * CACHING. A finished season is immutable, so its entry never expires — six
 * seasons of history are fetched once per process and then free. Only the
 * current season gets a TTL, because its ranks move every Sunday. Passing
 * `live` is how a caller says "this one is still being played".
 */
const STATS_TTL_MS = Number(process.env.SEASON_STATS_TTL_MS || 6 * 60 * 60 * 1000);
const statsCache = new Map();

async function seasonStats(season, { scoring = 'half_ppr', live = false } = {}) {
  const key = `${season}:${scoring}`;
  const hit = statsCache.get(key);
  if (hit && (!hit.live || Date.now() - hit.at < STATS_TTL_MS)) return hit.byPlayer;

  const byPlayer = new Map();
  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    const url = `https://api.sleeper.app/stats/nfl/${season}`
              + `?season_type=regular&position[]=${position}&order_by=pts_ppr`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error(`Sleeper season stats ${season}/${position} -> ${res.status}`);
      err.status = res.status;
      require('./errorlog').record({
        system: 'sleeper', operation: 'seasonStats', status: res.status, message: err.message,
      });
      throw err;
    }
    for (const row of await res.json()) {
      const st = row?.stats || {};
      if (!row.player_id) continue;
      byPlayer.set(String(row.player_id), {
        position,
        // Null for a player who never ranked at the position all year. That is
        // a real state, not a zero, and the callers distinguish them.
        rank: st[`pos_rank_${scoring}`] ?? null,
        points: st[`pts_${scoring}`] ?? 0,
        // The injury column. Everything that separates "wrong" from "hurt"
        // downstream keys on this.
        gamesPlayed: st.gp ?? 0,
        name: [row.player?.first_name, row.player?.last_name].filter(Boolean).join(' ') || null,
      });
    }
  }
  statsCache.set(key, { at: Date.now(), live, byPlayer });
  return byPlayer;
}

module.exports = {
  projections, seasonStats,
  BASE, get, state, league, rosters, users, matchups, transactions,
  allPlayers, weekSnapshot, rosterOwners, draft,
};
