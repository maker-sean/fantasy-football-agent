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
      // The detail behind the status. "Questionable" and "Questionable,
      // expected to play" are different answers to the only question asked.
      injury_notes: p.injury_notes || null,
      // Depth chart, which is what separates the backup from a backup. Without
      // it the handcuff check could only say two men share a team and a
      // position, which is true of four Raiders running backs.
      depth_chart_order: Number.isFinite(p.depth_chart_order) ? p.depth_chart_order : null,
      depth_chart_position: p.depth_chart_position || null,
    });
  }
  return out;
}

/**
 * The UPCOMING draft: when it is, how it runs, and whether an order exists.
 *
 * "When is our draft" is the most common question a league asks in August and
 * the bot had no answer, because everything about drafts in here was built for
 * archived seasons and reads picks that do not exist yet. Sleeper has known the
 * answer the whole time: /league/{id}/drafts carries start_time, the format,
 * and the draft_order, on a league sitting in pre_draft.
 *
 * draft_order being empty is itself worth reporting rather than hiding. A
 * league a week out with no order set is exactly the league arguing about how
 * to pick one, which is what yours was doing when it asked.
 *
 * Short TTL because this is the live season, not the archive: a commissioner
 * moving the date is the whole reason somebody asks again.
 */
const SCHEDULE_TTL_MS = Number(process.env.DRAFT_SCHEDULE_TTL_MS || 10 * 60 * 1000);
const scheduleCache = new Map();

/*
 * The slot map on its own, cached for the life of the process.
 *
 * Which roster drafts from which slot is what turns "a 2026 2nd" into "the
 * eighteenth pick", and therefore into a price. It is NOT on the drafts list,
 * only on the draft detail, which is why the schedule carries it as null.
 *
 * Immutable once the order is drawn, so this caches hard rather than for a few
 * minutes: a trade priced twice in one conversation must not cost two calls to
 * an API this project is trying to stay a polite user of.
 */
const slotMapCache = new Map();

/*
 * A league's own settings — scoring, roster slots, playoffs, waivers.
 *
 * Cached for an hour rather than the process, because a commissioner can change
 * scoring mid-season and answering with yesterday's rules is worse than a
 * second call. Nothing else here needs it: it exists for the one question a
 * league asks about itself, which is why it is a lookup and not context.
 */
const settingsCache = new Map();
const SETTINGS_TTL = 60 * 60 * 1000;

async function leagueSettings(leagueId) {
  if (!leagueId) return null;
  const hit = settingsCache.get(leagueId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL) return hit.value;
  const d = await get(`/league/${encodeURIComponent(leagueId)}`).catch(() => null);
  if (d) settingsCache.set(leagueId, { at: Date.now(), value: d });
  return d;
}

async function draftSlots(draftId) {
  if (!draftId) return null;
  if (slotMapCache.has(draftId)) return slotMapCache.get(draftId);
  const d = await get(`/draft/${encodeURIComponent(draftId)}`).catch(() => null);
  const map = d?.slot_to_roster_id || null;
  // Only a real answer is cached. Caching a failure would make one bad minute
  // permanent for as long as the worker runs.
  if (map) slotMapCache.set(draftId, map);
  return map;
}

async function draftSchedule(leagueId) {
  const hit = scheduleCache.get(leagueId);
  if (hit && Date.now() - hit.at < SCHEDULE_TTL_MS) return hit.value;

  const drafts = await get(`/league/${encodeURIComponent(leagueId)}/drafts`).catch(() => null);
  const d = (drafts || [])[0];
  if (!d) return null;

  const value = {
    status: d.status || null,                 // pre_draft | drafting | complete
    type: d.type || null,                     // snake | auction | linear
    season: d.season || null,
    rounds: d.settings?.rounds ?? null,
    teams: d.settings?.teams ?? null,
    pickSeconds: d.settings?.pick_timer ?? null,
    // Milliseconds since epoch, or null when the commissioner has not set one.
    startsAt: d.start_time || null,
    // The clock only means something while status is 'drafting'.
    lastPickedAt: d.last_picked || null,
    draftId: d.draft_id || null,
    slotToRoster: d.slot_to_roster_id || null,
    // An order exists only once it has been generated. Empty is a real state.
    orderSet: Boolean(d.draft_order && Object.keys(d.draft_order).length),
    scoring: d.metadata?.scoring_type || null,
  };
  scheduleCache.set(leagueId, { at: Date.now(), value });
  return value;
}

