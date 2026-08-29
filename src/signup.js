/**
 * "START <sleeper league id>" — the signup that arrives as a text message.
 *
 * The website's get-started flow validates a league against Sleeper in the
 * browser and then hands the visitor a pre-filled text. That text lands here,
 * through the poller that is already running, which is why this feature needed
 * no new service, no new hosting and no new secret.
 *
 * It is deliberately a queue rather than self-serve provisioning. Onboarding a
 * real league today is blocked on a messaging-plan contact cap and carrier
 * registration, and quietly signing people up for something that cannot be
 * delivered is worse than telling them they are in line.
 */

const db = require('./db');
const sleeper = require('./sleeper');

/**
 * The keyword shown on the site. One is displayed, several are accepted —
 * people retype from memory and will send whichever word they remember. Being
 * strict here costs a signup and teaches the sender nothing.
 *
 * STOP and HELP are carrier-reserved and deliberately absent.
 */
const KEYWORD = process.env.SIGNUP_KEYWORD || 'COMMISH';
const KEYWORDS = ['commish', 'draft', 'join', 'signup', 'start'];

/**
 * Matches "COMMISH 4F2K", "commish: 4f2k", "DRAFT 1400000000000000001", or the
 * keyword on its own.
 *
 * Both argument forms are accepted deliberately. A short code is what the site
 * issues now; a raw Sleeper league id is what the first version of this flow
 * told people to text, and anything already sent or screenshotted keeps working.
 */
const SIGNUP = new RegExp(
  `^\\s*(?:${KEYWORDS.join('|')})\\b[\\s:,-]*([A-Za-z0-9]{4,25})?\\s*$`, 'i'
);

/**
 * Words carriers reserve. They are handled at the network level and must never
 * be interpreted as anything else — not as a username, not as a league choice.
 */
const RESERVED = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|help|info)\s*$/i;

/** Unambiguous alphabet: no O/0, no I/1/L. It has to survive being read aloud. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 4;
const looksLikeLeagueId = v => /^[0-9]{6,25}$/.test(v);

function parse(text) {
  const m = SIGNUP.exec(String(text || ''));
  if (!m) return null;
  const arg = m[1] || null;
  if (!arg) return { leagueId: null, code: null };
  return looksLikeLeagueId(arg)
    ? { leagueId: arg, code: null }
    : { leagueId: null, code: arg.toUpperCase() };
}

function newCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Issue a code for a league the visitor just picked on the site. Retries on
 * collision — 30^4 is a large space but not an infinite one.
 */
async function issueCode({ sleeperLeagueId, league, profile = null }) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    const { rows } = await db.query(
      `insert into signup_codes (code, sleeper_league_id, league_name, season, total_rosters,
                                 first_name, last_name, email, platform, platform_other, plan)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (code) do nothing
       returning *`,
      [code, sleeperLeagueId, league?.name || null, league?.season || null, league?.total_rosters || null,
       profile?.firstName || null, profile?.lastName || null, profile?.email || null,
       profile?.platform || null, profile?.platformOther || null, profile?.plan || null]
    );
    if (rows[0]) return rows[0];
  }
  throw new Error('could not allocate a signup code');
}

async function resolveCode(code) {
  const { rows } = await db.query(
    'select * from signup_codes where code = $1', [String(code).toUpperCase()]
  );
  return rows[0] || null;
}

/**
 * Record a signup. Idempotent per (phone, league): texting START twice is a
 * person retrying, not a second lead.
 *
 * Returns { signup, created, league } — `league` is null when Sleeper does not
 * recognise the id, which is surfaced rather than stored as though it were fine.
 */
/**
 * Is this league already live on Commish AI?
 *
 * A twelve person league has twelve people who might text the code, and the
 * eleven who are not the commissioner should be told it is already set up
 * rather than parked on a waitlist for something they already have. The old
 * path put them in the queue, which meant the honest next step was inviting a
 * second person to onboard a league that was already onboarded.
 *
 * Checks the SEASON CHAIN, not just the id. Sleeper gives every season its own
 * league_id, so someone pasting last year's link is holding a different id for
 * the same league, and telling them it is unclaimed would be true of the id and
 * wrong about the league.
 */
