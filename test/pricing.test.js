#!/usr/bin/env node
/**
 * Turning tokens into dollars without the number quietly going wrong.
 *
 * observe.js reported tokens and refused dollars, and said why: "the price per
 * model changes and a stale multiplier baked in here would be worse than no
 * number at all." That objection is correct and there is a live example —
 * Sonnet 5's introductory rate ends 2026-08-31, after which the same traffic
 * costs 50% more.
 *
 * So the whole point of this file is the staleness flag. A number that is
 * wrong and says so is useful; a number that is wrong and confident is what
 * observe.js was right to refuse.
 */
const assert = require('assert');
const pricing = require('../src/pricing');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('the arithmetic');

it('input and output are priced separately', () => {
  const c = pricing.costOf({ model: 'claude-sonnet-5', input_tokens: 1e6, output_tokens: 0 });
  assert.strictEqual(c.cost, 2.00);
  const o = pricing.costOf({ model: 'claude-sonnet-5', input_tokens: 0, output_tokens: 1e6 });
  assert.strictEqual(o.cost, 10.00);
});

it('a cached read costs a tenth of input, not full price', () => {
  // The gap this was missing: answer.js has cached PERSONA since it was
  // written and model_usage recorded no cache columns, so every cached read
  // was counted at full price.
  const c = pricing.costOf({ model: 'claude-sonnet-5', cache_read_input_tokens: 1e6 });
  assert.strictEqual(c.cost, 0.20);
});

it('a cache write costs more than input, since it is paid once', () => {
  const c = pricing.costOf({ model: 'claude-sonnet-5', cache_creation_input_tokens: 1e6 });
  assert.strictEqual(c.cost, 2.50);
});

console.log('\nthe staleness flag, which is the point');

it('a rate inside its window is not stale', () => {
  const c = pricing.costOf({ model: 'claude-sonnet-5', input_tokens: 1000 },
    { now: new Date('2026-08-23') });
  assert.strictEqual(c.stale, false);
});

it('a rate past its announced change date IS stale', () => {
  // Sonnet 5 rises to $3.00 / $15.00 on 1 September. Without this the
  // dashboard would understate by a third from that morning, silently.
  const c = pricing.costOf({ model: 'claude-sonnet-5', input_tokens: 1000 },
    { now: new Date('2026-09-01T12:00:00Z') });
  assert.strictEqual(c.stale, true);
  assert.match(pricing.caveat(c), /understated/i);
});

it('staleness survives being summed, rather than being averaged away', () => {
  const t = pricing.totalOf(
    [{ model: 'claude-sonnet-5', input_tokens: 1000 }, { model: 'claude-opus-5', input_tokens: 1000 }],
    { now: new Date('2026-09-05') });
  assert.strictEqual(t.stale, true, 'one stale rate in a total makes the total stale');
});

console.log('\na model we have no rate for');

it('an unknown model is excluded and named, never guessed at', () => {
  const c = pricing.costOf({ model: 'claude-something-6', input_tokens: 1e6 });
  assert.strictEqual(c.cost, null);
  assert.strictEqual(c.unknownModel, true);
});

it('a total says which models it left out', () => {
  const t = pricing.totalOf([
    { model: 'claude-sonnet-5', input_tokens: 1e6 },
    { model: 'claude-something-6', input_tokens: 1e6 },
  ]);
  assert.strictEqual(t.cost, 2.00, 'the known row should still be counted');
  assert.deepStrictEqual(t.unknownModels, ['claude-something-6']);
  assert.match(pricing.caveat(t), /no rate on file/i);
});

console.log('\nno caveat when there is nothing to say');

it('a clean total produces no warning text', () => {
  assert.strictEqual(pricing.caveat(pricing.totalOf([{ model: 'claude-opus-5', input_tokens: 10 }])), null);
});

console.log(`\n${pass} passing`);
