/**
 * Snapshot capture — the only Phase 1 artifact that cannot be backfilled.
 *
 * Sleeper serves CURRENT state. Once Sunday's games start, the pre-kickoff
 * starting lineup is gone: you can no longer tell who benched a 30-point week
 * or started a player on bye. That is most of the roast material, and it has a
 * hard deadline of the first kickoff of the season.
 *
 * Everything here is therefore written to fail loudly and never overwrite.
 */

const db = require('./db');
const sleeper = require('./sleeper');
const fanout = require('./fanout');

/** Only capture during the real season — preseason snapshots are noise. */
function isRegularSeason(state) {
  return String(state?.season_type || '').toLowerCase() === 'regular';
}

/**
 * Capture one snapshot kind for every active league.
 * `force` bypasses the regular-season gate for testing.
 */
async function captureAll(kind, { force = false } = {}) {
  const jobId = await db.startJob(`snapshot:${kind}`);
  const detail = { kind, leagues: [], skipped: null };

  try {
    const state = await sleeper.state();
    detail.state = {
      season: state.season, week: state.week, season_type: state.season_type,
    };

    if (!isRegularSeason(state) && !force) {
      detail.skipped = `season_type=${state.season_type} (not regular)`;
      await db.finishJob(jobId, 'skipped', detail);
      console.log(`[snapshot:${kind}] skipped — ${detail.skipped}`);
      return detail;
    }

    const leagues = await db.activeLeagues();
    if (!leagues.length) {
      detail.skipped = 'no active leagues with a sleeper_league_id';
      await db.finishJob(jobId, 'skipped', detail);
      console.warn(`[snapshot:${kind}] ${detail.skipped}`);
      return detail;
    }

    const week = state.week;

    // Concurrent, but NOT staggered. Captures are deadline work: the whole
    // value of a lock snapshot is that it happens before kickoff, and a league
    // delayed ten minutes for politeness records a lineup that has already
    // locked. Spreading belongs on sends, which have slack; this does not.
    const results = await fanout.mapLimit(leagues, async lg => {
      const payload = await sleeper.weekSnapshot(lg.sleeper_league_id, week);
      const row = await db.recordSnapshot({
        leagueId: lg.id, season: state.season, week, kind, payload,
      });
      return { row };
    });

    results.forEach((r, i) => {
      const lg = leagues[i];
      const entry = { league: lg.name, league_id: lg.id, week };
      if (r.ok) {
        entry.result = r.value.row ? 'captured' : 'already existed (preserved)';
        entry.snapshot_id = r.value.row?.id ?? null;
        console.log(`[snapshot:${kind}] ${lg.name} week ${week}: ${entry.result}`);
      } else {
        entry.result = 'ERROR';
        entry.error = r.error.message;
        console.error(`[snapshot:${kind}] ${lg.name} FAILED:`, r.error.message);
      }
      detail.leagues.push(entry);
    });

    const failed = detail.leagues.filter(l => l.result === 'ERROR');
    await db.finishJob(jobId, failed.length ? 'error' : 'ok', detail);
    return detail;
  } catch (err) {
    detail.error = err.message;
    await db.finishJob(jobId, 'error', detail);
    console.error(`[snapshot:${kind}] job failed:`, err.message);
    throw err;
  }
}

/** Daily: refresh the slimmed player table. Sleeper asks for once/day max. */
async function refreshPlayers() {
  const jobId = await db.startJob('players:refresh');
  try {
    const players = await sleeper.allPlayers();
    const n = await db.upsertPlayers(players);
    await db.finishJob(jobId, 'ok', { count: n });
    console.log(`[players] refreshed ${n}`);
    return n;
  } catch (err) {
    await db.finishJob(jobId, 'error', { error: err.message });
    console.error('[players] refresh failed:', err.message);
    throw err;
  }
}

/** Daily: reconcile Sleeper rosters onto member records. */
async function syncMembers() {
  const jobId = await db.startJob('members:sync');
  const detail = { leagues: [] };
  try {
    // Hoisted out of the loop. This was fetching the identical NFL state once
    // per league — a value that cannot change during a single run — which at a
    // hundred leagues is ninety-nine wasted calls to Sleeper for nothing.
    const { week } = await sleeper.state();
    const leagues = await db.activeLeagues();

    const results = await fanout.mapLimit(leagues, async lg => {
      const payload = await sleeper.weekSnapshot(lg.sleeper_league_id, week);
      const owners = sleeper.rosterOwners(payload);
      for (const o of owners) {
        // Phone stays null until a human is matched to a roster — the roster
        // is Sleeper's identity, the phone is the transport's, and only a
        // person can bridge them.
        await db.upsertMember(lg.id, o);
      }
      return owners.length;
    });

    results.forEach((r, i) => detail.leagues.push(r.ok
      ? { league: leagues[i].name, owners: r.value }
      : { league: leagues[i].name, result: 'ERROR', error: r.error.message }));

    const failed = detail.leagues.filter(l => l.result === 'ERROR');
    await db.finishJob(jobId, failed.length ? 'error' : 'ok', detail);
    return detail;
  } catch (err) {
    detail.error = err.message;
    await db.finishJob(jobId, 'error', detail);
    throw err;
  }
}

module.exports = { captureAll, refreshPlayers, syncMembers, isRegularSeason };
