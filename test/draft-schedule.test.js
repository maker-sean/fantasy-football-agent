#!/usr/bin/env node
/**
 * When the draft is.
 *
 * The most common question a league asks in August, and the bot answered "no
 * draft date, nothing captured for 2026" while Sleeper had known the answer the
 * whole time. Everything about drafts in this codebase was built for archived
 * seasons and reads picks that do not exist yet.
 *
 * The cases worth pinning are the absences. A date that is not set, an order
 * that is not set, and a finished draft all have to read differently from each
 * other, because "not set yet" is a useful answer and "I don't know" is not.
 */
const assert = require('assert');
const { contextBlock } = require('../src/context');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const ctx = (draftSchedule) => ({
  self: [], leagueName: 'Test', members: [], standings: [], unknowns: [],
  season: '2026', draftSchedule,
});
const base = { status: 'pre_draft', type: 'snake', rounds: 14, pickSeconds: 90,
  startsAt: Date.UTC(2026, 7, 31, 0, 0, 0), orderSet: false };

console.log('the draft block');

it('a scheduled draft prints a date a human can act on', () => {
  const b = contextBlock(ctx(base));
  assert.match(b, /THE DRAFT/);
  assert.match(b, /scheduled for/);
  // The timezone has to be named. "8pm" to twelve people in three timezones is
  // not an answer.
  assert.match(b, /\b(EDT|EST|GMT|UTC|[A-Z]{2,5}T)\b/);
});

it('the raw timestamp never reaches the model', () => {
  // Handed epoch milliseconds, a model will try to do arithmetic on them.
  const b = contextBlock(ctx(base));
  assert.ok(!b.includes(String(base.startsAt)), 'epoch milliseconds leaked into the prompt');
});

it('an unscheduled draft says so rather than going quiet', () => {
  const b = contextBlock(ctx({ ...base, startsAt: null }));
  assert.match(b, /no date has been set/i);
  assert.ok(!/scheduled for/.test(b));
});

it('an unset order is reported as unset, which is the real answer', () => {
  // The league was arguing about how to choose one when it asked.
  assert.match(contextBlock(ctx(base)), /order has NOT been set/i);
});

it('a set order is not invented, since we do not fetch it', () => {
  const b = contextBlock(ctx({ ...base, orderSet: true }));
  assert.match(b, /have NOT been given it/i);
});

it('a finished draft drops the block entirely', () => {
  const b = contextBlock(ctx({ ...base, status: 'complete' }));
  assert.ok(!b.includes('THE DRAFT'), 'still advertising a draft that already happened');
});

it('no schedule at all means no block', () => {
  assert.ok(!contextBlock(ctx(null)).includes('THE DRAFT'));
});

it('the format is carried, since "when" and "how long" arrive together', () => {
  const b = contextBlock(ctx(base));
  assert.match(b, /snake/);
  assert.match(b, /14 rounds/);
  assert.match(b, /90 seconds/);
});

console.log(`\n${pass} passing`);
