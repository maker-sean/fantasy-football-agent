#!/usr/bin/env node
/** START parsing: the website's only call to action lands here. */
const assert = require('assert');
const { parse, reply, KEYWORD, CODE_ALPHABET, newCode, RESERVED } = require('../src/signup');

let pass = 0;
const it = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

console.log('parsing what people actually type');
it('the exact text the site hands them', () =>
  assert.deepStrictEqual(parse('COMMISH 4F2K'), { leagueId: null, code: '4F2K' }));
it('lowercase', () => assert.deepStrictEqual(parse('commish 4f2k'), { leagueId: null, code: '4F2K' }));
it('stray whitespace', () => assert.deepStrictEqual(parse('  COMMISH   4F2K  '), { leagueId: null, code: '4F2K' }));
it('a colon, because autocorrect', () =>
  assert.deepStrictEqual(parse('COMMISH: 4f2k'), { leagueId: null, code: '4F2K' }));
it('the keyword alone still counts — we ask for the code after', () =>
  assert.deepStrictEqual(parse('COMMISH'), { leagueId: null, code: null }));

// One keyword is displayed; several are accepted, because people retype from
// memory and being strict here costs a signup.
for (const alt of ['DRAFT 4F2K', 'join 4f2k', 'signup 4F2K'])
  it(`accepts "${alt}"`, () => assert.strictEqual(parse(alt).code, '4F2K'));

// The first version of this flow told people to text a 19-digit league id.
// Anything already sent or screenshotted has to keep working.
it('still accepts the old long-form league id', () =>
  assert.deepStrictEqual(parse('START 1400000000000000001'),
    { leagueId: '1400000000000000001', code: null }));

console.log('\ncodes are readable when dictated or scanned');
it('the alphabet excludes look-alike characters', () => {
  for (const ch of ['O', '0', 'I', '1', 'L']) {
    assert.ok(!CODE_ALPHABET.includes(ch), `${ch} is ambiguous and must not appear in a code`);
  }
});
it('generated codes are four characters from that alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const c = newCode();
    assert.strictEqual(c.length, 4);
    assert.ok([...c].every(ch => CODE_ALPHABET.includes(ch)), c);
  }
});

console.log('\nwhat must NOT be treated as a signup');
it('a sentence containing the word start', () => assert.strictEqual(parse('when does the season start'), null));
it('"started" is not "start"', () => assert.strictEqual(parse('started Doubs again'), null));
it('empty', () => assert.strictEqual(parse(''), null));
it('null', () => assert.strictEqual(parse(null), null));
it('STOP is not START', () => assert.strictEqual(parse('STOP'), null));

console.log('\nthe way back from an accidental STOP');
// The line cannot go in a message sent AFTER the opt-out: the provider blocks
// outbound to that number the moment it sees the keyword, so it would never
// arrive. It goes in the confirmation they get on the way in, and the way back
// is START — which the provider already treats as opt-in and which this module
// recognises as a signup keyword.
it('the confirmation tells them how to leave AND how to return', () => {
  const t = reply({ created: true, leagueId: '1', league: { name: 'X', total_rosters: 12 } });
  assert.ok(/STOP/.test(t), 'says how to stop');
  assert.ok(/START/.test(t), 'says how to come back');
});
it('START is a recognised keyword, so the way back actually works', () =>
  assert.notStrictEqual(parse('START'), null));

console.log('\nthe reply is honest about the queue');
it('a real league is confirmed by name and size', () => {
  const t = reply({ created: true, leagueId: '123', league: { name: 'Halcyon Kings', total_rosters: 12 } });
  assert.ok(t.includes('Halcyon Kings') && t.includes('12 teams'));
  assert.ok(/queue/i.test(t), 'says it is a queue, not an activation');
  assert.ok(/isn't automatic/i.test(t), 'does not imply it is already running');
  assert.ok(/STOP/.test(t), 'gives the opt-out');
});
it('a bad league id is called out, not silently queued', () => {
  const t = reply({ created: true, leagueId: '999', league: null });
  assert.ok(/couldn't find/i.test(t));
});
it('texting twice does not read as a second signup', () => {
  const t = reply({ created: false, leagueId: '123', league: { name: 'Halcyon Kings', total_rosters: 12 } });
  assert.ok(/already/i.test(t));
});
it('the keyword with no code asks for one', () => {
  const t = reply({ created: true, leagueId: null, league: null });
  assert.ok(/code/i.test(t));
  assert.ok(t.includes(KEYWORD), 'tells them the exact word to send');
});

console.log('\ncarrier-reserved words must never be swallowed');
// A real bug this guards: someone mid-conversation texted STOP, it was treated
// as a Sleeper username, and because a user literally named "stop" exists the
// bot replied about their leagues instead of opting them out.
for (const w of ['STOP', 'stop', ' Stop ', 'STOPALL', 'unsubscribe', 'CANCEL', 'end', 'quit', 'HELP', 'info'])
  it(`"${w.trim()}" is reserved`, () => assert.strictEqual(RESERVED.test(w), true));

it('a username that merely contains "stop" is not reserved', () =>
  assert.strictEqual(RESERVED.test('stopwatch_steve'), false));
it('a sentence containing stop is not reserved', () =>
  assert.strictEqual(RESERVED.test('when does the bot stop'), false));
it('reserved words are also not signup keywords', () => {
  for (const w of ['STOP', 'HELP']) assert.strictEqual(parse(w), null);
});

console.log(`\n${pass} passing`);
