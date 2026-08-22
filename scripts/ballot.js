#!/usr/bin/env node
/**
 * Open a ballot, look at one, close one — from a terminal.
 *
 * The CLI exists before any automatic trigger does, deliberately. Every other
 * feature in this repo got a script first and a cron second, because a job that
 * fires on its own into a live group chat is very hard to debug the first time
 * and trivial to debug the tenth.
 *
 *   npm run ballot -- open <league> "Question?" "Snake:🐍" "Linear:📏" [--veto] [--hours 24]
 *   npm run ballot -- show  <ballotId>
 *   npm run ballot -- links <ballotId>
 *   npm run ballot -- close <ballotId>
 *
 * <league> is a uuid or any unique part of the league name.
 */
require('dotenv').config();
const db = require('../src/db');
const ballots = require('../src/ballots');

const args = process.argv.slice(2);
const cmd = args.shift();

const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
};

async function resolveLeague(ref) {
  if (/^[0-9a-f-]{36}$/i.test(ref)) return db.leagueById(ref);
  const { rows } = await db.query('select * from leagues where name ilike $1', ['%' + ref + '%']);
  if (rows.length > 1) throw new Error(`"${ref}" matches ${rows.length} leagues: ` + rows.map(r => r.name).join(', '));
  return rows[0] || null;
}

async function main() {
  if (cmd === 'open') {
    const veto = Boolean(flag('veto', false));
    const live = Boolean(flag('live', false));
    const hours = Number(flag('hours', 24));
    const quorum = flag('quorum', null);

    const leagueRef = args.shift();
    const question = args.shift();
    // "Label:emoji" — the emoji is optional and last so a label may contain a colon.
    const options = args.map(a => {
      const m = /^(.*):(\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*)$/u.exec(a);
      return m ? { label: m[1], emoji: m[2] } : { label: a };
    });

    if (!leagueRef || !question || options.length < 2) {
      console.error('usage: npm run ballot -- open <league> "Question?" "Opt:🐍" "Opt:📏"');
      process.exit(1);
    }
    const league = await resolveLeague(leagueRef);
    if (!league) throw new Error('no league matching ' + leagueRef);

    const b = await ballots.open({
      leagueId: league.id, question, options,
      kind: veto ? 'veto' : 'poll',
      resultsVisible: live ? 'live' : undefined,
      quorum: quorum ? Number(quorum) : null,
      durationMinutes: Math.round(hours * 60),
      createdBy: 'cli',
    });

    console.log(`\n${league.name} — ${b.question}`);
    console.log(`  ballot ${b.id}`);
    console.log(`  ${b.kind}, results ${b.results_visible}, closes ${new Date(b.closes_at).toLocaleString()}\n`);

    const links = await ballots.links(b.id);
    if (!links.length) {
      // The common first-run surprise: a league whose members were never bound
      // has nobody to send a link to, and an empty fanout looks like a bug.
      console.log('  NOBODY IS ELIGIBLE. This league has no members with a bound phone,');
      console.log('  so there is nobody to send a link to. Bind them first: npm run link-member\n');
      return;
    }
    console.log('  Nothing has been sent. These are the links to fan out 1:1:\n');
    for (const l of links) console.log(`  ${(l.name || l.phone).padEnd(18)} ${l.url}`);
    console.log('');
    return;
  }

  if (cmd === 'links') {
    for (const l of await ballots.links(args[0])) {
      console.log(`${(l.name || l.phone).padEnd(18)} ${l.url}`);
    }
    return;
  }

  if (cmd === 'show') {
    const b = await ballots.byId(args[0]);
    if (!b) throw new Error('no such ballot');
    const t = await ballots.tally(b.id);
    const eligible = (await ballots.eligibleMembers(b.league_id)).length;
    console.log(`\n${b.question}`);
    console.log(`  ${b.closed_at ? 'CLOSED' : 'open'} · ${t.voters}/${eligible} voted · results ${b.results_visible}\n`);
    for (const o of ballots.withPercentages(t.options, t.voters).sort((a, c) => c.votes - a.votes)) {
      const bar = '█'.repeat(Math.round(o.percentage / 5)).padEnd(20, '░');
      console.log(`  ${bar} ${String(o.percentage).padStart(3)}%  ${o.emoji || ' '} ${o.label}`);
    }
    if (b.outcome) console.log('\n  outcome: ' + JSON.stringify(b.outcome.winner || (b.outcome.tie ? 'tie' : 'no votes')));
    console.log('');
    return;
  }

  if (cmd === 'close') {
    const b = await ballots.close(args[0], 'manual');
    if (!b) throw new Error('no such ballot');
    console.log(JSON.stringify(b.outcome, null, 2));
    // Deliberately does NOT announce. Sending the result into a live group chat
    // is a separate, deliberate act — see HANDOFF.
    console.log('\nNothing was sent to the group. Announce it yourself when you are ready.');
    return;
  }

  console.error('commands: open, show, links, close');
  process.exit(1);
}

main().catch(e => { console.error(e.message); process.exitCode = 1; })
      .finally(() => db.pool.end());
