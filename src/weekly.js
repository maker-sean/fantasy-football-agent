/**
 * The weekly recap job: generate, verify, queue for approval, notify the owner.
 *
 * Nothing here posts to a league. It writes a draft and texts the owner, who
 * replies SEND or NO from their phone (see src/control.js). A league can opt
 * into direct posting with `autoPost` in its config once it has earned trust —
 * per league, not globally.
 */

const db = require('./db');
const drafts = require('./drafts');
const sleeper = require('./sleeper');
const fanout = require('./fanout');
const trades = require('./trades');
const { weekFacts } = require('./stats');
const { generateRecap, factsBlock } = require('./recap');
const { verifyRecap } = require('./verify');

/** The most recent finished week that has no draft yet. */
async function targetWeek(leagueId, currentWeek) {
  const { rows } = await db.query(
    `select s.season, s.week, s.payload
     from snapshots s
     where s.league_id = $1 and ($2::int is null or s.week < $2)
       and not exists (
         select 1 from recap_drafts d
         where d.league_id = s.league_id and d.season = s.season
           and d.week = s.week and d.kind = 'recap'
           and d.status in ('pending','approved','sent')
       )
     order by s.season desc, s.week desc
     limit 1`,
    [leagueId, currentWeek ?? null]
  );
  return rows[0] || null;
}

async function playerMap() {
  const { rows } = await db.query('select player_id, full_name, position, team from players');
  return new Map(rows.map(p => [p.player_id, p]));
}

/**
 * @param provider  MessagingProvider, used only to text the owner
 * @param opts.dryRun  generate and store, notify nobody
 */