async function alreadyOnboarded(leagueId) {
  if (!leagueId) return null;
  const direct = await db.liveLeagueBySleeperId(leagueId);
  if (direct) return direct;

  // The chain, in both directions: they may hold an older id than the live row,
  // or a newer one than the row that was onboarded.
  try {
    const chain = await require('./history').chain(leagueId, { max: 8 });
    for (const season of chain) {
      const hit = await db.liveLeagueBySleeperId(season.league_id);
      if (hit) return hit;
    }
    const { rows } = await db.query(
      `select * from leagues where previous_sleeper_league_id = $1 and provider <> 'archive' limit 1`,
      [String(leagueId)]);
    if (rows[0]) return rows[0];
  } catch { /* Sleeper unreachable; the direct check already ran */ }
  return null;
}

/**
 * @param opts.firstName/lastName/platform/platformOther
 *   Who they are and where their league lives. The SMS path leaves these null
 *   and collects them conversationally straight after (see confirmAndAsk and
 *   src/intake.js) — one question per message, which reads like talking. The
 *   website form has no conversation to have, so it asks in the form and passes
 *   them here. Either way a lead is asked once, by whichever door it came in.
 */
async function record({ phone, email = null, leagueId, rawText, source = 'sms',
  firstName = null, lastName = null, platform = null, platformOther = null, plan = null }) {
  const normalized = phone ? db.normalizePhone(phone) : null;
  const mail = email ? String(email).trim().toLowerCase() : null;
  if (!normalized && !mail) throw new Error('a signup needs a phone or an email');

  // Resolve the league so a typo is visible in the queue immediately, instead
  // of looking like a valid lead until someone tries to onboard it.
  let league = null;
  if (leagueId) {
    try {
      const lg = await sleeper.league(leagueId);
      if (lg && lg.league_id) league = lg;
    } catch { /* unknown id; recorded below with league_name null */ }
  }

  // Two partial unique indexes rather than one, since either contact may be
  // absent; the conflict target has to match whichever was supplied.
  const conflict = normalized
    ? `(phone, coalesce(sleeper_league_id, '')) where phone is not null`
    : `(lower(email), coalesce(sleeper_league_id, '')) where email is not null`;

  const { rows } = await db.query(
    `insert into signups (phone, email, sleeper_league_id, league_name, season, total_rosters,
                          raw_text, source, first_name, last_name, platform, platform_other, plan)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict ${conflict} do nothing
     returning *`,
    [normalized, mail, leagueId || null, league?.name || null, league?.season || null,
     league?.total_rosters || null, rawText || null, source,
     firstName || null, lastName || null, platform || null, platformOther || null, plan || null]
  );

  if (rows[0]) {
    /*
     * Tell the operator, here rather than at the call sites.
     *
     * Every signup ROW passes through this function: the texted keyword, the
     * email fallback, and the conversational path that returns before handle()
     * ever sees it. Alerting from handle() missed that third one, which is the
     * same early-return shape that hid the welcome and the mute. One funnel.
     *
     * It does NOT cover /api/signup-intent, which is the main website form and
     * creates a signup_codes row rather than a signups row — this comment used
     * to claim it did, and the gap sat behind that sentence until somebody
     * asked whether they got a text when a league signed up. That endpoint
     * alerts for itself now; see the note there.
     *
     * Only on a genuinely new row. A repeat is somebody retrying, not a second
     * lead, and alerting on it trains the one person who has to act to ignore
     * the alerts. Failure is swallowed inside notify: a signup recorded and not
     * announced is a missed notification, one that throws is a lost lead.
     */
    const waiting = await require('./invites').pending().catch(() => []);
    await require('./notify').operator(null, require('./notify').waitlistText({
      leagueName: league?.name || rows[0].league_name,
      teams: league?.total_rosters,
      // The PHONE only. It used to fall back to the email so the alert always
      // had something to slice a ref out of, which is exactly how "INVITE .com"
      // reached a real phone. Absent means absent, and waitlistText says so.
      phone: rows[0].phone || normalized || null,
      email: rows[0].email || mail || null,
      name: [rows[0].first_name, rows[0].last_name].filter(Boolean).join(' ') || null,
      source,
      pendingCount: waiting.length || 1,
    })).catch(() => {});
    return { signup: rows[0], created: true, league };
  }

  const { rows: existing } = normalized
    ? await db.query(
        `select * from signups where phone = $1 and coalesce(sleeper_league_id,'') = $2`,
        [normalized, leagueId || ''])
    : await db.query(
        `select * from signups where lower(email) = $1 and coalesce(sleeper_league_id,'') = $2`,
        [mail, leagueId || '']);
  return { signup: existing[0] || null, created: false, league };
}

