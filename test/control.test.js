#!/usr/bin/env node
/**
 * Owner control channel.
 *
 * The risk here is a false positive: a normal chat message being read as an
 * approval would publish an unreviewed recap to a real league. Most of these
 * assert that ordinary sentences are NOT commands.
 */
const assert = require('assert');
const { APPROVE, REJECT, STATUS } = require('../src/control');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};
const isCommand = t => APPROVE.test(t) || REJECT.test(t) || STATUS.test(t);

console.log('approval commands');
for (const t of ['send', 'send it', 'Send It', 'POST', 'post it', 'yes', 'y', 'yep', 'ship it', 'go', 'approve', 'do it', '👍'])
  it(`approves ${JSON.stringify(t)}`, () => assert.ok(APPROVE.test(t)));

console.log('\nrejection commands');
for (const t of ['no', 'nope', 'n', 'kill', 'kill it', 'skip', 'reject', 'nah', '👎'])
  it(`rejects ${JSON.stringify(t)}`, () => assert.ok(REJECT.test(t)));

console.log('\nstatus');
for (const t of ['status', 'pending', 'queue', 'drafts'])
  it(`asks status ${JSON.stringify(t)}`, () => assert.ok(STATUS.test(t)));

console.log('\nordinary messages must NOT be commands');
for (const t of [
  'send it to nathan',
  'yes I think Ruiz wins this year',
  'no way that lineup was legal',
  'can you post the standings',
  'hey bot who won last week',
  'going to skip this week',
  'the status of my team is bad',
  'y tho',
])
  it(`ignores ${JSON.stringify(t)}`, () => assert.ok(!isCommand(t), 'matched a command pattern'));

console.log(`\n${pass} passing`);
