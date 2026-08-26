#!/usr/bin/env node
/**
 * Run the same questions with the whole context and with a routed subset, and
 * print what each choice cost and whether the answers still agree.
 *
 * The point is not the token count, which is easy to move and easy to fool
 * yourself with. It is the pairing: a question whose routed answer LOST a fact
 * the full answer had is a routing miss, and no saving justifies one.
 *
 * Usage: node scripts/retrieval-bench.js [league name substring]
 */
require('dotenv').config();
const db = require('../src/db');
const { leagueContext, contextBlock } = require('../src/context');
const { generateAnswer } = require('../src/answer');
const { route } = require('../src/retrieve');

// Deliberately mixed: questions that name their section, questions that need
// one without naming it, and questions that need nothing but the core.
const QUESTIONS = [
  ['core',    'What are the standings?'],
  ['core',    'Who is in this league?'],
  ['history', 'Who won the league last year?'],
  ['history', 'What is the highest score anyone has ever put up?'],
  ['history', 'Am I any good at this?'],
  ['history', 'Who is the best manager in this league all time?'],
  ['trades',  'How many trades have we made and who loses the most?'],
  ['trades',  'What was the worst trade in league history?'],
  ['trades',  'Did I ever get fleeced?'],
  ['draft',   'How did our draft go?'],
  ['mixed',   'Who should I be worried about this year?'],
  ['mixed',   'Settle an argument: who is the worst at this league, and why?'],
];

const est = s => Math.round(s.length / 4);

(async () => {
  const want = process.argv[2] || 'Halcyon';
  /*
   * The LIVE row, explicitly. Every league keeps an archive row per past season
   * under a name like "Halcyon Kings 2020", and a bare ilike picked one of
   * those first — which benchmarks a league whose members were never bound, so
   * every answer says "roster 7" and none of the numbers mean anything.
   */
  const { rows: [lg] } = await db.query(
    `select id, name from leagues
      where name ilike $1 and provider <> 'archive' and active
      order by season desc limit 1`, [`%${want}%`]);
  if (!lg) throw new Error(`no league matching ${want}`);

  const ctx = await leagueContext(lg.id);
  const full = contextBlock(ctx);
  console.log(`${lg.name} — full context ~${est(full)} tokens, core ~${est(contextBlock(ctx, { only: [] }))}\n`);

  let fullTok = 0, cutTok = 0, fullMs = 0, cutMs = 0, routeMs = 0;

  for (const [expect, q] of QUESTIONS) {
    const t0 = Date.now();
    const routed = await route(q, {});
    const rMs = Date.now() - t0;

    const t1 = Date.now();
    const a = await generateAnswer(q, ctx, { recentChat: [] });
    const aMs = Date.now() - t1;

    const t2 = Date.now();
    const b = await generateAnswer(q, ctx, { recentChat: [], retrieve: true });
    const bMs = Date.now() - t2;

    const ain = a.meta.usage.input_tokens;
    const bin = b.meta.usage.input_tokens;
    fullTok += ain; cutTok += bin; fullMs += aMs; cutMs += bMs + rMs; routeMs += rMs;

    const hit = expect === 'mixed' || expect === 'core'
      ? '   '
      : routed.sections.includes(expect) ? ' ok' : 'MISS';

    console.log(`${hit}  ${q}`);
    console.log(`      routed to [${routed.sections.join(', ') || 'none'}] in ${rMs}ms`
              + `   ${ain} -> ${bin} tokens (${Math.round(100 - 100 * bin / ain)}% off)`
              + `   ${aMs}ms -> ${bMs + rMs}ms`);
    console.log(`      full: ${a.text.replace(/\n+/g, ' ')}`);
    console.log(`      cut:  ${b.text.replace(/\n+/g, ' ')}\n`);
  }

  const n = QUESTIONS.length;
  console.log('='.repeat(70));
  console.log(`input tokens  ${fullTok} -> ${cutTok}   (${Math.round(100 - 100 * cutTok / fullTok)}% saved)`);
  console.log(`avg latency   ${Math.round(fullMs / n)}ms -> ${Math.round(cutMs / n)}ms `
            + `(router ${Math.round(routeMs / n)}ms of it)`);
  const price = (t) => (t / 1e6 * 3).toFixed(4);
  console.log(`input cost    $${price(fullTok)} -> $${price(cutTok)} over ${n} questions`);
  await db.pool.end();
})().catch(e => { console.error(e); process.exit(1); });