/**
 * What to text back. Honest about the queue — see the note at the top.
 *
 * BRAND, PURPOSE, RATES, OPT-OUT. A carrier reviewer reading a single message
 * out of context has to be able to tell who is texting and how to make it stop,
 * and the old confirmation identified nobody. That is the first thing an A2P
 * review looks for and it was simply missing.
 *
 * The compliance footer is on the REPEAT branch too, not only the first-time
 * one. That is not belt and braces: the first send to this number failed with a
 * 403 (wrong from_number, retired line) while the signup row was still written,
 * so the next text that person sends resolves as a REPEAT — and the repeat was
 * about to become the first message they ever actually received. Whichever one
 * lands first has to carry the disclosure.
 */
/*
 * BRAND, PURPOSE, RATES, OPT-OUT — and no HELP.
 *
 * HELP was advertised here and answers nothing: the provider suppresses
 * outbound to a number the moment it sees a reserved keyword, so the reply
 * never lands. src/welcome.js worked that out and left it off the
 * introduction; these two kept promising it. A keyword that returns silence
 * is worse than one that was never offered, because somebody in trouble
 * texts it and concludes the whole thing is broken.
 *
 * If HELP is ever made to answer — CTIA expects brand and contact — it goes
 * back in all three places at once.
 */
const FOOTER = 'Msg & data rates may apply. Reply STOP to opt out.';

function reply({ created, league, leagueId }) {
  if (!leagueId) {
    return `Welcome to Commish AI — you're on the list. To attach your league, grab your code `
         + `from the site and text ${KEYWORD} plus that code.\n\n${FOOTER}`;
  }
  if (!league) {
    return `I couldn't find a Sleeper league with that ID, so I've noted your number but not the `
         + `league. Double-check the ID and text it again.\n\n${FOOTER}`;
  }
  if (!created) {
    return `Already got you down for ${league.name}. You're on the list, we'll text you here `
         + `when we're ready to set it up.\n\n${FOOTER}`;
  }
  return `Welcome to Commish AI — you're on the list. ${league.name}, ${league.total_rosters} teams.\n\n`
       + `Onboarding isn't automatic yet, so we'll text you here when we are ready to set it up `
       + `rather than leave you guessing. We are excited to be able to bring you this experience `
       + `soon!\n\n${FOOTER}`;
}

/**
 * Confirm the signup, then ask the first intake question.
 *
 * BOTH completion points call this. A signup finishes either by texting a code
 * from the website or by picking a league in the conversation, and wiring the
 * follow-up to only one of them is how the welcome, the mute and the operator
 * alert each ended up half-done today.
 *
 * The confirmation and the first question go out as ONE message. Two texts
 * arriving together reads like a system with a queue; one reads like somebody
 * talking, which is the product's whole premise.
 */
