/**
 * Linq Partner API v3 — a second MessagingProvider.
 *
 * Built but NOT active. Sendblue remains the primary transport; this exists so
 * that if Sendblue fails, changes terms, or loses the number, migration is an
 * afternoon rather than three weeks.
 *
 * Be clear about what a second provider does and does not buy you. The phone
 * number IS the identity of every group thread, so this is not failover — you
 * cannot flip a switch and keep the conversations. It is a tested migration
 * path. Every league would have to add a new number to their chat.
 *
 * Every field name below was measured against the live API on 2026-08-16, not
 * read from documentation. That distinction is load-bearing here: the original
 * Blooio adapter in this repo was written from docs, read `chat_id`/`from`
 * where the payload actually carried `external_id`/`sender`, and would have
 * dropped every inbound message with nothing logged.
 *
 * The one architectural difference from Sendblue: there is no global message
 * list. `GET /messages` returns 405. Inbound arrives by WEBHOOK, which is why
 * this provider declares inboundMode 'webhook' and the poller skips it.
 */

const crypto = require('crypto');
const { MessagingProvider } = require('./provider');

const LINQ_BASE = 'https://api.linqapp.com/api/partner/v3';

class LinqProvider extends MessagingProvider {
  constructor(apiKey, { base = LINQ_BASE, fromNumber = null } = {}) {
    super();
    if (!apiKey) throw new Error('LINQ_API_KEY is not set');
    this.apiKey = apiKey;
    this.base = base;
    this.fromNumber = fromNumber;
  }

  /**
   * Inbound transport. Sendblue is 'poll' because it does not fire webhooks for
   * group messages (measured); Linq is 'webhook' because it exposes no global
   * message list. The poller reads this rather than assuming everything polls.
   */
  get inboundMode() { return 'webhook'; }

  get name() { return 'linq'; }

