#!/usr/bin/env node
/**
 * Identity binding rules — logic only, no database.
 *
 * The threat is mundane and real: in a group chat anyone can type "this is
 * Sean." The phone number is the only verified fact; the team is a claim. This
 * file pins the rules that decide which claims are honored.
 */
const assert = require('assert');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

// Mirrors the decision order in db.bindMember.
function decide({ existingForPhone, existingForTeam, phone, sleeperUserId, force = false }) {
  if (existingForPhone && existingForPhone.sleeper_user_id === sleeperUserId) return 'unchanged';
  if (!force) {
    if (existingForPhone && existingForPhone.sleeper_user_id && existingForPhone.locked) return 'rejected_phone_taken';
    if (existingForTeam && existingForTeam.phone && existingForTeam.phone !== phone && existingForTeam.locked) return 'rejected_team_taken';
  }
  return force && existingForPhone ? 'rebound' : 'bound';
}

const nathan = { phone: '+15550102', sleeper_user_id: 'u_nathan', display_name: 'Marcus', locked: true };

console.log('first claim wins');
it('an unbound phone can bind', () =>
  assert.strictEqual(decide({ phone: '+15550109', sleeperUserId: 'u_new' }), 'bound'));
it('re-stating the same pairing is a no-op', () =>
  assert.strictEqual(decide({ existingForPhone: nathan, phone: nathan.phone, sleeperUserId: 'u_nathan' }), 'unchanged'));

console.log('\nhijacking is refused');
it('a bound phone cannot become a different person', () =>
  assert.strictEqual(
    decide({ existingForPhone: nathan, phone: nathan.phone, sleeperUserId: 'u_sean' }),
    'rejected_phone_taken'));
it('a taken team cannot be claimed by another phone', () =>
  assert.strictEqual(
    decide({ existingForTeam: nathan, phone: '+15550199', sleeperUserId: 'u_nathan' }),
    'rejected_team_taken'));
it('a second "this is Sean" from Marcus\'s phone changes nothing', () => {
  // The exact sequence observed live, four days apart.
  assert.strictEqual(decide({ existingForPhone: nathan, phone: nathan.phone, sleeperUserId: 'u_sean' }), 'rejected_phone_taken');
});

console.log('\ncommissioner override');
it('force rebinds a phone', () =>
  assert.strictEqual(
    decide({ existingForPhone: nathan, phone: nathan.phone, sleeperUserId: 'u_sean', force: true }),
    'rebound'));
it('force takes a team from another phone', () =>
  assert.strictEqual(
    decide({ existingForTeam: nathan, phone: '+15550199', sleeperUserId: 'u_nathan', force: true }),
    'bound'));

console.log(`\n${pass} passing`);
