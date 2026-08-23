#!/usr/bin/env node
/**
 * The three questions asked after somebody joins the waitlist.
 *
 * Name, email, and where they actually want the bot. The last one is the point:
 * onboarding runs over SMS because that is what works today, and somebody
 * answering "Discord" is not confused about that, they are saying where their
 * league lives. A waitlist sorted by platform is a build order.
 *
 * Every step is skippable and says so. A waitlist entry with a phone and a
 * league is already useful, and refusing to proceed without an email trades a
 * lead for a field.
 */
const assert = require('assert');
const intake = require('../src/intake');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('people answer a question about their name with a sentence');

it('a bare name works', () => {
  assert.deepStrictEqual(intake.parseName('Chris Dalton'), { first: 'Chris', last: 'Dalton' });
  assert.deepStrictEqual(intake.parseName('chris'), { first: 'chris', last: null });
});

it('the sentence forms are stripped', () => {
  // "My name is Chris Dalton" recorded a manager called Is before this.
  for (const t of ['My name is Chris Dalton', 'my names Chris Dalton', "I'm Chris Dalton",
                   'this is Chris Dalton', 'Name: Chris Dalton']) {
    assert.strictEqual(intake.parseName(t).first, 'Chris', `wrong first from: ${t}`);
  }
});

it('a non-name is rejected rather than stored', () => {
  assert.strictEqual(intake.parseName('12345'), null);
  assert.strictEqual(intake.parseName(''), null);
  assert.strictEqual(intake.parseName('x'.repeat(200)), null);
});

console.log('\nthe platform question is the one that changes what gets built');

it('a number picks from the menu', () => {
  assert.strictEqual(intake.parsePlatform('1'), 'imessage');
  assert.strictEqual(intake.parsePlatform('5'), 'discord');
  assert.strictEqual(intake.parsePlatform('4)'), 'groupme');
});

it('the name typed out works too, since people answer in words', () => {
  assert.strictEqual(intake.parsePlatform('discord'), 'discord');
  assert.strictEqual(intake.parsePlatform('WhatsApp'), 'whatsapp');
  assert.strictEqual(intake.parsePlatform('we use GroupMe'), 'groupme');
});

it('facebook on its own means Messenger', () => {
  /*
   * The option was relabelled from "Messenger" to "Facebook Messenger", and
   * parsePlatform matches on the key or the FULL label — so without an explicit
   * alias the shorter, more common answer would match nothing and somebody who
   * types the brand rather than the app gets asked the question again.
   */
  for (const t of ['facebook', 'Facebook', 'FB', 'fb', 'we use facebook', 'facebook messenger']) {
    assert.strictEqual(intake.parsePlatform(t), 'messenger', `not messenger: ${t}`);
  }
});

it('the option is labelled Facebook Messenger, which is what people call it', () => {
  const [, label] = intake.PLATFORMS.find(([k]) => k === 'messenger');
  assert.strictEqual(label, 'Facebook Messenger');
  // The numbered SMS list is built from these labels, so the text question and
  // the website dropdown cannot disagree about what option 2 is.
  assert.match(intake.askPlatform(), /2\) Facebook Messenger/);
});

it('text, sms and imessage are the same answer to a person', () => {
  for (const t of ['text', 'sms', 'we just use text', 'group chat']) {
    assert.strictEqual(intake.parsePlatform(t), 'imessage', `not imessage: ${t}`);
  }
});

it('an unrecognised answer is not forced into the menu', () => {
  // It becomes "other" verbatim upstream, which is the entire value of an other
  // box: the answer nobody thought to list.
  assert.strictEqual(intake.parsePlatform('Slack'), null);
  assert.strictEqual(intake.parsePlatform('carrier pigeon'), null);
});

console.log('\nskipping is a first class answer');

it('every phrasing of no is accepted', () => {
  for (const t of ['skip', 'Skip', 'pass', 'no thanks', 'nah', 'rather not', 'n/a']) {
    assert.ok(intake.SKIP.test(t), `not treated as a skip: ${t}`);
  }
});

it('a real answer is never mistaken for a skip', () => {
  for (const t of ['Marcus', 'Skipper Jones', 'discord']) {
    assert.ok(!intake.SKIP.test(t), `wrongly treated as a skip: ${t}`);
  }
});

console.log('\nthe email check is loose on purpose');

it('it takes ordinary addresses', () => {
  for (const t of ['a@b.co', 'chris.dalton+ff@example.com', 'x_y@sub.domain.org']) {
    assert.ok(intake.EMAIL.test(t), `rejected a real address: ${t}`);
  }
});

it('it rejects things that are plainly not addresses', () => {
  // A strict regex rejects real mail, and the cost of a wrong address is a
  // bounced newsletter while the cost of rejecting a good one is the address.
  for (const t of ['not an email', 'chris at example.com', '@example.com', 'chris@']) {
    assert.ok(!intake.EMAIL.test(t), `accepted a non-address: ${t}`);
  }
});

console.log('\nthe questions themselves');

it('the platform question lists every option and says why it is asked', () => {
  const q = intake.askPlatform();
  for (const [, label] of intake.PLATFORMS) assert.ok(q.includes(label), `missing option: ${label}`);
  assert.match(q, /build next/i);
  // Somebody answering Discord must not think they are choosing how onboarding
  // works, which happens over text regardless.
  assert.match(q, /over text/i);
});

it('each question offers the way out', () => {
  assert.match(intake.askName(), /skip/i);
  assert.match(intake.askEmail('Chris'), /skip/i);
});

console.log(`\n${pass} passing`);