async function runWeeklyRecaps(provider, opts = {}) {
  const { dryRun = false, spice = 1 } = opts;
  const jobId = await db.startJob('recap:weekly');
  const detail = { leagues: [] };

  try {
    let currentWeek = null;
    try {
      const state = await sleeper.state();
      // Only look at finished weeks. During the season the current week is
      // still in progress, and a recap of a half-played slate is worse than none.
      currentWeek = state.season_type === 'regular' ? state.week : null;
    } catch { /* state is a nicety; a missing one just widens the search */ }

    const players = await playerMap();
    const leagues = await db.activeLeagues();

    // Staggered, unlike snapshot captures. A recap has slack — nobody can tell
    // whether it lands at 9:03 or 9:21 — and spreading them keeps a hundred
    // leagues from all sending at the same cron minute, which is exactly the
    // burst shape that trips carrier spam filtering. The offset is stable per
    // league, so "our recap shows up around 9:20" stays true week to week.
    const results = await fanout.forEachLeague(leagues, async league => {
      const entry = { league: league.name };
      try {
        const snap = await targetWeek(league.id, currentWeek);
        if (!snap) { entry.result = 'nothing new to recap'; return entry; }

        entry.season = snap.season;
        entry.week = snap.week;

        const facts = weekFacts(snap.payload, players);

        // Never publish numbers we know are unreliable.
        if (facts.rulesWarning) {
          entry.result = 'skipped — rules warning';
          entry.warning = facts.rulesWarning;
          return entry;
        }
        if (!facts.games?.length) {
          entry.result = 'skipped — no completed games';
          return entry;
        }

        const out = await generateRecap(facts, { spice: league.config?.spice ?? spice });
        const verification = verifyRecap(out.text, facts, factsBlock(facts), { targetWords: out.meta.targetWords });

        if (!verification.ok) {
          entry.result = 'blocked by verification';
          entry.issues = verification.issues;
          console.error(`[weekly] ${league.name} week ${snap.week} failed verification — not queued`);
          return entry;
        }

        // Trade verdicts, appended AFTER verification on purpose. These are
        // deterministic prose built from scored points, not model output, and
        // their numbers are absent from the facts block the verifier checks —
        // running them through it would reject arithmetic for being unsourced.
        let body = out.text;
        const due = await trades.dueRevisits(league.id, snap.week).catch(() => []);
        if (due.length) {
          const names = trades.teamNames(snap.payload);
          const byWeek = await weekPayloads(league.id, snap.season);
          const segments = [];
          for (const t of due) {
            const verdict = trades.scoreTrade(t, byWeek, players);
            const text = trades.composeVerdict(t, verdict, names);
            if (!text) continue;
            segments.push(text);
            await trades.markRevisited(t.id, verdict);
          }
          if (segments.length) body = `${body}\n\n---\n\n${segments.join('\n\n')}`;
          entry.tradeVerdicts = segments.length;
        }

        const draft = await drafts.createDraft({
          leagueId: league.id,
          season: snap.season,
          week: snap.week,
          body,
          facts: {
            highScore: facts.highScore, lowScore: facts.lowScore,
            blowout: facts.blowout, nailbiter: facts.nailbiter,
            biggestRegret: facts.biggestRegret,
          },
          verification,
          model: out.meta.model,
        });

        if (!draft) { entry.result = 'draft already existed'; return entry; }
        entry.draftId = draft.id;

        if (drafts.autoPostEnabled(league) && league.chat_id && !dryRun) {
          const { sent } = await drafts.sendRecap(provider, league.chat_id, body);
          const res = sent[0];
          await drafts.markSent(draft.id, { by: 'autoPost', messageId: res?.message_handle || null });
          await db.recordMessage({
            leagueId: league.id, provider: league.provider,
            providerMessageId: res?.message_handle || null,
            direction: 'outbound', chatId: league.chat_id, senderPhone: null,
            isGroup: true, protocol: null, body,
            raw: { source: 'recap_auto', draft_id: draft.id }, occurredAt: Date.now(),
          });
          entry.result = 'auto-posted';
          return entry;
        }

        const owners = drafts.ownersOf(league);
        if (!owners.length) {
          entry.result = 'queued, but no ownerPhone configured — nobody was notified';
          console.warn(`[weekly] ${league.name}: set config.ownerPhone so approvals can be requested`);
          return entry;
        }

        const note = [
          `${league.name}, week ${snap.week} recap, ready for you.`,
          '',
          body,
          '',
          verification.superlatives.length
            ? `Check these ranking words against the results: ${verification.superlatives.join(', ')}.`
            : null,
          'Reply SEND to post it, NO to kill it.',
        ].filter(Boolean).join('\n');

        if (dryRun) {
          console.log(`[weekly] (dry run) would text ${owners.join(', ')}:\n${note}\n`);
          entry.result = 'queued (dry run, not sent)';
        } else {
          for (const owner of owners) {
            try { await provider.send(owner, note); }
            catch (err) { console.error(`[weekly] could not text ${owner}:`, err.message); }
          }
          entry.result = `queued, ${owners.length} owner(s) notified`;
        }
        return entry;
      } catch (err) {
        entry.result = 'ERROR';
        entry.error = err.message;
        console.error(`[weekly] ${league.name} failed:`, err.message);
        return entry;
      }
    });

    for (const r of results) {
      // forEachLeague never rejects; the handler above already converts its own
      // failures into an entry, so an !ok here is a bug in this function rather
      // than in a league's data.
      detail.leagues.push(r.ok ? r.value : { result: 'ERROR', error: r.error.message });
    }

    const expired = await drafts.expireStale();
    if (expired.length) detail.expired = expired.length;

    const failed = detail.leagues.filter(l => l.result === 'ERROR');
    await db.finishJob(jobId, failed.length ? 'error' : 'ok', detail);
    return detail;
  } catch (err) {
    detail.error = err.message;
    await db.finishJob(jobId, 'error', detail);
    throw err;
  }
}

module.exports = { runWeeklyRecaps, targetWeek };

/** week -> snapshot payload for one league/season, for trade scoring. */
async function weekPayloads(leagueId, season) {
  const { rows } = await db.query(
    `select week, payload from snapshots
     where league_id = $1 and season = $2 order by week, captured_at desc`,
    [leagueId, String(season)]
  );
  const m = new Map();
  for (const r of rows) if (!m.has(r.week)) m.set(r.week, r.payload);
  return m;
}
