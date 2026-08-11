# Fantasy League Agent

An AI agent that sustains fantasy football league engagement year-round — the
dead period after the draft when league chatter dies off.

**Current state: Milestone 0 instrument.** The agent brain is deliberately a
stub. Nothing else gets built until the group surface is proven.

## Why this order

Milestone 0 asks whether a bot can even live in a real league's group chat when
that group is mixed iMessage + Android. If the answer is no, the in-group
architecture is wrong and a fully-built agent would be sitting on a foundation
that fragments. That test costs $39 and one evening. Find out first.

Note that M0 cannot be observed without a running webhook receiver — so the
receiver is a *prerequisite* of M0, not a later milestone. What's gated behind
M0 is the brain (Milestone 2+), not the plumbing.

## Architecture (non-negotiable)

| Seam | Where | Why |
|---|---|---|
| `MessagingProvider` | [src/provider.js](src/provider.js) | Agent + league logic never import Blooio. Swapping to Sendblue/Linq/Twilio is one new class. This is the difference between a pivot and a rewrite. |
| League registry | [src/leagues.js](src/leagues.js) | One service, many leagues. Routing resolves league by chat id. Never hardcode one league. |
| Reply-first + rate limit | [src/agent.js](src/agent.js) | UX *and* survival — chatty automated numbers get deregistered. |
| Identity ≠ phone number | [src/leagues.js](src/leagues.js) | A number rotation or ban is a re-notify, not a lost customer. |

## Setup

```bash
npm install && cp .env.example .env
```

Put your Blooio key in `.env`, then:

```bash
npm start
```

### Verify the pipeline before spending money

```bash
node scripts/simulate-webhook.js
```

Posts synthetic v2-shaped payloads (one iMessage sender, one SMS sender, same
group id) and prints the `/m0` verdict. This proves *our* code works. It proves
nothing about Blooio's real group behavior.

## Milestone 0 runbook

**Prereqs.** The free trial gives you a real iMessage-enabled number and full
API access — M0 needs no paid plan. The one genuinely non-automatable step is
**someone adding that number to the real league group from an iPhone**. Per
Blooio's docs, `members[]` on `POST /groups` is bookkeeping — it does *not* add
anyone to the real iMessage thread.

0. Find out what your number is allowed to do — this gates Milestone 2, not M0:
   ```bash
   npm run whoami
   ```
   An `inbound` allocation is **reply-only**: sends to a group with no prior
   inbound return `403 inbound_only_no_prior_inbound`. Fine for M0/M1 (both are
   reply-first). Fatal for unprompted weekly recaps — see *The reply-only
   problem* below.
1. Profile your members so you know who's non-Apple going in:
   ```bash
   node scripts/capabilities.js +15551110001 +15551110002 +15551110003
   ```
2. Expose the webhook and register `<tunnel-url>/webhooks/blooio` in the Blooio dashboard:
   ```bash
   npx cloudflared tunnel --url http://localhost:3000
   ```
3. Have the bot number added to the real league group from an iPhone.
4. **Test (a) — does the group hold together inbound?** Get at least one iPhone
   member and the Android member to post. Then:
   ```bash
   curl -s localhost:3000/m0
   ```
   - **PASS:** one chat id, `isGroup: true`, ≥2 distinct senders, protocols
     spanning Apple and non-Apple.
   - **FAIL:** more than one group chat id for one human thread. The group
     fragmented — in-group is wrong for real leagues.
5. **Test (b) — does one reply land in one thread?** Using the chat id from step 4:
   ```bash
   node scripts/send.js "<chatId>" "testing, ignore me"
   ```
   Ask every member whether it appeared in the group thread. Anyone who got it
   as a separate 1:1 is a fragmentation failure.

Raw verbatim payloads land in `logs/webhooks.jsonl` — that file is ground truth
if the parsed field names turn out wrong.

## What the docs actually say (verified)