async function confirmAndAsk({ phone, res, leagueId }) {
  const text = reply({ ...res, leagueId });
  const signup = res.signup;
  if (!signup?.id) return text;

  /*
   * Only ask for what the website did not already get.
   *
   * The three questions now live on the screen that hands out the code, and
   * whatever was typed there arrives on the signup. Asking again over SMS reads
   * as a system that was not listening — worse than never asking, because the
   * person can see they already answered.
   *
   * Resumes at the first gap rather than skipping to the end, so somebody who
   * filled in a name and nothing else is still asked the two that matter for
   * reaching them and for the build order. All three present means no
   * conversation is started at all: the confirmation stands on its own.
   */
  const intake = require('./intake');
  const first = signup.first_name || null;

  if (!first && !signup.last_name) {
    await setConversation(phone, 'intake_name', { signupId: signup.id });
    return `${text}\n\n${intake.askName()}`;
  }
  if (!signup.email) {
    await setConversation(phone, 'intake_email', { signupId: signup.id, first });
    return `${text}\n\n${intake.askEmail(first)}`;
  }
  if (!signup.platform) {
    await setConversation(phone, 'intake_platform', { signupId: signup.id, first });
    return `${text}\n\n${intake.askPlatform()}`;
  }
  return text;
}

// ------------------------------------------------------- conversation ----

/**
 * The texted signup, for people who never touched the website.
 *
 * "Text COMMISH to <the number>" fits in a Reddit comment, on a flyer, or in
 * one commissioner telling another at a draft. A per-session code does not —
 * which matters when distribution is word of mouth. So the bare keyword starts
 * a conversation and the code stays a fast path for site visitors.
 *
 * It also demonstrates the product. The thing being sold is a bot you talk to;
 * making the first interaction a conversation rather than a form is the point.
 */
async function getConversation(phone) {
  const { rows } = await db.query(
    'select * from signup_conversations where phone = $1 and expires_at > now()',
    [db.normalizePhone(phone)]
  );
  return rows[0] || null;
}

async function setConversation(phone, state, data = {}) {
  const { rows } = await db.query(
    `insert into signup_conversations (phone, state, data, expires_at, updated_at)
     values ($1,$2,$3, now() + interval '24 hours', now())
     on conflict (phone) do update
       set state = excluded.state, data = excluded.data,
           expires_at = excluded.expires_at, updated_at = now()
     returning *`,
    [db.normalizePhone(phone), state, JSON.stringify(data)]
  );
  return rows[0];
}

async function endConversation(phone) {
  await db.query('delete from signup_conversations where phone = $1', [db.normalizePhone(phone)]);
}

/** Look up a Sleeper user's leagues for the current or previous season. */
async function leaguesForUsername(username) {
  const clean = String(username).trim().replace(/^@/, '');
  let user;
  try {
    user = await sleeper.get(`/user/${encodeURIComponent(clean)}`);
  } catch { return { user: null, leagues: [] }; }
  if (!user?.user_id) return { user: null, leagues: [] };

  const now = new Date();
  const years = now.getMonth() < 2
    ? [now.getFullYear() - 1, now.getFullYear()]
    : [now.getFullYear(), now.getFullYear() - 1];

  for (const season of years) {
    const leagues = await sleeper.get(`/user/${user.user_id}/leagues/nfl/${season}`).catch(() => []);
    if (leagues?.length) return { user, leagues, season };
  }
  return { user, leagues: [] };
}

function listLeagues(leagues) {
  return leagues.map((l, i) => `${i + 1}) ${l.name}, ${l.total_rosters} teams`).join('\n');
}

/**
 * Advance a conversation. Returns reply text, or null if this message is not
 * part of one.
 */
