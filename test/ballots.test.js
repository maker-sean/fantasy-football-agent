#!/usr/bin/env node
/**
 * Ballots — the link crypto, and every rule the schema could not express.
 *
 * The DB half of this file exists because of one specific bug in the design
 * this replaced: UNIQUE(poll_id, voter, option_id) looks like it stops double
 * voting and does not. On a single-choice poll it happily lets one person cast
 * one vote for EVERY option, which at ten voters is enough to decide anything.
 * The first test below is that bug.
 */
require('dotenv').config();

// Set before anything reads it. A real secret is never needed to test the
// shape; a WRONG one is needed to test that verification actually rejects.
process.env.BALLOT_SECRET = 'test-secret-that-is-at-least-32-chars-long';

const assert = require('assert');
const ballotlink = require('../src/ballotlink');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const M = '1b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb60';

async function linkTests() {
  console.log('the link carries the voter, and proves we minted it');

  await it('round-trips the ballot and the member', () => {
    assert.deepStrictEqual(ballotlink.read(ballotlink.mint(B, M)), { ballotId: B, memberId: M });
  });

  await it('fits in a URL a group chat will not mangle', () => {
    assert.ok(ballotlink.mint(B, M).length <= 72, 'token is ' + ballotlink.mint(B, M).length);
  });

  await it('a flipped byte in the signature is rejected', () => {
    const t = ballotlink.mint(B, M);
    assert.strictEqual(ballotlink.read(t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA')), null);
  });

  await it('a swapped member id is rejected — the ids are inside the MAC', () => {
    // The attack this stops: take your own valid link and edit it to vote as
    // someone else. The body is signed, so editing it invalidates the tag.
    const mine = Buffer.from(ballotlink.mint(B, M), 'base64url');
    const forged = Buffer.from(mine);
    forged[20] ^= 0xff;                         // a byte inside the member id
    assert.strictEqual(ballotlink.read(forged.toString('base64url')), null);
  });

  await it('a token signed with another secret is rejected', () => {
    const t = ballotlink.mint(B, M);
    const real = process.env.BALLOT_SECRET;
    process.env.BALLOT_SECRET = 'a-completely-different-secret-32-chars';
    const got = ballotlink.read(t);
    process.env.BALLOT_SECRET = real;
    assert.strictEqual(got, null);
  });

  await it('garbage returns null rather than throwing at a stranger', () => {
    for (const junk of ['', 'x', '../../etc/passwd', 'a'.repeat(500), null, undefined]) {
      assert.strictEqual(ballotlink.read(junk), null, JSON.stringify(junk));
    }
  });

  await it('minting without a secret fails loudly, reading fails quietly', () => {
    const real = process.env.BALLOT_SECRET;
    delete process.env.BALLOT_SECRET;
    // Loud on the way out: a link signed with a default key is forgeable and
    // nothing about it would look wrong.
    assert.throws(() => ballotlink.mint(B, M), /BALLOT_SECRET/);
    // Quiet on the way in: this runs on a public route strangers will hit.
    assert.strictEqual(ballotlink.read('anything'), null);
    process.env.BALLOT_SECRET = real;
  });
}

async function dbTests() {
  const db = require('../src/db');
  const ballots = require('../src/ballots');
  const { app } = require('../web/server');

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };

  const { rows: [league] } = await db.query(
    `insert into leagues (name, provider) values ('ballot-test-league','sendblue') returning *`);
  const { rows: [other] } = await db.query(
    `insert into leagues (name, provider) values ('ballot-test-other','sendblue') returning *`);

  const mk = async (lg, n) => (await db.query(
    `insert into members (league_id, phone, display_name) values ($1,$2,$3) returning *`,
    [lg.id, '+1555000' + String(n).padStart(4, '0'), 'Voter ' + n])).rows[0];

  const members = [];
  for (let i = 1; i <= 4; i++) members.push(await mk(league, i));
  const outsider = await mk(other, 9);

  const opts = [{ label: 'Snake', emoji: '🐍' }, { label: 'Linear', emoji: '📏' },
                { label: 'Auction', emoji: '🔨' }];

  try {
    console.log('\none member, one vote — the constraint the schema cannot express');

    await it('a second choice REPLACES the first, it does not add to it', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Draft format?', options: opts });
      const o = await ballots.optionsFor(b.id);

      await ballots.castVote(b.id, members[0].id, [o[0].id]);
      await ballots.castVote(b.id, members[0].id, [o[1].id]);

      const t = await ballots.tally(b.id);
      assert.strictEqual(t.voters, 1, 'still one voter');
      assert.strictEqual(t.options.reduce((s, x) => s + x.votes, 0), 1,
        'one person must never hold two votes — this is the bug the old UNIQUE allowed');
      assert.strictEqual(t.options.find(x => x.id === o[1].id).votes, 1, 'the newer choice wins');
    });

    await it('tapping the same option twice is idempotent', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Again?', options: opts });
      const o = await ballots.optionsFor(b.id);
      await ballots.castVote(b.id, members[0].id, [o[0].id]);
      const second = await ballots.castVote(b.id, members[0].id, [o[0].id]);
      assert.strictEqual(second.ok, true, 'a double tap is not an error');
      assert.strictEqual((await ballots.tally(b.id)).voters, 1);
    });

    await it('a single-choice ballot refuses two options at once', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'One only', options: opts });
      const o = await ballots.optionsFor(b.id);
      const r = await ballots.castVote(b.id, members[0].id, [o[0].id, o[1].id]);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'too_many_choices');
    });

    await it('an option belonging to a DIFFERENT ballot is refused', async () => {
      // A foreign key does not catch this: the id is a real ballot_options row,
      // just not one of this ballot's.
      const a = await ballots.open({ leagueId: league.id, question: 'A', options: opts });
      const b = await ballots.open({ leagueId: league.id, question: 'B', options: opts });
      const foreign = (await ballots.optionsFor(a.id))[0];
      const r = await ballots.castVote(b.id, members[0].id, [foreign.id]);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'bad_choice');
      assert.strictEqual((await ballots.tally(b.id)).voters, 0, 'nothing was recorded');
    });

    await it('a member of another league cannot vote, valid token or not', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Ours', options: opts });
      const o = await ballots.optionsFor(b.id);
      const r = await ballots.castVote(b.id, outsider.id, [o[0].id]);
      assert.strictEqual(r.error, 'not_eligible');
    });

    console.log('\nresults do not leak before the vote closes');

    await it('an after_close ballot returns null results while open, even to a voter', async () => {
      const b = await ballots.open({
        leagueId: league.id, question: 'Veto this trade?', kind: 'veto',
        options: [{ label: 'Allow' }, { label: 'Veto' }],
      });
      const o = await ballots.optionsFor(b.id);
      await ballots.castVote(b.id, members[0].id, [o[0].id]);

      const v = await ballots.view(b.id, members[0].id);
      assert.strictEqual(v.results, null, 'null, not zeroed — a client cannot render null as 0%');
      assert.strictEqual(v.voted, 1, 'how many voted is still visible');
      assert.strictEqual(v.eligible, 4);
      assert.strictEqual(v.you.hasVoted, true);
    });

    await it('closing reveals them', async () => {
      const b = await ballots.open({
        leagueId: league.id, question: 'Reveal', kind: 'veto',
        options: [{ label: 'Allow' }, { label: 'Veto' }],
      });
      const o = await ballots.optionsFor(b.id);
      await ballots.castVote(b.id, members[0].id, [o[1].id]);
      await ballots.close(b.id, 'manual');

      const v = await ballots.view(b.id, members[0].id);
      assert.ok(Array.isArray(v.results), 'results appear once closed');
      assert.strictEqual(v.results.find(r => r.id === o[1].id).votes, 1);
    });

    await it('a live ballot shows the split immediately', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Dinner?', options: opts,
        resultsVisible: 'live' });
      const o = await ballots.optionsFor(b.id);
      await ballots.castVote(b.id, members[0].id, [o[0].id]);
      const v = await ballots.view(b.id, members[1].id);
      assert.ok(Array.isArray(v.results));
      assert.strictEqual(v.results.find(r => r.id === o[0].id).percentage, 100);
    });

    console.log('\nclosing, quorum and ties');

    await it('everyone voting closes it without waiting for the deadline', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'All in', options: opts });
      const o = await ballots.optionsFor(b.id);
      for (const m of members.slice(0, 3)) await ballots.castVote(b.id, m.id, [o[0].id]);
      assert.strictEqual((await ballots.byId(b.id)).closed_at, null, 'three of four is not everyone');

      const last = await ballots.castVote(b.id, members[3].id, [o[0].id]);
      assert.strictEqual(last.closed, true);
      assert.ok((await ballots.byId(b.id)).closed_at, 'the fourth vote closed it');
    });

    await it('a closed ballot refuses a late vote', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Too late', options: opts });
      const o = await ballots.optionsFor(b.id);
      await ballots.close(b.id, 'manual');
      const r = await ballots.castVote(b.id, members[0].id, [o[0].id]);
      assert.strictEqual(r.error, 'closed');
    });

    await it('a deadline in the past closes on the next sweep', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Expired', options: opts });
      await db.query(`update ballots set closes_at = now() - interval '1 minute' where id = $1`, [b.id]);
      const r = await ballots.castVote(b.id, members[0].id, [(await ballots.optionsFor(b.id))[0].id]);
      assert.strictEqual(r.error, 'closed', 'past its deadline counts as closed before the sweep runs');
      const swept = await ballots.closeDue();
      assert.ok(swept.some(x => x.id === b.id));
    });

    await it('a tie is reported as a tie, with no winner invented', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Split', options: opts, quorum: 2 });
      const o = await ballots.optionsFor(b.id);
      await ballots.castVote(b.id, members[0].id, [o[0].id]);
      await ballots.castVote(b.id, members[1].id, [o[1].id]);

      const closed = await ballots.byId(b.id);
      assert.ok(closed.closed_at, 'quorum of two closed it');
      assert.strictEqual(closed.outcome.tie, true);
      assert.strictEqual(closed.outcome.winner, null,
        'breaking a tie by sort order would be a rule the league never agreed to');
    });

    await it('percentages are of voters, not of votes cast', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Which nights work?',
        options: opts, kind: 'date', maxChoices: 3, resultsVisible: 'live' });
      const o = await ballots.optionsFor(b.id);
      // Two people, each picking two of three. "Of votes cast" would report 50%
      // for options that literally everyone who voted said yes to.
      await ballots.castVote(b.id, members[0].id, [o[0].id, o[1].id]);
      await ballots.castVote(b.id, members[1].id, [o[0].id, o[2].id]);

      const v = await ballots.view(b.id, members[0].id);
      assert.strictEqual(v.results.find(r => r.id === o[0].id).percentage, 100,
        'both voters picked it, so it has 100% support');
      assert.strictEqual(v.results.find(r => r.id === o[1].id).percentage, 50);
    });

    console.log('\nthe HTTP surface');

    await it('a forged token is a 404, not a 401', async () => {
      const r = await call('GET', '/api/v/' + 'A'.repeat(64));
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.body.error, 'not_found', 'never confirms which half was wrong');
    });

    await it('a real link renders the ballot for that member by name', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Over HTTP?', options: opts,
        resultsVisible: 'live' });
      const token = ballotlink.mint(b.id, members[0].id);
      const r = await call('GET', '/api/v/' + token);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.question, 'Over HTTP?');
      assert.strictEqual(r.body.you.name, 'Voter 1');
      assert.strictEqual(r.body.options.length, 3);
    });

    await it('posting a vote returns the updated view', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'POST?', options: opts,
        resultsVisible: 'live' });
      const o = await ballots.optionsFor(b.id);
      const token = ballotlink.mint(b.id, members[0].id);
      const r = await call('POST', `/api/v/${token}/vote`, { options: [o[2].id] });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.you.choices, [o[2].id]);
      assert.strictEqual(r.body.results.find(x => x.id === o[2].id).votes, 1);
    });

    await it('voting into a closed ballot is a 409, distinguishable from a bad request', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Shut', options: opts });
      const o = await ballots.optionsFor(b.id);
      await ballots.close(b.id, 'manual');
      const r = await call('POST', `/api/v/${ballotlink.mint(b.id, members[0].id)}/vote`,
        { options: [o[0].id] });
      assert.strictEqual(r.status, 409);
    });

    await it('every eligible member gets exactly one distinct link', async () => {
      const b = await ballots.open({ leagueId: league.id, question: 'Fanout', options: opts });
      const ls = await ballots.links(b.id);
      assert.strictEqual(ls.length, 4);
      assert.strictEqual(new Set(ls.map(l => l.url)).size, 4, 'no two members share a link');
      for (const l of ls) {
        assert.deepStrictEqual(ballotlink.read(l.url.split('/').pop()),
          { ballotId: b.id, memberId: l.memberId });
      }
    });

  } finally {
    await db.query('delete from leagues where id = any($1::uuid[])', [[league.id, other.id]]);
    server.close();
    await db.pool.end();
  }
}

(async () => {
  await linkTests();
  if (!process.env.DATABASE_URL) {
    console.log('\n  SKIPPED the database half — no DATABASE_URL');
  } else {
    await dbTests();
  }
  console.log(`\n${pass} passing`);
})();
