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

    for (const lg of leagues) {
      const entry = { league: lg.name, league_id: lg.id, week };
      try {
        const payload = await sleeper.weekSnapshot(lg.sleeper_league_id, week);
        const row = await db.recordSnapshot({
          leagueId: lg.id,
          season: state.season,
          week,
          kind,
          payload,
        });
        entry.result = row ? 'captured' : 'already existed (preserved)';
        entry.snapshot_id = row?.id ?? null;
        console.log(`[snapshot:${kind}] ${lg.name} week ${week}: ${entry.result}`);
      } catch (err) {
        entry.result = 'ERROR';
        entry.error = err.message;
        console.error(`[snapshot:${kind}] ${lg.name} FAILED:`, err.message);
      }
      detail.leagues.push(entry);
    }

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
    for (const lg of await db.activeLeagues()) {
      const payload = await sleeper.weekSnapshot(lg.sleeper_league_id, (await sleeper.state()).week);
      const owners = sleeper.rosterOwners(payload);
      for (const o of owners) {
        // Phone stays null until a human is matched to a roster — the roster
        // is Sleeper's identity, the phone is the transport's, and only a
        // person can bridge them.
        await db.upsertMember(lg.id, o);
      }
      detail.leagues.push({ league: lg.name, owners: owners.length });
    }
    await db.finishJob(jobId, 'ok', detail);
    return detail;
  } catch (err) {
    detail.error = err.message;
    await db.finishJob(jobId, 'error', detail);
    throw err;
  }
}

module.exports = { captureAll, refreshPlayers, syncMembers, isRegularSeason };
