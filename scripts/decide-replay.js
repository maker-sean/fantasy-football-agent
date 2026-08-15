#!/usr/bin/env node
/**
 * Dry-run the reply decision over real stored messages. Sends nothing.
 *
 * This is the tuning surface. You already have real group traffic in Postgres,
 * so the honest question — "would this bot have been annoying?" — is answerable
 * before it ever speaks. Tuning a chattiness threshold against live humans is
 * expensive and, if you get it wrong, unrecoverable.
 *
 * Usage:
 *   node scripts/decide-replay.js
 *   node scripts/decide-replay.js --chat sb_group_...
 *   node scripts/decide-replay.js --names bot,commish,kings
 *   node scripts/decide-replay.js --quiet-ms 8000 --verbose
 */

require('dotenv').config();
const db = require('../src/db');
const { decide } = require('../src/decide');

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null; };
const has = n => argv.includes(`--${n}`);

const chatFilter = flag('chat');
const quietMs = Number(flag('quiet-ms') || 8000);
const botNames = (flag('names') || 'bot,commish').split(',').map(s => s.trim()).filter(Boolean);

(async () => {
  const { rows } = await db.query(
    `select m.provider, m.chat_id, m.provider_message_id, m.direction, m.sender_phone,
            m.is_group, m.protocol, m.body, m.occurred_at, m.league_id,
            l.name as league_name, l.config as league_config
     from messages m left join leagues l on l.id = m.league_id
     ${chatFilter ? 'where m.chat_id = $1' : ''}
     order by m.chat_id, m.occurred_at`,
    chatFilter ? [chatFilter] : []
  );

  if (!rows.length) {
    console.log('No stored messages to replay. Run the poller and have someone talk.');
    return;
  }

  // Group into bursts the way BurstCollector would: a gap larger than quietMs
  // between consecutive inbound messages starts a new burst.
  const byChat = new Map();
  for (const r of rows) {
    if (!byChat.has(r.chat_id)) byChat.set(r.chat_id, []);
    byChat.get(r.chat_id).push(r);
  }

  const totals = { bursts: 0, replies: 0, byReason: new Map() };

  for (const [chatId, msgs] of byChat) {
    const league = { name: msgs[0].league_name, config: msgs[0].league_config || {} };
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${chatId}   ${league.name || '(unrouted)'}   ${msgs.length} messages`);
    console.log('='.repeat(70));

    let burst = [];
    let lastAt = null;

    const evaluate = async () => {
      if (!burst.length) return;
      const now = burst[burst.length - 1].timestamp;

      // Replay state from messages strictly BEFORE this burst — using the whole
      // table would let the bot see its own future replies.
      const prior = msgs.filter(m => new Date(m.occurred_at).getTime() < burst[0].timestamp);
      const state = replayState(prior, now);

      const verdict = decide({
        burst,
        state,
        league,
        overrides: { botNames },
      });

      totals.bursts += 1;
      if (verdict.reply) totals.replies += 1;
      totals.byReason.set(verdict.reason, (totals.byReason.get(verdict.reason) || 0) + 1);

      const when = new Date(now).toISOString().replace('T', ' ').slice(5, 16);
      const mark = verdict.reply ? 'REPLY ' : '  .   ';
      if (verdict.reply || has('verbose')) {
        console.log(`${mark} ${when}  [${burst.length} msg, temp=${state.temperature}]  ${verdict.layer}/${verdict.reason}`);
        for (const b of burst) {
          console.log(`         ${String(b.senderId || '').slice(-4)}: ${JSON.stringify(String(b.text || '').slice(0, 62))}`);
        }
      }
      burst = [];
    };

    for (const r of msgs) {
      const at = new Date(r.occurred_at).getTime();
      if (r.direction === 'outbound') { await evaluate(); lastAt = at; continue; }
      if (lastAt != null && at - lastAt > quietMs) await evaluate();
      burst.push({
        chatId: r.chat_id,
        messageId: r.provider_message_id,
        senderId: r.sender_phone,
        text: r.body,
        protocol: r.protocol,
        isGroup: r.is_group,
        direction: r.direction,
        timestamp: at,
        raw: {},
      });
      lastAt = at;
    }
    await evaluate();
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`${totals.bursts} bursts evaluated, ${totals.replies} would have replied (${totals.bursts ? Math.round(100 * totals.replies / totals.bursts) : 0}%)`);
  console.log('\nby reason:');
  for (const [reason, n] of [...totals.byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  console.log('\nA high reply rate here is a warning, not a win. The bot should be');
  console.log('mostly silent; the number worth watching is whether it caught every');
  console.log('message that actually addressed it.');
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));

/** conversationState, computed from an in-memory slice instead of the DB. */
function replayState(prior, now) {
  const msgs = prior
    .map(r => ({ direction: r.direction, sender: r.sender_phone, at: new Date(r.occurred_at).getTime() }))
    .sort((a, b) => b.at - a.at);

  const MIN = 60 * 1000;
  const lastBot = msgs.find(m => m.direction === 'outbound') || null;
  const lastBotAt = lastBot ? lastBot.at : null;

  let botStreak = 0;
  for (const m of msgs) { if (m.direction === 'outbound') botStreak += 1; else break; }

  const recent = n => msgs.filter(m => m.direction === 'inbound' && now - m.at < n * MIN).length;
  const inbound5 = recent(5), inbound60 = recent(60);
  const distinct60 = new Set(
    msgs.filter(m => m.direction === 'inbound' && now - m.at < 60 * MIN).map(m => m.sender)
  ).size;

  return {
    now, totalSeen: msgs.length, lastBotAt,
    msSinceLastBot: lastBotAt == null ? null : now - lastBotAt,
    botStreak,
    humansSinceBot: lastBotAt
      ? msgs.filter(m => m.direction === 'inbound' && m.at > lastBotAt).length
      : msgs.filter(m => m.direction === 'inbound').length,
    sentInLastHour: msgs.filter(m => m.direction === 'outbound' && now - m.at < 60 * MIN).length,
    sentToday: msgs.filter(m => m.direction === 'outbound' && now - m.at < 24 * 60 * MIN).length,
    inbound5, inbound60, distinctSpeakers60: distinct60,
    temperature: inbound5 >= 4 && distinct60 >= 2 ? 'hot' : inbound60 >= 3 ? 'warm' : 'cold',
  };
}