/**
 * Who is on the clock, during a live draft.
 *
 * A 24-hour pick timer means a "draft night" can run for weeks — Sigma Chi
 * Dynasty started theirs on 19 August and was on pick 20 of 48 six days later.
 * For that whole stretch the interesting fact is not the start date, it is
 * whose turn it is and how long they have been sitting on it.
 *
 * Only called while status is 'drafting', so a league between drafts pays
 * nothing for this.
 *
 * SNAKE AND LINEAR PICK DIFFERENT PEOPLE and getting it wrong names the wrong
 * manager in a group chat that can see the draft board. Linear repeats the same
 * order every round; snake reverses on even rounds. Auction has no clock of
 * this shape at all, so it returns null rather than inventing one.
 */
async function draftClock(schedule) {
  if (!schedule?.draftId || schedule.status !== 'drafting') return null;
  if (schedule.type === 'auction') return null;

  const teams = Number(schedule.teams) || 0;
  const rounds = Number(schedule.rounds) || 0;
  if (!teams) return null;

  /*
   * The slot map is NOT on the drafts list, only on the draft detail — so the
   * league-level call that gives us status and rounds cannot name a manager.
   * Both are fetched here, in parallel, and only while a draft is live.
   */
  /*
   * TRADED PICKS ARE THE POINT, not a footnote.
   *
   * slot_to_roster_id names who OWNED the slot when the order was drawn. In a
   * dynasty league picks are currency: this draft has fourteen of them traded,
   * and the very pick on the clock had moved from Sean M. to Renshaw. Naming
   * the original owner is naming the wrong person to a group chat that is
   * looking at the draft board — the exact failure this function claimed to
   * guard against and did not.
   */
  const [picks, detail, traded] = await Promise.all([
    get(`/draft/${encodeURIComponent(schedule.draftId)}/picks`).catch(() => null),
    schedule.slotToRoster
      ? Promise.resolve({ slot_to_roster_id: schedule.slotToRoster })
      : get(`/draft/${encodeURIComponent(schedule.draftId)}`).catch(() => null),
    get(`/draft/${encodeURIComponent(schedule.draftId)}/traded_picks`).catch(() => null),
  ]);
  if (!Array.isArray(picks)) return null;
  const slotToRoster = detail?.slot_to_roster_id || schedule.slotToRoster || {};

  /*
   * Keyed season-round-originalRoster. Sleeper collapses a multi-hop trade to
   * the FINAL owner_id, so one lookup is enough and previous_owner_id is only
   * ever colour.
   */
  const tradedTo = new Map(
    (Array.isArray(traded) ? traded : []).map(t =>
      [`${t.season}-${t.round}-${t.roster_id}`, t.owner_id])
  );

  const made = picks.length;
  const total = teams * rounds;
  if (rounds && made >= total) return { made, total, done: true };

  const overall = made + 1;
  const round = Math.floor((made) / teams) + 1;
  const indexInRound = made % teams;                 // 0-based
  const slot = schedule.type === 'snake' && round % 2 === 0
    ? teams - indexInRound
    : indexInRound + 1;

  /*
   * The last pick carries its own roster_id, which is the roster that ACTUALLY
   * made it — trades already resolved by Sleeper. No slot arithmetic needed and
   * none should be attempted: slot 8 made pick 20 and the roster was 3, not the
   * 4 the slot map names.
   */
  const last = picks[made - 1];
  const originalRosterId = slotToRoster[slot] ?? null;
  const owner = originalRosterId == null ? null
    : tradedTo.get(`${schedule.season}-${round}-${originalRosterId}`) ?? originalRosterId;

  return {
    made, total, round, slot, overall,
    rosterId: owner,
    // Kept so the block can say "on Sean M.'s original pick", which is the part
    // a dynasty league actually enjoys.
    originalRosterId,
    wasTraded: owner != null && originalRosterId != null && Number(owner) !== Number(originalRosterId),
    lastPlayer: last?.metadata
      ? [last.metadata.first_name, last.metadata.last_name].filter(Boolean).join(' ')
        + (last.metadata.position ? ` (${last.metadata.position})` : '')
      : null,
    lastPick: last ? {
      playerId: last.player_id ? String(last.player_id) : null,
      name: [last.metadata?.first_name, last.metadata?.last_name].filter(Boolean).join(' ') || null,
      position: last.metadata?.position || null,
      rosterId: last.roster_id ?? null,
      pickNo: last.pick_no ?? null,
      round: last.round ?? null,
      isKeeper: Boolean(last.is_keeper),
    } : null,
    onClockSinceMs: schedule.lastPickedAt ? Date.now() - Number(schedule.lastPickedAt) : null,
  };
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

/**
 * Season-long projections, ranked within position.
 *
 * The weekly call below answers "who should I start". This answers a different
 * question — "what is this roster short of" — which is the one a league asks
 * while a draft is running, and it is the input that lets the bot have an
 * OPINION rather than recite a record.
 *
 * The rank is computed HERE. A model handed three thousand rows and asked where
 * somebody's best running back sits will produce a number that looks right and
 * is not; this codebase has paid for that lesson enough times. Position rank is
 * arithmetic and belongs in arithmetic.
 *
 * Cached for an hour. These move when news breaks, not by the minute, and a
 * live draft asks for them repeatedly.
 */
const SEASON_PROJ_TTL_MS = Number(process.env.SEASON_PROJECTIONS_TTL_MS || 60 * 60 * 1000);
const seasonProjCache = new Map();

async function seasonProjections(season) {
  const hit = seasonProjCache.get(String(season));
  if (hit && Date.now() - hit.at < SEASON_PROJ_TTL_MS) return hit.byPlayer;

  const pos = ['QB', 'RB', 'WR', 'TE'].map(p => `position[]=${p}`).join('&');
  const url = `https://api.sleeper.app/projections/nfl/${season}`
            + `?season_type=regular&${pos}&order_by=pts_ppr`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`Sleeper season projections ${season} -> ${res.status}`);
    require('./errorlog').record({
      system: 'sleeper', operation: 'season-projections', status: res.status, message: err.message,
    });
    throw err;
  }

  const rows = [];
  for (const row of await res.json()) {
    const pts = row?.stats?.pts_ppr;
    const position = row?.player?.position;
    if (!row.player_id || pts == null || !position) continue;
    rows.push({
      playerId: String(row.player_id),
      name: [row.player.first_name, row.player.last_name].filter(Boolean).join(' '),
      position,
      team: row.team || null,
      points: Math.round(Number(pts) * 10) / 10,
    });
  }

  // Rank within position, best first. Ties share the lower rank rather than
  // silently ordering by whatever the API happened to return first.
  const byPosition = new Map();
  for (const r of rows) {
    if (!byPosition.has(r.position)) byPosition.set(r.position, []);
    byPosition.get(r.position).push(r);
  }
  const byPlayer = new Map();
  for (const [, list] of byPosition) {
    list.sort((a, b) => b.points - a.points);
    let rank = 0, lastPts = null, seen = 0;
    for (const r of list) {
      seen++;
      if (r.points !== lastPts) { rank = seen; lastPts = r.points; }
      byPlayer.set(r.playerId, { ...r, posRank: rank });
    }
  }

  seasonProjCache.set(String(season), { at: Date.now(), byPlayer });
  return byPlayer;
}

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
  draftSlots,
  leagueSettings,
  projections, seasonProjections, seasonStats, draftSchedule, draftClock,
  BASE, get, state, league, rosters, users, matchups, transactions,
  allPlayers, weekSnapshot, rosterOwners, draft,
};
