#!/usr/bin/env node
/**
 * Community trade values, and the joins that make them usable.
 *
 * The numbers are KeepTradeCut's. Using them for a free bot in three friends'
 * leagues is a deliberate call; using them in something anybody pays for is
 * not, which is why `source` is a column and these tests pin that a second
 * provider is an entry in a map rather than a rewrite.
 */
require('dotenv').config();
const assert = require('assert');
const pv = require('../src/playervalues');

let pass = 0;
const it = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

console.log('names the two sides spell differently');

it('punctuation is removed, not turned into a space', () => {
  /*
   * The sheet writes "D.J. Moore", Sleeper writes "DJ Moore". Replacing the
   * periods with spaces gives "d j moore" against "dj moore" and they never
   * meet — which is exactly what the first version did, and it cost four
   * players out of five hundred.
   */
  assert.strictEqual(pv.normalise('D.J. Moore'), pv.normalise('DJ Moore'));
  assert.strictEqual(pv.normalise("Ja'Marr Chase"), pv.normalise('JaMarr Chase'));
});

it('suffixes do not break a match', () => {
  assert.strictEqual(pv.normalise('Jeff Wilson Jr.'), pv.normalise('Jeff Wilson'));
  assert.strictEqual(pv.normalise('Odell Beckham Jr'), pv.normalise('Odell Beckham'));
});

it('accents are folded', () => {
  assert.strictEqual(pv.normalise('Chárlie Jones'), pv.normalise('Charlie Jones'));
});

it('two different players still normalise apart', () => {
  // The whole risk of fuzzy matching. A normaliser that pairs these is worse
  // than one that leaves rows unmatched where we can see them.
  assert.notStrictEqual(pv.normalise('Michael Thomas'), pv.normalise('Mike Thomas'));
  assert.notStrictEqual(pv.normalise('Josh Allen'), pv.normalise('Keenan Allen'));
});

console.log('\npicks are assets, not people');

it('draft picks are recognised in every round', () => {
  for (const n of ['2026 Early 1st', '2027 Mid 2nd', '2025 Late 3rd', '2026 Early 4th']) {
    assert.strictEqual(pv.isPick(n), true, n);
  }
});

it('a player is never mistaken for a pick', () => {
  for (const n of ['Jahmyr Gibbs', 'Puka Nacua', 'Brock Bowers']) {
    assert.strictEqual(pv.isPick(n), false, n);
  }
});

console.log('\nthe wide sheet becomes rows');

it('a date row unpivots into one record per asset', () => {
  const csv = 'Date,Josh Allen,2026 Early 1st\n2026-08-25,9983,6332\n2026-08-24,9980,6300\n';
  const rows = pv.parseCsv(csv);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[1], ['2026-08-25', '9983', '6332']);
});

it('quoted commas do not split a field', () => {
  // The README rows carry prose with commas in them and would otherwise shift
  // every column to the right of them.
  const rows = pv.parseCsv('a,"one, two",c\n');
  assert.deepStrictEqual(rows[0], ['a', 'one, two', 'c']);
});

console.log('\nswapping the source');

it('ktc is one entry in a map, not a hardcoded assumption', () => {
  assert.ok(pv.SOURCES.ktc, 'ktc missing');
  assert.ok(typeof pv.SOURCES.ktc.fetch === 'function');
  assert.ok(Array.isArray(pv.SOURCES.ktc.series) && pv.SOURCES.ktc.series.length === 2,
    'expected a 1QB and a superflex series');
});

it('an unknown source fails loudly rather than defaulting to ktc', async () => {
  // Quietly falling back would put KTC values behind a name that says
  // otherwise, which is the one mistake this column exists to prevent.
  let threw = false;
  try { await pv.ingest({ source: 'nope', dryRun: true }); } catch { threw = true; }
  assert.ok(threw, 'an unknown source was silently accepted');
});

setTimeout(() => console.log(`\n${pass} passing`), 50);