  async request(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
    if (!res.ok) {
      const err = new Error(`Linq ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  requireFromNumber() {
    if (!this.fromNumber) throw new Error('LINQ_FROM_NUMBER is not set — every send needs a sending line');
    return this.fromNumber;
  }

  /** Post into an existing chat. chatId is Linq's chat UUID. */
  async send(chatId, text, opts = {}) {
    return this.request('POST', `/chats/${encodeURIComponent(chatId)}/messages`, {
      parts: [{ type: 'text', text }],
      ...(opts.effect ? { special_effects: opts.effect } : {}),
    });
  }

  /** 1:1 to a handle we may not have a chat with yet. */
  async sendDirect(handle, text) {
    return this.request('POST', '/messages', {
      to: handle,
      from: this.requireFromNumber(),
      parts: [{ type: 'text', text }],
    });
  }

  /**
   * Create a group.
   *
   * Documented limits, worth knowing before calling: the API accepts up to 31
   * recipients, but carriers cap MMS groups far lower — "most around 20, some
   * as few as 10". A 12-person league sits inside that warning band, and
   * behaviour in a mixed iPhone/Android group is undocumented. This is a
   * product risk, not a Linq one; Sendblue faces identical carrier physics.
   *
   * Also note: adding and removing participants afterwards is iMessage-only,
   * so a mixed group has to be assembled by a human in their own Messages app.
   * That is exactly what the onboarding flow already assumes.
   */
  async createGroup(numbers, { groupName = null } = {}) {
    const to = LinqProvider.assertGroupSize(numbers);
    return this.request('POST', '/chats', {
      to,
      from: this.requireFromNumber(),
      ...(groupName ? { group_name: groupName } : {}),
    });
  }

  /**
   * Validate a participant list. Separate from createGroup, and synchronous, so
   * the limits can be asserted without a network call — an async guard only
   * ever produces a rejected promise, which is easy to test wrongly and easy to
   * swallow at the call site.
   */
  static assertGroupSize(numbers) {
    const to = (numbers || []).map(n => String(n).trim()).filter(Boolean);
    if (to.length < 2) throw new Error('a group needs at least 2 recipients besides us');
    if (to.length > 31) throw new Error(`Linq accepts at most 31 recipients, got ${to.length}`);
    return to;
  }

  listChats(limit = 50, cursor = null) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return this.request('GET', `/chats?${q}`);
  }

  chatMessages(chatId, limit = 50) {
    return this.request('GET', `/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`);
  }

  listWebhooks() { return this.request('GET', '/webhook-subscriptions'); }

  createWebhook(targetUrl, events = ['message.received']) {
    return this.request('POST', '/webhook-subscriptions', {
      endpoint_url: targetUrl,
      target_url: targetUrl,      // the API has used both names; send both
      events,
      subscribed_events: events,
    });
  }

  deleteWebhook(id) { return this.request('DELETE', `/webhook-subscriptions/${encodeURIComponent(id)}`); }

  /**
   * Normalize an inbound webhook payload into the shape the rest of the system
   * expects. Field names measured, not assumed.
   *
   * Two fields here are better than anything Sendblue provides:
   *   is_from_me  — an explicit boolean, where the Sendblue path has to infer
   *                 direction, and inferring it wrong makes the bot answer
   *                 itself.
   *   reply_to    — a real reply reference. decide.js has carried a
   *                 `reply_to_bot` branch since it was written that has never
   *                 once fired, because Sendblue exposes no such thing.
   */
  parseInbound(body, eventType = 'message.received') {
    // Webhooks may wrap the message under `data` or `message`.
    const m = body?.data?.message || body?.message || body?.data || body;
    const service = String(m.service || m.preferred_service || '').toLowerCase();

    return {
      type: body?.event || eventType,
      chatId: m.chat_id,
      senderId: m.from_handle || m.from,
      text: textOf(m.parts),
      // A 1:1 chat and a group are distinguished on the chat, not the message,
      // so trust an explicit flag when the payload carries one and fall back to
      // participant count.
      isGroup: typeof m.is_group === 'boolean'
        ? m.is_group
        : (Array.isArray(m.handles) ? m.handles.length > 2 : Boolean(body?.chat?.is_group)),
      protocol: service === 'imessage' ? 'imessage' : service || null,
      messageId: m.id,
      ourNumber: this.fromNumber,
      // is_from_me is authoritative; never react to our own message.
      direction: m.is_from_me ? 'outbound' : 'inbound',
      replyToBot: Boolean(m.reply_to),
      replyToId: m.reply_to?.id || m.reply_to || null,
      deliveryStatus: m.delivery_status || null,
      timestamp: m.created_at ? Date.parse(m.created_at) : Date.now(),
      raw: body,
    };
  }

  /**
   * Verify a webhook signature.
   *
   * Without this the endpoint is an open door: anyone who learns the URL can
   * post a message claiming to be from any number, and the bot would answer it
   * with league data. Timing-safe comparison, and a timestamp window so a
   * captured payload cannot be replayed forever.
   */
  static verifySignature(rawBody, signatureHeader, signingSecret, { toleranceMs = 5 * 60 * 1000, now = Date.now() } = {}) {
    if (!signingSecret || !signatureHeader) return false;

    // Accept both `t=…,v1=…` and a bare hex digest.
    const parts = String(signatureHeader).split(',').reduce((acc, p) => {
      const [k, v] = p.split('=');
      if (k && v) acc[k.trim()] = v.trim();
      return acc;
    }, {});
    const provided = parts.v1 || parts.signature || String(signatureHeader).trim();
    const ts = parts.t ? Number(parts.t) * (String(parts.t).length > 10 ? 1 : 1000) : null;

    if (ts && Math.abs(now - ts) > toleranceMs) return false;

    const secret = signingSecret.replace(/^whsec_/, '');
    const signedPayload = ts ? `${parts.t}.${rawBody}` : rawBody;

    // The secret is documented as "whsec_ prefix + base64", but a base64 string
    // is also valid UTF-8, so which one Linq actually keys the HMAC with is not
    // determinable from the docs. Both are tried and every comparison is
    // timing-safe. Each candidate is computed fresh — an HMAC object cannot be
    // digested twice.
    const candidates = [];
    for (const key of [Buffer.from(secret, 'base64'), Buffer.from(secret, 'utf8')]) {
      for (const enc of ['hex', 'base64']) {
        candidates.push(crypto.createHmac('sha256', key).update(signedPayload, 'utf8').digest(enc));
      }
    }
    // Compare against all of them rather than returning early, so the work done
    // does not depend on which candidate matched.
    return candidates.reduce((found, c) => safeEqual(c, provided) || found, false);
  }
}

function textOf(parts) {
  if (!Array.isArray(parts)) return typeof parts === 'string' ? parts : '';
  return parts
    .filter(p => (p.type === 'text' || p.type === undefined) && (p.text || p.body))
    .map(p => p.text || p.body)
    .join('\n')
    .trim();
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

module.exports = { LinqProvider, LINQ_BASE, textOf };
