/**
 * Discord, as a MessagingProvider.
 *
 * The seam is two methods — send() and parseInbound() — and this implements
 * them the same way src/sendblue.js does, so nothing above it needs to know
 * which one a league is on.
 *
 * WHAT IS DIFFERENT FROM SMS, and matters upstream:
 *
 *   A CHAT ID IS A CHANNEL ID, not a group. One Discord server can hold several
 *   leagues in several channels, which the existing unique index on
 *   (provider, chat_id) already handles without a schema change.
 *
 *   A SENDER ID IS A SNOWFLAKE, not a phone. Nothing here normalises it into
 *   one — db.normalizePhone would happily mangle a numeric id into "+1..." and
 *   the result would look plausible in every log while matching nothing.
 *
 *   THERE IS A HARD LENGTH LIMIT. Discord rejects a message over 2000
 *   characters outright rather than truncating it, so a long recap would be
 *   lost rather than clipped. Measured on real traffic the longest message this
 *   product has ever sent is 654 characters, so this splitter should never fire
 *   — which is exactly why it is here rather than left as a known edge case
 *   nobody will remember when a twelve-team dynasty draft recap first runs long.
 */

const BASE = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';

/** Discord's own limit. Not a style choice — over this is a 400. */
const MAX_LEN = 2000;

/**
 * Permissions the bot asks for when it is added to a server.
 *
 * View Channels (1<<10) + Send Messages (1<<11) + Embed Links (1<<14)
 * + Read Message History (1<<16). Deliberately minimal: a bot requesting
 * Administrator is declined by any server admin paying attention, and they do
 * not tell you why — the invite simply never completes.
 */
const PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 14) | (1 << 16);   // 84992

/**
 * Split a long message on paragraph, then line, then hard.
 *
 * Splitting mid-sentence is worse than splitting late, so this prefers the
 * largest boundary that fits and only cuts blind when a single line is itself
 * over the limit.
 */
function split(text, max = MAX_LEN) {
  const body = String(text == null ? '' : text);
  if (body.length <= max) return [body];

  const parts = [];
  let rest = body;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // Prefer a blank line, then a newline, then a space. -1 from each means
    // no boundary in range, and the hard cut is the last resort.
    const at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = at > max * 0.5 ? at : max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

class DiscordProvider {
  constructor(token, { base = BASE } = {}) {
    if (!token) throw new Error('DiscordProvider needs a bot token');
    this.token = token;
    this.base = base;
  }

  async request(method, path, body, { retries = 2 } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    /*
     * Discord rate limits per route and TELLS YOU how long to wait. Honouring
     * that is the difference between a brief pause and being temporarily banned
     * from the endpoint — repeated 429s escalate to a global limit.
     */
    if (res.status === 429 && retries > 0) {
      const after = Number(res.headers.get('retry-after') || 1);
      await new Promise(r => setTimeout(r, Math.min(after * 1000, 10000)));
      return this.request(method, path, body, { retries: retries - 1 });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`discord ${method} ${path} failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /**
   * Post to a channel.
   *
   * Returns the LAST part's response when a message had to be split, matching
   * what the callers already do with a single send — they store one provider
   * message id, and the last part is the one a reply would attach to.
   */
  async send(chatId, text, opts = {}) {
    const parts = split(text);
    let last = null;
    for (const part of parts) {
      last = await this.request('POST', `/channels/${encodeURIComponent(chatId)}/messages`, {
        content: part,
        // Never let a recap notify @everyone because a team name contains it.
        allowed_mentions: { parse: [] },
        ...(opts.replyTo ? { message_reference: { message_id: opts.replyTo } } : {}),
      });
    }
    return last;
  }

  /**
   * A gateway MESSAGE_CREATE, or an interaction, as the shape inbound.js wants.
   *
   * Bot messages are dropped here rather than upstream: the bot sees its own
   * posts echoed back by the gateway, and a loop that answers itself is the
   * single most expensive bug this could ship with.
   */
  parseInbound(body) {
    const d = body?.d || body;
    if (!d || !d.channel_id) return null;
    if (d.author?.bot) return null;

    return {
      type: 'message.received',
      chatId: String(d.channel_id),
      senderId: d.author?.id ? String(d.author.id) : null,
      senderName: d.member?.nick || d.author?.global_name || d.author?.username || null,
      text: d.content || '',
      messageId: d.id ? String(d.id) : null,
      isGroup: true,
      protocol: 'discord',
      occurredAt: d.timestamp || new Date().toISOString(),
      raw: body,
    };
  }

  /**
   * Everybody in a server, for the roster pre-fill.
   *
   * Needs the GUILD_MEMBERS privileged intent, which Discord reviews past 100
   * servers. The nickname is preferred upstream over the username because it is
   * the name their league actually calls them.
   */
  async guildMembers(guildId, { limit = 1000 } = {}) {
    const rows = await this.request(
      'GET', `/guilds/${encodeURIComponent(guildId)}/members?limit=${limit}`);
    return (rows || [])
      .filter(m => !m.user?.bot)
      .map(m => ({
        id: String(m.user.id),
        username: m.user.username,
        nickname: m.nick || m.user.global_name || m.user.username,
      }));
  }

  /** Which server a channel belongs to — the setup command carries both. */
  channel(channelId) {
    return this.request('GET', `/channels/${encodeURIComponent(channelId)}`);
  }
}

/**
 * The "Add Commish to your Discord" URL.
 *
 * `state` is carried through Discord and handed back on the redirect, so it
 * does double duty: CSRF protection, and the only thing tying the authorize
 * click to the league it was started from. It is a signed token from
 * onboardlink.js rather than a raw id, because this parameter is visible in a
 * browser address bar and gets pasted into group chats.
 */
function inviteUrl({ state = null, clientId = process.env.DISCORD_CLIENT_ID } = {}) {
  if (!clientId) return null;
  const q = new URLSearchParams({
    client_id: String(clientId),
    scope: 'bot applications.commands',
    permissions: String(PERMISSIONS),
  });
  if (state) q.set('state', state);
  return `https://discord.com/oauth2/authorize?${q}`;
}

module.exports = { DiscordProvider, inviteUrl, split, PERMISSIONS, MAX_LEN };