- Base URL `https://api.blooio.com/v2/api`. **Not** `backend.` — that open item is closed.
- Auth `Authorization: Bearer <key>`. Sends return **202 Accepted** = queued, *not* delivered.
- Inbound webhook fields: `event`, `message_id`, `external_id`, `internal_id`,
  `protocol`, `text`, `sender`, `is_group`, `timestamp`.
  (The original scaffold read `chat_id` and `from`; neither exists.)
- `protocol` is per-message `imessage` / `sms` / `rcs` — free mixed-device instrumentation.
- Groups link to a **BlueBubbles** `chat_guid`. Omit it to create a new chat on
  first send; provide it to join an existing thread.
- A **v4 beta** exists (`POST /v4/messages`, flat `{to, text}`). We're on v2
  deliberately: v4 is beta, and v2 carries Groups, Reactions, Polls, and Typing
  Indicators — the actual engagement primitives this product wants.

## The reply-only problem

Blooio number allocations are `shared`, `dedicated`, `inbound`, `trial`, `2fa`.
**Inbound numbers are reply-only** — they "cannot start new conversations," and
the check is `(allocation, group_id)` for groups. There is no warmup period: the
first outbound to a group succeeds the moment an inbound from that group is
recorded.

This does not touch M0 or M1 — both are reply-first by design, so a reply-only
number tests them faithfully. It lands squarely on **M2**. The product spec is
"posts weekly recaps / power rankings / lineup reminders," and every one of
those is an *initiated* message. A reply-only number cannot send them.

The tempting workaround — make everything trigger-driven (`@bot recap`) — is
worth resisting on reflex. The premise of the product is that league chatter
*dies*. If nobody's talking, nobody's there to trigger the bot, and a
trigger-only agent is silent exactly when it's most needed. The unprompted
Tuesday-morning recap is plausibly the whole product, not a nice-to-have.

Verify your allocation with `npm run whoami` before scoping M2. If it's
reply-only, budget a dedicated number rather than redesigning the product
around the constraint.

## Ban risk (sharpened)

Per Blooio: they never ban numbers — **carriers do**, and "once a number is
banned, it cannot be recovered," you buy a new one. Combined with the known
constraint that a banned identity can't rejoin an existing group thread, this
is the single largest technical risk to the in-group architecture at scale.
Guidance for initiated outbound is 20–50 new conversations/day/number.

## Still open

- [ ] What `external_id` contains for a group message (answered by M0).
- [ ] Webhook signature verification scheme — the receiver logs any
      signature-ish headers so we can identify it. **Not verified yet; do not
      run this in production as-is.**
- [ ] Whether `members[]` populates a *newly created* group differently than a linked one.
- [ ] Blooio's participant ceiling for a 12-person league.

## Constraints (researched — don't re-derive)

- No official iMessage API. Blooio runs real Apple hardware; **ban risk is
  real**. Rent the transport, never self-host a Mac farm.
- Group MMS caps ~10 participants (carrier-enforced). Leagues run 10–12 — this
  is size-marginal. iMessage groups allow ~29 but only if everyone is on iMessage.
- Bans degrade gracefully in 1:1, catastrophically in groups — a banned identity
  can't rejoin an existing thread.
- **Unresolved product fork:** bot-in-group vs. 1:1 concierge that broadcasts.
  This prototype tests in-group. The adapter seam keeps the pivot cheap.
- Side bets are state-by-state regulated. Later, carefully scoped. The messaging
  layer does not make wagering legal.

## Roadmap

- **M0** — validate the group surface. ← *you are here*
- **M1** — echo loop. (receiver + send path; already scaffolded)
- **M2** — agent brain: wire `runAgent` to the Anthropic API, league context, reply-first policy.
- **M3** — fantasy data. Sleeper API is friendliest; ESPN/Yahoo are read-only and messier.
- **M4** — multi-tenant + billing: onboarding, per-league numbers, Stripe, signature
  verification, ban-recovery re-notify.
