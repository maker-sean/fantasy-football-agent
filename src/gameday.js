/**
 * The game-day tick: refresh the schedule, capture lineups at real kickoffs,
 * and warn about players who will not play.
 *
 * Replaces guessing at slate times. Every action is driven by an actual kickoff
 * from the schedule, so Berlin at 09:30 ET, Thanksgiving, Black Friday and
 * late-season Saturdays all work without a special case.
 *
 * Runs often (every 15 minutes) and does almost nothing most of the time — the
 * cheap path is a single query that finds no kickoff nearby and returns.
 */

const db = require('./db');
const espn = require('./espn');
const sleeper = require('./sleeper');
const snapshots = require('./snapshots');
const injuries = require('./injuries');
const fanout = require('./fanout');

const MIN = 60 * 1000;

/** Pull this week's schedule from ESPN into the games table. */
async function refreshSchedule(state) {
  const s = state || await sleeper.state();
  if (String(s.season_type).toLowerCase() !== 'regular') {
    return { skipped: `season_type=${s.season_type}` };
  }
  const games = await espn.weekGames(s.season, s.week);
  const n = await db.upsertGames(games);
  return { season: s.season, week: s.week, games: n };
}

/**
 * One tick. Safe to run every 15 minutes all season.
 *
 * @param provider  MessagingProvider, for sending alerts
 * @param opts.dryRun  compose and log, send nothing
 */
async function tick(provider, opts = {}) {
  const { dryRun = false, now = Date.now(), leadMs = injuries.DEFAULT_LEAD_MS } = opts;
  const jobId = await db.startJob('gameday:tick');
  const detail = { alerts: [], captures: [] };

  try {
    const state = await sleeper.state();
    detail.state = { season: state.season, week: state.week, type: state.season_type };

    if (String(state.season_type).toLowerCase() !== 'regular') {
      detail.skipped = `season_type=${state.season_type}`;
      await db.finishJob(jobId, 'skipped', detail);
      return detail;
    }

    // Keep the schedule fresh; kickoffs move (flex scheduling) and states change.
    try {
      const sched = await refreshSchedule(state);
      detail.schedule = sched;
    } catch (err) {
      // A schedule failure must not stop the captures below from running.
      console.error('[gameday] schedule refresh failed:', err.message);
      detail.scheduleError = err.message;
    }

    const soon = await db.upcomingGames(state.season, state.week, leadMs);
    detail.upcoming = soon.length;
    if (!soon.length) {
      await db.finishJob(jobId, 'ok', detail);
      return detail;
    }

    const nextKickoff = new Date(soon[0].kickoff_at).getTime();
    const minutesOut = Math.round((nextKickoff - now) / MIN);
    detail.nextKickoff = { game: soon[0].short_name, minutes: minutesOut };

    const leagues = await db.activeLeagues();

    // Concurrent, NOT staggered — the same reason as snapshot captures. An
    // injury alert exists to arrive before kickoff; a league delayed ten
    // minutes for politeness gets warned about a player already inactive in a
    // game already underway, which is worse than saying nothing.
    const results = await fanout.mapLimit(leagues, async league => {
      const entry = { league: league.name };
      try {
        // Capture the lineup just before the first kickoff of this window. One
        // per league-week-kickoff, and insert-only, so repeats are harmless.
        if (minutesOut <= 10) {
          const payload = await sleeper.weekSnapshot(league.sleeper_league_id, state.week);
          const row = await db.recordSnapshot({
            leagueId: league.id, season: state.season, week: state.week,
            kind: `lock_${soon[0].espn_id}`, payload,
          });
          entry.captured = Boolean(row);
          detail.captures.push({ league: league.name, game: soon[0].short_name, new: Boolean(row) });
        }

        // Injury risks for starters whose game is inside the window.
        const { rows: snapRows } = await db.query(
          `select payload from snapshots where league_id = $1 and season = $2 and week = $3
           order by captured_at desc limit 1`,
          [league.id, String(state.season), Number(state.week)]
        );
        if (!snapRows.length) { entry.result = 'no snapshot yet'; return entry; }

        const risks = await injuries.findRisks(league, snapRows[0].payload, { leadMs, now });
        const fresh = await injuries.filterAlreadySent(league.id, state.season, state.week, risks);
        entry.risks = risks.length;
        entry.new = fresh.length;

        if (!fresh.length) { entry.result = risks.length ? 'all already alerted' : 'clean'; return entry; }

        const text = injuries.composeAlert(fresh);
        entry.message = text;

        if (dryRun || !league.chat_id) {
          entry.result = dryRun ? 'dry run' : 'no chat thread';
          console.log(`[gameday] (${entry.result}) ${league.name}:\n${text}`);
        } else {
          await provider.send(league.chat_id, text);
          await db.recordMessage({
            leagueId: league.id, provider: league.provider, providerMessageId: null,
            direction: 'outbound', chatId: league.chat_id, senderPhone: null,
            isGroup: true, protocol: null, body: text,
            raw: { source: 'injury_alert', players: fresh.map(r => r.player.player_id) },
            occurredAt: Date.now(),
          });
          entry.result = 'sent';
        }

        // Mark after sending, so a send failure retries on the next tick.
        if (!dryRun && league.chat_id) {
          for (const r of fresh) await injuries.markSent(league.id, state.season, state.week, r);
        }
      } catch (err) {
        entry.result = 'ERROR';
        entry.error = err.message;
        console.error(`[gameday] ${league.name} failed:`, err.message);
      }
      return entry;
    });
    for (const r of results) {
      detail.alerts.push(r.ok ? r.value : { result: 'ERROR', error: r.error.message });
    }

    const failed = detail.alerts.filter(a => a.result === 'ERROR');
    await db.finishJob(jobId, failed.length ? 'error' : 'ok', detail);
    return detail;
  } catch (err) {
    detail.error = err.message;
    await db.finishJob(jobId, 'error', detail);
    throw err;
  }
}

module.exports = { tick, refreshSchedule };
