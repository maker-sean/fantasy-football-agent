/**
 * Phase 1 worker — all background work, separate from the web receiver.
 *
 * Two jobs:
 *   1. Snapshot capture. The only artifact that cannot be backfilled, with a
 *      hard deadline of the season's first kickoff.
 *   2. Inbound polling. Sendblue does not fire webhooks for GROUP messages
 *      (measured 2026-08-15), and the product lives in a group, so polling is
 *      the inbound transport — not a fallback.
 *
 * Run:  npm run worker
 *
 * Lock snapshots fire just BEFORE each slate starts: a capture taken after
 * kickoff has already lost the bench decisions that make the recap worth
 * reading.
 */

require('dotenv').config();

const cron = require('node-cron');
const db = require('./src/db');
const snapshots = require('./src/snapshots');
const poller = require('./src/poller');
const inbound = require('./src/inbound');
const { SendblueProvider } = require('./src/sendblue');
const { Responder } = require('./src/responder');
const { runWeeklyRecaps } = require('./src/weekly');
const gameday = require('./src/gameday');
const trades = require('./src/trades');
const chatlink = require('./src/chatlink');

const TZ = process.env.CRON_TZ || 'America/New_York';
const POLL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 10) * 1000;
const POLL_ENABLED = process.env.POLL_ENABLED !== 'false';
// Off by default: the worker runs unattended, and a bot that starts replying in
// a real group without someone watching is how you annoy a league into muting it.
const ECHO = process.env.ECHO === 'true';
// DRY_RUN decides and logs every burst but never sends — the safe way to watch
// the reply logic against live traffic before letting it speak.
const DRY_RUN = process.env.REPLY_DRY_RUN === 'true';

