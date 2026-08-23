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

// The account quickstart specifies api.sendblue.co. (api.sendblue.com also
// answers, but .co is what Sendblue documents for this account.)
const SENDBLUE_BASE = 'https://api.sendblue.co';

class SendblueProvider extends MessagingProvider {
  constructor(keyId, secretKey, { base = SENDBLUE_BASE, fromNumber = null } = {}) {
    super();
    if (!keyId || !secretKey) {
      throw new Error('SENDBLUE_API_KEY_ID and SENDBLUE_API_SECRET_KEY must both be set');
    }
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.base = base;
    // Required on sends. Get it from `sendblue lines`.
    this.fromNumber = fromNumber;
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

  /** Sendblue rejects any send without from_number — fail before the round trip. */
  requireFromNumber() {
    if (this.fromNumber) return;
    throw new Error(
      'SENDBLUE_FROM_NUMBER is not set in .env.\n' +
      '  Sendblue requires from_number on every send.\n' +
      '  Get your line:  sendblue lines      (or Dashboard -> Phone Lines)\n' +
      '  Then add to .env:  SENDBLUE_FROM_NUMBER=+1XXXXXXXXXX'
    );
  }

  /** chatId is either a phone number (1:1) or a Sendblue group_id. */
  /**
   * Send, refusing anything addressed to a number that opted out.
   *
   * The provider already blocks these at its own layer, so this is belt and
   * braces — but a suppression list held only by a vendor is lost the day you
   * change vendors, and "our provider handles it" is a weak answer to a carrier
   * reviewer. Group sends are not checked: a group id is not a person, and the
   * opt-out remedy there is leaving the chat.
   */
  async send(chatId, text, opts = {}) {
    if (!this.looksLikeGroupId(chatId) && !opts.force) {
      try {
        const db = require('./db');
        if (await db.isSuppressed(chatId)) {
          const err = new Error(`refusing to send: ${chatId} has opted out`);
          err.suppressed = true;
          throw err;
        }
      } catch (err) {
        if (err.suppressed) throw err;
        // A database blip must not stop the bot messaging its leagues; the
        // provider is still enforcing suppression underneath.
        console.error('[sendblue] suppression check failed:', err.message);
      }
    }
    return this.sendUnchecked(chatId, text, opts);
  }

  async sendUnchecked(chatId, text, opts = {}) {
    this.requireFromNumber();
    const isGroup = this.looksLikeGroupId(chatId);
    const path = isGroup ? '/api/send-group-message' : '/api/send-message';
    const body = isGroup
      ? { group_id: chatId, content: text }
      : { number: chatId, content: text };
    // from_number is REQUIRED on sends — omitting it fails every call.
    if (this.fromNumber) body.from_number = this.fromNumber;
    if (opts.statusCallback) body.status_callback = opts.statusCallback;
    if (opts.sendStyle) body.send_style = opts.sendStyle;
    // Attachments. The only current use is the bot's own contact card, which is
    // how a group learns that the number texting them has a name.
    if (opts.mediaUrl) body.media_url = opts.mediaUrl;
    return this.recorded(chatId, isGroup, opts, () => this.request('POST', path, body));
  }

  /*
   * Run a send and record what happened, either way.
   *
   * Here rather than at the call sites because sendUnchecked is the single
   * funnel every send passes through, and the call sites are the problem: each
   * one catches failure differently and the signup path threw its reason away
   * entirely. One place, one row per attempt.
   *
   * The recording never changes the outcome. It is awaited so the row exists
   * before the caller reacts, but a failure to write it is swallowed — losing
   * a metric must not turn a working send into a failed one, and it must not
   * turn a failed send into a different error than the one that happened.
   */
  async recorded(chatId, isGroup, opts, run) {
    const row = { chatId, isGroup, leagueId: opts.leagueId || null, isRetry: Boolean(opts.isRetry) };
    try {
      const res = await run();
      // Sendblue can answer HTTP 200 with {"status":"ERROR"}; request() already
      // throws on that, so anything arriving here was ACCEPTED. Accepted is not
      // delivered: a group reply recorded here as ok/QUEUED later failed at the
      // device layer with "could not determine target service for group", and
      // nothing in this system knew. The handle is what makes the difference
      // findable afterwards.
      await this.logSend({ ...row, ok: true, status: res?.status || 'accepted',
        messageHandle: res?.message_handle || res?.id || null });
      return res;
    } catch (err) {
      await this.logSend({ ...row, ok: false, status: null, error: err.message });
      // send_log answers "how many sends failed"; error_log answers "what is
      // failing across the whole system right now". Same event, two questions.
      require('./errorlog').record({
        system: 'sendblue', operation: isGroup ? 'send-group' : 'send',
        message: err.message, leagueId: row.leagueId,
      });
      throw err;
    }
  }

  async logSend({ chatId, isGroup, leagueId, ok, status, error, messageHandle = null, isRetry = false }) {
    try {
      const db = require('./db');
      await db.query(
        `insert into send_log (league_id, chat_id, is_group, ok, status, error, message_handle, is_retry)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [leagueId, chatId || null, Boolean(isGroup), ok, status || null,
         error ? String(error).slice(0, 500) : null, messageHandle, Boolean(isRetry)]
      );
    } catch (err) {
      console.error('[sendblue] could not record send outcome:', err.message);
    }
  }

  /** Create a group by sending its first message to a list of numbers. */
  async sendNewGroup(numbers, text, opts = {}) {
    this.requireFromNumber();
    const body = { numbers, content: text };
    if (this.fromNumber) body.from_number = this.fromNumber;
    if (opts.statusCallback) body.status_callback = opts.statusCallback;
    // Creating a group is a send too, and it is the one most likely to fail in
    // a way nobody notices — there is no thread yet to look at.
    return this.recorded(numbers.join(','), true, opts,
      () => this.request('POST', '/api/send-group-message', body));
  }

  /** Free tier caps at 10 verified contacts; these manage that list. */
  /**
   * How inbound arrives. Sendblue does not fire webhooks for GROUP messages
   * (measured 2026-08-15), and this product lives in a group, so polling is the
   * transport rather than a fallback. Linq is the opposite — see src/linq.js.
   */
  get inboundMode() { return 'poll'; }
  get name() { return 'sendblue'; }

  /**
   * One page of recent messages, newest first.
   *
   * This lived in poller.js as a hardcoded '/api/v2/messages?limit=&offset='
   * until a second provider made the leak obvious: the poller is supposed to be
   * provider-agnostic, and it was reaching into Sendblue's URL space.
   */
  async fetchMessages({ limit = 50, offset = 0 } = {}) {
    const res = await this.request('GET', `/api/v2/messages?limit=${limit}&offset=${offset}`);
    return {
      messages: res?.messages || res?.data || (Array.isArray(res) ? res : []),
      total: res?.pagination?.total ?? null,
    };
  }

  listContacts() { return this.request('GET', '/api/v2/contacts'); }
  listLines() { return this.request('GET', '/api/lines'); }

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