async function advance(msg) {
  const convo = await getConversation(msg.senderId);
  if (!convo) return null;

  const text = String(msg.text || '').trim();

  /*
   * The three questions asked AFTER a signup lands: name, email, and where
   * they actually want the bot. Handled in src/intake.js and routed here so
   * there is still one conversation per phone and one place that owns it.
   */
  if (String(convo.state || '').startsWith('intake_')) {
    const out = await require('./intake').advance({
      phone: msg.senderId, text, convo,
      setState: (state, data) => setConversation(msg.senderId, state, data),
      endState: () => endConversation(msg.senderId),
    });
    if (out) return out.reply;
  }

  if (convo.state === 'awaiting_username') {
    const { user, leagues, season } = await leaguesForUsername(text);
    if (!user) {
      return `I couldn't find a Sleeper user called "${text}". It's your username, not your team name. Check it and send it again.`;
    }
    if (!leagues.length) {
      await endConversation(msg.senderId);
      return `Found ${user.display_name}, but there are no NFL leagues on that account. Wrong username, maybe?`;
    }
    if (leagues.length === 1) {
      // Nothing to choose between — don't make them pick from a list of one.
      const res = await record({ phone: msg.senderId, leagueId: leagues[0].league_id, rawText: msg.text });
      return confirmAndAsk({ phone: msg.senderId, res, leagueId: leagues[0].league_id });
    }
    // Candidates are stored, not re-fetched, so the number they reply with
    // resolves against the exact list they were shown.
    await setConversation(msg.senderId, 'awaiting_league_choice', {
      username: user.display_name,
      season,
      leagues: leagues.map(l => ({ id: l.league_id, name: l.name, teams: l.total_rosters })),
    });
    return `Found ${leagues.length} leagues for ${user.display_name}:\n\n${listLeagues(leagues)}\n\nReply with a number.`;
  }

  if (convo.state === 'awaiting_league_choice') {
    const options = convo.data.leagues || [];
    let chosen = null;

    const n = Number(text.replace(/[^\d]/g, ''));
    if (Number.isInteger(n) && n >= 1 && n <= options.length) chosen = options[n - 1];

    // Accept the league name too. People answer "the Halcyon one" as readily
    // as "3", and refusing that is pedantry over a solved problem.
    if (!chosen && text.length > 2) {
      const needle = text.toLowerCase();
      chosen = options.find(o => o.name.toLowerCase().includes(needle))
        || options.find(o => needle.includes(o.name.toLowerCase()));
    }

    if (!chosen) {
      return `I didn't catch that. Reply with a number from 1 to ${options.length}:\n\n`
           + options.map((o, i) => `${i + 1}) ${o.name}`).join('\n');
    }

    const res = await record({ phone: msg.senderId, leagueId: chosen.id, rawText: msg.text });
    return confirmAndAsk({ phone: msg.senderId, res, leagueId: chosen.id });
  }

  await endConversation(msg.senderId);
  return null;
}

/**
 * Handle an inbound message if it is a signup. Returns null when it is not,
 * so callers can fall through to the normal reply path.
 */