const sendblue = (process.env.SENDBLUE_API_KEY_ID && process.env.SENDBLUE_API_SECRET_KEY)
  ? new SendblueProvider(
      process.env.SENDBLUE_API_KEY_ID,
      process.env.SENDBLUE_API_SECRET_KEY,
      { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
    )
  : null;

// The game-day tick replaces guessing at slate times: every capture and alert
// is driven by a real kickoff from the schedule. Week 10 of 2025 started at
// 09:30 ET in Berlin — a fixed Sunday-noon job missed it by three and a half
// hours, silently.
//
// The fixed slate captures below are kept as a safety net in case ESPN is
// unreachable; they are insert-only, so a duplicate costs nothing.
/**
 * Reconcile recent sends, and say so out loud when one did not arrive.
 *
 * The alert is the point. Writing the failure to send_log makes it findable
 * later; texting the operator makes it findable NOW, which is the difference
 * between a bot that looks broken to twelve people and one somebody fixes.
 */
async function auditDelivery() {
  if (!sendblue) return;
  const delivery = require('./src/delivery');
  const out = await delivery.reconcile(sendblue);
  if (out.checked) console.log(`[delivery] resolved ${out.checked}, ${out.failures.length} failed`);
  const text = delivery.alertText(out.failures);
  if (text) {
    await require('./src/notify').operator(sendblue, text, { dryRun: DRY_RUN || !ECHO });
  }
}

const JOBS = [
  ['gameday',        '*/15 * * * *', () => gameday.tick(sendblue, { dryRun: DRY_RUN })],
  ['schedule',       '0 5 * * *',    () => gameday.refreshSchedule()],
  // Trades. The tick is frequent but the Sleeper call is not: only leagues
  // whose configured window (default 8am/6pm local) has opened are polled, and
  // that check is a database read. Per-league timing without per-league crons —
  // a hundred registrations that need a restart to change, and that silently
  // skip a day whenever the worker was down at the exact minute.
  ['trades',         '*/15 * * * *', () => trades.poll(sendblue, { dryRun: DRY_RUN })],
  ['lock_thu',       '15 20 * * 4', () => snapshots.captureAll('lock_thu')],
  ['lock_sun_early', '55 12 * * 0', () => snapshots.captureAll('lock_sun_early')],
  ['lock_sun_late',  '55 15 * * 0', () => snapshots.captureAll('lock_sun_late')],
  ['lock_sun_night', '10 20 * * 0', () => snapshots.captureAll('lock_sun_night')],
  ['lock_mon',       '10 20 * * 1', () => snapshots.captureAll('lock_mon')],
  // Final scores, after Monday night has settled.
  ['postscore',      '0 6 * * 2',   () => snapshots.captureAll('postscore')],
  /*
   * Did the last few messages actually land?
   *
   * send_log.ok means Sendblue accepted the request, and a reply to the league
   * was accepted, recorded ok/QUEUED, and then failed at the device layer with
   * "could not determine target service for group". Every record said it went
   * out. It was found because somebody read the chat and asked.
   *
   * Every six minutes. Cheap either way — it reads only recent rows with no
   * terminal state, and one request finds nothing when nothing is wrong — and
   * the tight cadence buys margin against the retry window: a failure caught
   * at six minutes still has nine of the fifteen minute resend budget left,
   * where a ten minute sweep left only five.
   *
   * Six divides into 60, so every gap is exactly six. Seven was tried first and
   * fires at :00 :07 ... :56, leaving a ragged four minute gap when the hour
   * rolls. Harmless, and there is no reason to have it.
   */
  /*
   * Every two minutes, not every six.
   *
   * A reply to a live group failed at 23:57, Sendblue did not admit ERROR until
   * 00:02, the six-minute pass at 00:00 saw it still QUEUED and skipped, and the
   * retry did not go out until 00:06 — nine and a half minutes from question to
   * answer, in a chat where people were talking. Most of that gap was waiting
   * for the next poll rather than waiting for the provider.
   *
   * A pass that finds nothing costs one request, which is why the interval can
   * come down without much thought. Worst case goes from about twelve minutes
   * to about four.
   */
  ['delivery',       '*/2 * * * *', () => auditDelivery()],
  // Housekeeping.
  ['players',        '0 4 * * *',   () => snapshots.refreshPlayers()],
  /*
   * Community trade values, daily, after the players refresh so the names it
   * matches against are the current ones.
   *
   * A narrow window on purpose. The source publishes a row per day back to
   * 2020 and re-reading all of it nightly would be a million rows of `do
   * nothing` conflicts to import three. Backfilling the history is a deliberate
   * act: npm run values -- --since 2020-04-01 --save
   */
  /*
   * A league's trade history, pulled once, when it has actually joined.
   *
   * Deliberately NOT part of the pre-flight. That check runs against a league
   * which has agreed to nothing and may never accept the invite, and pulling
   * seven years of its transactions to answer a question nobody asked is both
   * wasted work and data we have no business holding yet.
   *
   * Off the request path because it is roughly a hundred Sleeper calls per
   * league — a league-creation handler doing that would time out. Here it costs
   * one query a day for leagues already done, and runs exactly once per league
   * because having any trade on file is the signal it has run.
   *
   * Adopted, never announced: a league joining in September must not be greeted
   * by a hundred alerts about trades from 2021.
   */
  ['trade_history',  '0 5 * * *',   async () => {
    const trades = require('./src/trades');
    /*
     * Keyed on a timestamp, not on "has any trades".
     *
     * Trades attach to the ARCHIVE row of the season they happened in, each
     * carrying that season's own Sleeper id, so counting by the current id sees
     * only this year — and a league that has genuinely never traded would look
     * un-backfilled forever and re-walk seven years every night to find the
     * same nothing.
     */
    const { rows: due } = await db.query(
      `select id, name, sleeper_league_id from leagues
        where provider <> 'archive' and active
          and sleeper_league_id is not null
          and trades_backfilled_at is null`);

    for (const lg of due) {
      const out = await trades.backfill(lg.sleeper_league_id).catch(err => {
        console.error(`[trade_history] ${lg.name} failed:`, err.message);
        return null;
      });
      if (!out) continue;   // left unstamped on purpose, so it is retried
      await db.query('update leagues set trades_backfilled_at = now() where id = $1', [lg.id]);
      console.log(`[trade_history] ${lg.name}: ${out.trades} trades, ${out.seasons} seasons`);
    }
  }],
  ['values',         '30 4 * * *',  async () => {
    const since = new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10);
    const out = await require('./src/playervalues').ingest({ since });
    console.log(`[values] ${out.written} new rows, ${out.unmatched.length} unmatched`);
    if (out.unmatched.length) console.warn('[values] unmatched:', out.unmatched.slice(0, 10).join(', '));
  }],
  ['members',        '30 4 * * *',  () => snapshots.syncMembers()],
  // The weekly recap — Tuesday morning, after Monday night has settled and the
  // postscore capture has run. Queues a draft and texts the owner; it does not
  // post to a league unless that league has opted into autoPost.
  ['recap_weekly',   '0 9 * * 2',   () => runWeeklyRecaps(sendblue, { dryRun: DRY_RUN })],
];

