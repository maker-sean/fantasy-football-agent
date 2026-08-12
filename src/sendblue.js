/**
 * Sendblue implementation of MessagingProvider.
 *
 * This class exists to test one hypothesis: that mixed-device group sending
 * fails on Blooio for a provider-specific reason rather than a structural one.
 * Nothing above this file changes to run that test — which is the entire
 * argument for the adapter seam.
 *
 * Sendblue's shapes differ substantially from Blooio's:
 *   auth      two headers (sb-api-key-id + sb-api-secret-key), not a Bearer token
 *   send      POST /api/send-message      { number, content }
 *   group     POST /api/send-group-message { numbers: [...], content } -> group_id
 *             follow-ups reuse { group_id, content } — no numbers
 *   lookup    GET  /api/evaluate-service?number=+1...
 *   inbound   { from_number, to_number, content, media_url, service, group_id, date_sent }
 *
 * Note there is no `event` field on inbound — unlike Blooio, Sendblue posts
 * message webhooks and status callbacks to separate URLs, so the receiver has
 * to supply the event type from the route it arrived on.
 */

const { MessagingProvider } = require('./provider');

const SENDBLUE_BASE = 'https://api.sendblue.com';

class SendblueProvider extends MessagingProvider {
  constructor(keyId, secretKey, { base = SENDBLUE_BASE } = {}) {
    super();
    if (!keyId || !secretKey) {
      throw new Error('SENDBLUE_API_KEY_ID and SENDBLUE_API_SECRET_KEY must both be set');
    }
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.base = base;
  }

  get headers() {
    return {
      'sb-api-key-id': this.keyId,
      'sb-api-secret-key': this.secretKey,
      'Content-Type': 'application/json',
    };
  }

  async request(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let json;
    try { json = raw ? JSON.parse(raw) : {}; } catch { json = { _raw: raw }; }

    // Sendblue can return HTTP 200 with {"status":"ERROR"} in the body, so an
    // ok status code is not sufficient evidence the call succeeded.
    const softError = json?.status === 'ERROR';
    if (!res.ok || softError) {
      const err = new Error(
        `Sendblue ${method} ${path} -> ${res.status}${softError ? ' (status:ERROR)' : ''}: ${raw.slice(0, 400)}`
      );
      err.status = res.status;
      err.body = json;
      err.code = json?.error_code;
      throw err;
    }
    return json;
  }

  /** chatId is either a phone number (1:1) or a Sendblue group_id. */
  async send(chatId, text, opts = {}) {
    const isGroup = this.looksLikeGroupId(chatId);
    const path = isGroup ? '/api/send-group-message' : '/api/send-message';
    const body = isGroup
      ? { group_id: chatId, content: text }
      : { number: chatId, content: text };
    if (opts.statusCallback) body.status_callback = opts.statusCallback;
    return this.request('POST', path, body);
  }

  /** Create a group by sending its first message to a list of numbers. */
  async sendNewGroup(numbers, text, opts = {}) {
    const body = { numbers, content: text };
    if (opts.statusCallback) body.status_callback = opts.statusCallback;
    return this.request('POST', '/api/send-group-message', body);
  }

  looksLikeGroupId(chatId) {
    const s = String(chatId || '');
    return s.length > 0 && !s.startsWith('+') && !s.includes('@');
  }

  /** Returns the transport Sendblue thinks a number supports. */
  evaluateService(number) {
    return this.request('GET', `/api/evaluate-service?number=${encodeURIComponent(number)}`);
  }

  /**
   * Sendblue posts inbound messages and status callbacks to different URLs and
   * does not stamp an event type in the body, so the caller passes it in.
   */
  parseInbound(body, eventType = 'message.received') {
    const service = String(body.service || '').toLowerCase(); // iMessage|SMS|RCS
    return {
      type: eventType,
      chatId: body.group_id || body.from_number,
      senderId: body.from_number,
      text: body.content,
      isGroup: Boolean(body.group_id),
      protocol: service === 'imessage' ? 'imessage' : service,
      messageId: body.message_handle || body.id,
      ourNumber: body.to_number,
      timestamp: body.date_sent ? Date.parse(body.date_sent) : Date.now(),
      raw: body,
    };
  }
}

module.exports = { SendblueProvider, SENDBLUE_BASE };
