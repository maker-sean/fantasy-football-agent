#!/usr/bin/env node
/** START parsing: the website's only call to action lands here. */
const assert = require('assert');
const { parse, reply } = require('../src/signup');

let pass = 0;
const it = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

console.log('parsing what people actually type');
it('the exact text the site hands them', () =>
  assert.deepStrictEqual(parse('START 1400000000000000001'), { leagueId: '1400000000000000001' }));
it('lowercase', () => assert.deepStrictEqual(parse('start 1400000000000000001'), { leagueId: '1400000000000000001' }));
it('stray whitespace', () => assert.deepStrictEqual(parse('  START   1400000000000000001  '), { leagueId: '1400000000000000001' }));
it('a colon, because autocorrect', () => assert.deepStrictEqual(parse('START: 1400000000000000001'), { leagueId: '1400000000000000001' }));
it('START alone still counts — we ask for the league after', () =>
  assert.deepStrictEqual(parse('START'), { leagueId: null }));

console.log('\nwhat must NOT be treated as a signup');
it('a sentence containing the word start', () => assert.strictEqual(parse('when does the season start'), null));
it('"started" is not "start"', () => assert.strictEqual(parse('started Doubs again'), null));
it('empty', () => assert.strictEqual(parse(''), null));
it('null', () => assert.strictEqual(parse(null), null));
it('STOP is not START', () => assert.strictEqual(parse('STOP'), null));

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
it('START with no id asks for one', () => {
  assert.ok(/league ID/i.test(reply({ created: true, leagueId: null, league: null })));
});

console.log(`\n${pass} passing`);
