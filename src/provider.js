/**
 * The provider seam — the swappable part.
 *
 * Agent logic and league logic must NEVER import Blooio directly. Only
 * BlooioProvider touches Blooio. Swapping to Sendblue / Linq / Twilio later
 * is one new class implementing MessagingProvider.
 */

const crypto = require('crypto');

const BLOOIO_BASE = 'https://api.blooio.com/v2/api';

/** Common event shape every provider normalizes into. */
class MessagingProvider {
  async send(chatId, text, opts = {}) { throw new Error('not implemented'); }
  parseInbound(body) { throw new Error('not implemented'); }
}

class BlooioProvider extends MessagingProvider {
  constructor(apiKey, { base = BLOOIO_BASE } = {}) {
    super();
    if (!apiKey) throw new Error('BLOOIO_API_KEY is not set');
    this.apiKey = apiKey;
    this.base = base;
  }

  async request(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
    if (!res.ok) {
      const err = new Error(`Blooio ${method} ${path} -> ${res.status}: ${text}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  async send(chatId, text, opts = {}) {
    const id = encodeURIComponent(chatId);
    const res = await fetch(`${this.base}/chats/${id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        // Blooio (or our own retry) can replay a send; this collapses duplicates.
        'Idempotency-Key': opts.idempotencyKey || crypto.randomUUID(),
      },
      body: JSON.stringify({ text }),
    });
    // 202 = queued asynchronously. It does NOT mean delivered — delivery lands
    // later as a message.status webhook.
    if (res.status !== 202) {
      throw new Error(`Blooio send failed ${res.status}: ${await res.text()}`);
    }
    return res.json().catch(() => ({}));
  }

  /**
   * Field names verified against docs.blooio.com (v2), Twilio-integration
   * example payload:
   *   { event, message_id, external_id, internal_id, protocol, text, sender,
   *     is_group, timestamp }
   *
   * NOTE: what `external_id` contains for a GROUP message is the open question
   * Milestone 0 exists to answer. Everything downstream keys off `chatId`, so
   * if that assumption is wrong this is the one function that changes.
   */
  parseInbound(body) {
    return {
      type: body.event,                       // 'message.received' | 'message.status' | ...
      chatId: body.external_id,               // counterpart: phone / email / group ref
      senderId: body.sender,                  // individual human who sent it
      text: body.text,
      isGroup: Boolean(body.is_group),
      protocol: body.protocol,                // 'imessage' | 'sms' | 'rcs' — the M0 signal
      messageId: body.message_id,
      ourNumber: body.internal_id,
      timestamp: body.timestamp,
      raw: body,
    };
  }

  // ---- group / capability surface (used by scripts/, not by the agent) ----

  createGroup({ name, chatGuid, members }) {
    const body = { name };
    if (chatGuid) body.chat_guid = chatGuid;   // join an existing iMessage thread
    if (members) body.members = members;       // bookkeeping only — does NOT add to the real chat
    return this.request('POST', '/groups', body);
  }

  listGroups() { return this.request('GET', '/groups'); }

  getGroup(groupId) { return this.request('GET', `/groups/${encodeURIComponent(groupId)}`); }

  listGroupMembers(groupId) {
    return this.request('GET', `/groups/${encodeURIComponent(groupId)}/members`);
  }

  capabilities(contactId) {
    return this.request('GET', `/contacts/${encodeURIComponent(contactId)}/capabilities`);
  }
}

module.exports = { MessagingProvider, BlooioProvider, BLOOIO_BASE };