async function handle(msg, provider, { dryRun = false } = {}) {
  // Group messages are a league talking, not a person signing up.
  if (msg.isGroup) return null;

  // Carrier-reserved words always win, and must never be consumed as an answer.
  //
  // This was a real bug: someone who texted STOP mid-conversation had it
  // treated as a Sleeper username — and because a user actually named "stop"
  // exists, the bot cheerfully replied about their leagues instead of opting
  // them out. Swallowing an opt-out is how a number gets shut down.
  const reserved = RESERVED.exec(String(msg.text || ''));
  if (reserved) {
    await endConversation(msg.senderId);
    const word = reserved[1].toLowerCase();
    // HELP and INFO are informational, not opt-outs.
    if (!/^(help|info)$/.test(word)) {
      await db.suppress(msg.senderId, { reason: word, rawText: msg.text, provider: 'sendblue' });
      console.log(`[signup] opt-out recorded (${word})`);
    }
    // Never reply. The provider suppresses outbound to this number the moment
    // it sees the keyword, so anything sent here would not arrive — and trying
    // to talk someone out of an opt-out is the behaviour the rule exists to
    // prevent. The way back is START, which the provider treats as opt-in and
    // which this module already recognises as a signup keyword.
    return null;
  }

  const parsed = parse(msg.text);

  // START is the carrier's opt-in keyword as well as one of ours, so someone
  // who stopped by mistake gets back in with the same word the provider
  // already understands. Clear our own record to match.
  if (parsed && /^\s*start\b/i.test(String(msg.text || ''))) {
    await db.unsuppress(msg.senderId).catch(() => null);
  }

  // Mid-conversation, an ordinary message is an answer. A fresh keyword
  // restarts, so someone who lost the thread can always begin again.
  if (!parsed) {
    const answer = await advance(msg);
    if (answer === null) return null;
    if (!dryRun && provider) await provider.send(msg.senderId, answer);
    return { handled: true, conversational: true, reply: answer };
  }

  // Keyword with no argument: start the conversation rather than dead-ending
  // them at "go and get a code from the website".
  if (!parsed.leagueId && !parsed.code) {
    await setConversation(msg.senderId, 'awaiting_username', {});
    const text = "Let's get your league in. What's your Sleeper username?\n\n"
               + "(That's the name you log in with, not your team name.)";
    if (!dryRun && provider) await provider.send(msg.senderId, text);
    return { handled: true, conversational: true, started: true, reply: text };
  }

  // A short code carries the league the visitor already chose on the site.
  let leagueId = parsed.leagueId;
  let codeRow = null;
  if (parsed.code) {
    const issued = await resolveCode(parsed.code);
    codeRow = issued;
    if (!issued) {
      const text = `I don't recognise the code ${parsed.code}. Grab a fresh one from the site and text it again.`;
      if (!dryRun && provider) await provider.send(msg.senderId, text);
      return { handled: true, created: false, unknownCode: parsed.code, reply: text };
    }
    leagueId = issued.sleeper_league_id;
    await db.query(
      'update signup_codes set used_at = coalesce(used_at, now()), used_by_phone = coalesce(used_by_phone, $2) where code = $1',
      [issued.code, db.normalizePhone(msg.senderId)]
    );
  }

  /*
   * Already live: say so instead of queueing them behind their own league.
   *
   * No signup row is written. A waitlist entry for a league that is already
   * running is a lead that can only ever be actioned by onboarding it twice.
   */
  const live = await alreadyOnboarded(leagueId).catch(() => null);
  if (live) {
    const text = `${live.name} is already set up on Commish AI. Ask whoever set it up to add `
               + `you to the group chat, and I will be in there.\n\n${FOOTER}`;
    if (!dryRun && provider) await provider.send(msg.senderId, text);
    console.log(`[signup] ${live.name} already onboarded, not queueing`);
    return { handled: true, created: false, alreadyOnboarded: true, league: live, reply: text };
  }

  /*
   * Whatever the website already collected comes with the code.
   *
   * Without this the person answers the same three questions twice — once in
   * the form and again over SMS — which reads as a system that was not
   * listening the first time.
   */
  const res = await record({
    phone: msg.senderId,
    leagueId,
    rawText: msg.text,
    firstName: codeRow?.first_name || null,
    lastName: codeRow?.last_name || null,
    email: codeRow?.email || null,
    platform: codeRow?.platform || null,
    platformOther: codeRow?.platform_other || null,
    plan: codeRow?.plan || null,
  });
  const text = await confirmAndAsk({ phone: msg.senderId, res, leagueId });

  if (!dryRun && provider) {
    await provider.send(msg.senderId, text);
  }

  console.log(`[signup] ${res.created ? 'NEW' : 'repeat'} ${res.league?.name || parsed.leagueId || '(no league)'}`);
  return { handled: true, created: res.created, signup: res.signup, reply: text };
}

module.exports = {
  parse, record, reply, handle,
  advance, getConversation, setConversation, endConversation, leaguesForUsername,
  issueCode, resolveCode, newCode, alreadyOnboarded, confirmAndAsk,
  KEYWORD, KEYWORDS, SIGNUP, RESERVED, FOOTER, CODE_ALPHABET, CODE_LEN,
};