async function preflight() {
  const { rows } = await db.query('select now() as now');
  console.log(`[worker] db ok — ${rows[0].now.toISOString()}`);

  const leagues = await db.activeLeagues();
  if (!leagues.length) {
    console.warn('[worker] WARNING: no active leagues with a sleeper_league_id.');
    console.warn('[worker] Snapshots will skip every run. Register one:');
    console.warn('[worker]   node scripts/register-league.js --help');
  } else {
    for (const l of leagues) {
      console.log(`[worker] league: ${l.name} (sleeper ${l.sleeper_league_id}, chat ${l.chat_id || 'unlinked'})`);
    }
  }

  const sleeper = require('./src/sleeper');
  const state = await sleeper.state();
  console.log(`[worker] nfl state: season ${state.season} ${state.season_type} week ${state.week}`);
  if (!snapshots.isRegularSeason(state)) {
    console.log('[worker] preseason — scheduled captures will SKIP until season_type=regular.');
    console.log('[worker] force one now with: npm run snapshot -- lock_sun_early --force');
  }
}

let stopPolling = null;
let responder = null;

/**
 * What the bot says once it has decided to speak.
 *
 * Deliberately thin and separate from the decision. Layer 1 only fires on a
 * direct address, so this is the "someone asked me something" path — wiring it
 * to real league context and tools is the next piece of work, and keeping it
 * behind one function keeps that from touching the reply logic.
 */
async function generateReply({ burst, league }) {
  const asked = burst.map(m => m.text).filter(Boolean).join(' ').trim();
  console.log(`[reply] addressed in ${league?.name || 'unrouted'}: ${JSON.stringify(asked.slice(0, 120))}`);

  if (!league) {
    console.log('[reply] chat is not linked to a league — nothing to ground an answer in');
    return null;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[reply] ANTHROPIC_API_KEY not set — decision logged, no answer generated');
    return null;
  }

  try {
    const { leagueContext } = require('./src/context');
    const { generateAnswer } = require('./src/answer');
    // Whose roster to pull projections for. The asker's — see context.js on
    // why it is not everybody's.
    const asker = burst.map(m => m.senderId).filter(Boolean)[0] || null;
    const ctx = await leagueContext(league.id, { forPhone: asker });

    const { rows: recent } = await db.query(
      `select sender_phone, direction, body from messages
       where league_id = $1 order by occurred_at desc limit 6`,
      [league.id]
    );

    /*
     * WHO said it, by name.
     *
     * This labelled every speaker with a raw phone number, and KNOWN PEOPLE
     * carries names without phones, so there was no join available: the model
     * could not tell one person asking twice from two people asking once. It
     * told a league member he was "repeating it a third time" when he had asked
     * twice, because it was counting messages rather than people.
     */
    const { rows: who } = await db.query(
      'select phone, display_name from members where league_id = $1 and phone is not null',
      [league.id]
    );
    const nameFor = new Map(who.map(m => [m.phone, m.display_name]));

    const recentChat = recent.reverse().map(r => ({
      who: r.direction === 'outbound'
        ? 'bot'
        : (nameFor.get(r.sender_phone) || r.sender_phone || 'someone'),
      /*
       * Long enough for the bot to read its OWN last reply.
       *
       * At 120 characters its previous answers arrived cut mid sentence, so
       * asked whether it had already said something it was reconstructing from
       * fragments of itself, and got the count wrong out loud.
       */
      text: String(r.body || '').slice(0, 400),
    }));

    const out = await generateAnswer(asked, ctx, { recentChat, spice: league.config?.spice ?? 1 });
    console.log(`[reply] generated ${out.text.split(/\s+/).length} words`);

    /*
     * Record what the answer cost.
     *
     * generateAnswer returns usage in meta and this function used to return
     * out.text alone, so every conversational reply's tokens were discarded at
     * exactly the point they were in hand. Recap tokens survived in
     * recap_drafts.usage; replies left no trace at all, and cost per league
     * cannot be reconstructed after the fact.
     */
    const u = out.meta?.usage;
    if (u) {
      /*
       * The cache columns too. answer.js has cached PERSONA since it was
       * written and this recorded only input and output, so every cached read
       * was counted at full price and there was no way to see the gap. A cache
       * read is about a tenth of input; without it "cost" is a guess with a
       * known bias and no way to size it.
       */
      db.query(
        `insert into model_usage (league_id, kind, model, input_tokens, output_tokens,
                                  cache_read_input_tokens, cache_creation_input_tokens, detail)
         values ($1,'reply',$2,$3,$4,$5,$6,$7)`,
        [league.id, out.meta.model || null, u.input_tokens || 0, u.output_tokens || 0,
         u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
         // What was loaded, next to what it cost. Null when retrieval is off,
         // which is itself the record that this reply carried the whole league.
         out.meta.sections ? JSON.stringify({ sections: out.meta.sections }) : null]
      ).catch(err => console.error('[reply] could not record usage:', err.message));
    }

    /*
     * The routing decision, as its own row.
     *
     * Its own kind so 'reply' averages stay comparable across the rollout —
     * folding a small router call into the reply average would blur the one
     * number this change is judged on. The detail is the point: when an answer
     * looks confidently wrong, the question is which sections it was given, and
     * that is not recoverable from the text.
     */
    const r = out.meta?.routing;
    if (r) {
      db.query(
        `insert into model_usage (league_id, kind, model, input_tokens, output_tokens, detail)
         values ($1,'route',$2,$3,$4,$5)`,
        [league.id, r.model || null, r.usage?.input_tokens || 0, r.usage?.output_tokens || 0,
         JSON.stringify({
           sections: out.meta.sections,
           lookup: r.lookup || null,
           ms: r.ms ?? null,
           fellBack: r.fellBack || null,
           asked: String(asked || '').slice(0, 200),
         })]
      ).catch(err => console.error('[reply] could not record routing:', err.message));
    }
    return out.text;
  } catch (err) {
    console.error('[reply] answer failed:', err.message);
    require('./src/errorlog').record({
      system: 'anthropic', operation: 'generateAnswer',
      message: err.message, leagueId: league?.id || null,
    });
    return null;   // silence beats a broken reply in a live group
  }
}

(async () => {
  console.log(`[worker] starting, tz=${TZ}`);
  try {
    await preflight();
  } catch (err) {
    console.error('[worker] preflight failed:', err.message);
    process.exit(1);
  }

  for (const [name, expr, fn] of JOBS) {
    if (!cron.validate(expr)) {
      console.error(`[worker] invalid cron for ${name}: ${expr}`);
      process.exit(1);
    }
    cron.schedule(expr, () => {
      console.log(`[worker] firing ${name}`);
      fn().catch(err => console.error(`[worker] ${name} threw:`, err.message));
    }, { timezone: TZ });
    console.log(`[worker] scheduled ${name.padEnd(15)} ${expr}  (${TZ})`);
  }

  if (POLL_ENABLED && sendblue) {
    console.log(`[worker] polling sendblue every ${POLL_MS / 1000}s  echo=${ECHO ? 'ON' : 'off'}`);
    // Persistence and the reply decision are separate concerns: every message
    // is stored, only some are answered.
    responder = new Responder(sendblue, generateReply, {
      providerName: 'sendblue',
      dryRun: DRY_RUN || !ECHO,
    });

    stopPolling = poller.startPolling(sendblue, async msg => {
      // Onboarding step 6 completes here, not in the browser. A league parked
      // on `awaiting_chat` goes live only when a message actually arrives from
      // its group — the commissioner cannot assert it into being.
      try {
        const linked = await chatlink.tryLink(msg, { provider: 'sendblue' });

        /*
         * Introduce ourselves the moment we are in, not the first time somebody
         * happens to ask something.
         *
         * The welcome used to hang off src/responder.js, gated on a verdict
         * from decide(). But help and claims both return early well above that
         * gate, so whichever of them spoke first became a league's first words.
         * Halcyon Kings met the bot with "I do not know which of you is which
         * yet" from a number nobody recognised, and never got the contact card,
         * because the card rides on the introduction.
         *
         * tryLink returns a league ONLY on the transition, so this fires once,
         * on the message that proves we are in the chat. ensureWelcomed guards
         * on welcomed_at and stamps only after a successful send, so a failure
         * here leaves the league un-introduced and it will be tried again
         * rather than silently marked done.
         */
        if (linked) {
          const welcome = require('./src/welcome');
          const drafts = require('./src/drafts');
          const needs = await welcome.needsBinding(linked.id).catch(() => false);
          await welcome.ensureWelcomed(linked, {
            send: (chat, text, opts) => drafts.sendRecap(sendblue, chat, text, opts),
            needsBinding: needs,
            dryRun: DRY_RUN || !ECHO,
          }).catch(err => console.error('[welcome] introduction failed:', err.message));
        }
      } catch (err) {
        console.error('[chatlink] failed:', err.message);
      }

      const result = await inbound.handleInbound(msg, sendblue, {
        providerName: 'sendblue',
        echo: false,          // the Responder owns replying now
        source: 'worker-poll',
      });
      console.log('[in] ' + inbound.describe(msg, result));
      responder.observe(msg);
    }, { intervalMs: POLL_MS, bootstrap: true });
  } else if (!sendblue) {
    console.warn('[worker] sendblue not configured — inbound polling disabled');
  } else {
    console.log('[worker] polling disabled (POLL_ENABLED=false)');
  }

  console.log('[worker] running. ctrl-c to stop.');
})();

const shutdown = async () => {
  if (stopPolling) stopPolling();
  if (responder) await responder.shutdown().catch(() => {});
  console.log('\n[worker] shutting down');
  await db.pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
