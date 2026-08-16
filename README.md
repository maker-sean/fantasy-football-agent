# commish-agent

> **Keep this repo private.** Phone numbers were scrubbed from history on
> 2026-08-15 and replaced with reserved `555-01xx` placeholders, but the docs
> and commit messages still quote real group-chat messages and name real league
> members. Runtime phone numbers live only in Postgres and the gitignored
> `logs/` — never in code.


An AI agent that sustains fantasy football league engagement year-round — the
dead period after the draft when league chatter dies off.

## TRANSPORT: SENDBLUE. Blooio is retired.

**Sendblue is the active provider.** Blooio failed Milestone 0 and remains in
the tree only as a negative control and as proof the adapter seam works. Do not
build against it.

| Provider | Mixed-device group send | Status |
|---|---|---|
| **Sendblue** | **works** — Android member received it | **ACTIVE** |
| Blooio | fails — `device_send_error` 4 | retired, do not use |

### Milestone 0 result

Blooio, on trial number `+15555550101`, 2026-08-11:

| Target | Composition | Transport | Result |
|---|---|---|---|
| `grp_AAAAAAAAAAAAAAAA` | all-Apple group | `imessage` | sent ✅ |
| `+15555550105` (1:1) | single Android | `rcs` | delivered ✅ |
| `grp_CCCCCCCCCCCCCCCC` | mixed group | `pending` | **failed** — `device_send_error` 4 |
| `grp_BBBBBBBBBBBBBBBB` | mixed group | `pending` | **failed** — `device_send_error` 4 |

Blooio reaches Apple users in groups and Android users 1:1 over RCS, but cannot
send into a group containing a non-iMessage member. Two endpoints hit the
identical failure while the same path succeeded on an all-Apple group, so
composition was the variable, not the API. `protocol: pending` means no wire
service ever resolved — the send died at Blooio's Mac before a transport was
chosen, consistent with a Mac being unable to originate an MMS/RCS *group*.

Sendblue, on line `+15555550100`, same participants:

| Target | Composition | Result |
|---|---|---|
| `sb_group_22222222-2222-2222-2222-222222222222...` | all-Apple group (2 + line) | **sent** ✅ |
| mixed group (2 iMessage + 1 Android) | mixed | **Android member received it** ✅ |

Sendblue also creates groups on the **Free Tier** (`"plan": "free_api"`,
`"message_type": "group"`), contrary to its docs claiming Blue Ocean is
required.

**Consequence:** in-group is viable. The 1:1-concierge fork stays closed unless
something later reopens it.

### Inbound: use POLLING, not webhooks

**Sendblue's `receive` webhook does not fire for group messages.** Measured
2026-08-15 with a verified, reachable receive webhook registered:

| Message | `message_type` | Webhook fired? |
|---|---|---|
| 1:1 iMessage | `message` | **yes** |
| group reply (×3, all after registration) | `group` | **no** |

Every one of those group replies *was* recorded server-side and is readable at
`GET /api/v2/messages` with a correct, stable `group_id`. The data is there;
the push is not. Since the entire product lives in a group thread, webhooks
cannot drive the reactive path on this provider.

`src/poller.js` + `npm run poll` is the inbound transport. This is not purely a
downgrade — it needs no tunnel and no public URL, it survives restarts via a
durable cursor instead of losing whatever arrived while the process was down,
and group and 1:1 share one code path. The cost is one poll interval of latency.

`/webhooks/sendblue` still works and is kept for 1:1 and for the day Sendblue
fixes this. Do not rely on it for groups.

### Inbound correlation: PASSED

From live data, all replies in the mixed group:

- **one** `group_id` (`sb_group_00000000-0000-0000-0000-000000000000...`) across every message
- **three** distinct senders resolved correctly, including the Android member
- group traffic is `RCS` for *all* members — one non-Apple participant pulls the
  whole thread off iMessage, exactly as Blooio showed
- 1:1 to an iMessage member stays `iMessage` and is correctly not counted as group

### PHASE 0 CLOSED — full round trip in a mixed-device group

2026-08-15, `sb_group_00000000-0000-0000-0000-000000000000...` (2 iMessage + 1 Android + the line):

```
OUT 17:34  SENT      RCS  group  "[bot message redacted]"
IN  17:35  RECEIVED  RCS  group  "[league member reply redacted]"
IN  17:36  RECEIVED  RCS  group  "[league member reply redacted]"
```

Bot spoke into the group, two humans replied to it inside two minutes. Both
directions work with a non-Apple member present. `was_downgraded` is null
throughout — the thread is natively RCS rather than a fallback.

Treat the reply count as encouraging, not evidence. n=1, the novelty is
maximal, and the participants know whose bot it is. The Phase 2 measurement —
**human replies triggered per bot message**, over weeks, in a league the owner
does not run — is the one that decides the product.

### Still unproven

1. **Group size.** Tested at 4 participants. Leagues are 11–13, and group MMS
   caps bite at 8–10 across carriers. Kill risk of the same class as device mix.
2. **Poll latency and rate limits** under a real league's message volume.
3. **Persistence.** Until `DATABASE_URL` is set, every message is read and
   discarded — including exactly the banter Phase 3's narrative memory needs.

### Vendor landscape (surveyed 2026-08)

| Provider | Mixed devices in one group? | Cap |
|---|---|---|
| Sendblue | **yes** (measured) | untested above 4 |
| Blooio | no (measured) | ~29 all-Apple |
| LoopMessage | no — iMessage groups only | ~29 all-Apple |
| Twilio Conversations | yes (group MMS) | 10 total |
| Telnyx | yes (group MMS) | 9 total |
| Linq | unclear — worth asking | 31 array; carrier ~10–20 |

## Architecture (non-negotiable)

| Seam | Where | Why |
|---|---|---|
| `MessagingProvider` | [src/provider.js](src/provider.js), [src/sendblue.js](src/sendblue.js) | Agent and league logic never import a vendor. Swapping transports is one new class — this is what let Blooio be replaced by Sendblue in an hour instead of a rewrite. |
| League registry | [src/db.js](src/db.js) `leagues` | One service, many leagues. Inbound routes on `(provider, chat_id)`. Never hardcode a league. |
| Reply-first + rate limit | [src/agent.js](src/agent.js) | UX *and* survival — chatty automated numbers get carrier-flagged. |
| Identity = normalized E.164 | [src/db.js](src/db.js) `members` | NOT a provider contact id. Blooio minted two `contact_id`s for one human in one group; a roster keyed on those would double-count every league. |
| Snapshots are insert-only | [0001_init.sql](supabase/migrations/0001_init.sql) | A kickoff lineup cannot be reconstructed later. A re-run must never overwrite the original capture. |

## Setup

```bash
npm install && cp .env.example .env
```

Fill in `.env`:

| Var | Where from |
|---|---|
| `SENDBLUE_API_KEY_ID` / `SENDBLUE_API_SECRET_KEY` | `sendblue show-keys` |
| `SENDBLUE_FROM_NUMBER` | `sendblue lines` — **required on every send** |
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string (URI) |

Apply the schema, then register a league:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql
```

```bash
node scripts/register-league.js --name "My League" --sleeper <sleeper_league_id> --chat <sb_group_id> --from +1XXXXXXXXXX
```

Two processes:

```bash
npm start     # web: webhook receiver, persists inbound
```

```bash
npm run worker  # cron: Sleeper ingestion + kickoff snapshots
```

## Sendblue notes (verified by measurement)

- Base URL `https://api.sendblue.co`. Auth is **two** headers: `sb-api-key-id`, `sb-api-secret-key`.
- **`from_number` is required on every send.** Omitting it fails everything with a generic 400.
- `POST /api/send-group-message` with `numbers[]` creates a group and returns `group_id`.
  Follow up with `{group_id, content}` — no `numbers`.
- `QUEUED` is **not** delivery. Lifecycle: `REGISTERED → PENDING → QUEUED → ACCEPTED → SENT → DELIVERED`,
  with `DECLINED`/`ERROR` terminal. Always confirm with `npm run sendblue-status`.
- Inbound webhook: `from_number`, `to_number`, `content`, `media_url`, `service`, `group_id`, `date_sent`.
  There is **no event field** — inbound and status callbacks arrive on different URLs, so the route supplies the type.
- Free Tier is **reply-only**: contacts must text the line first, max 10, shared number.
  Same shape as Blooio's `inbound` allocation. A shared line is fine for testing and
  wrong for a league that expects a persistent bot identity.
- `was_downgraded` and `service` are the fields that reveal whether a mixed group
  got pushed off iMessage.

Useful commands:

```bash
npm run sendblue-preflight -- 5555550103 5555550105   # who still needs to text the line
npm run sendblue-group -- 'message' 5555550103 5555550105
npm run sendblue-status                               # what actually happened
```

## Phase 1 — snapshots (the deadline-bound work)

Sleeper serves *current* state only. Once games kick off, the pre-kickoff
starting lineup is gone — you can no longer tell who benched a 30-point week.
That is most of the roast material and it has a hard deadline of the season's
first kickoff.

```bash
node scripts/snapshot.js lock_sun_early --force   # prove it works in preseason
node scripts/snapshot.js --list                   # what has been captured
node scripts/snapshot.js --jobs                   # did the cron actually fire
```

Captures are gated on `season_type === 'regular'` (currently `pre`), so
`--force` is how you exercise the path before it matters.

Cron (ET, in `worker.js`): `lock_thu` Thu 20:15 · `lock_sun_early` Sun 12:55 ·
`lock_sun_late` Sun 15:55 · `lock_sun_night` Sun 20:10 · `lock_mon` Mon 20:10 ·
`postscore` Tue 06:00 · `players` daily 04:00 · `members` daily 04:30.

## Assumed, not measured — revisit with real data

- **Recap length: 100 words** (`RECAP_WORDS`, or `--words`). Short keeps it
  reading as a group text rather than an announcement, and announcements get
  acknowledged instead of answered. The cost is real: a six-game week produces
  more good material than 100 words can carry. Decide it on reply rate once the
  bot posts weekly — generate the same week at 100 and 180 and compare.
- **Spice default: 1 of 3** (`--spice`). Never tested against a live league.
- **Burst debounce: 8s quiet / 30s ceiling** (`BURST_QUIET_MS`). Picked to feel
  natural at a 10s poll; never measured against real conversation rhythm.

## Still open

- [ ] **Inbound correlation on Sendblue** — replies from both device types landing on one `group_id`. Phase 2 depends on it.
- [ ] **Group size** — tested at 4 participants; leagues are 11–13, group MMS caps at 8–10.
- [ ] Webhook signature verification. **Not implemented — do not run in production as-is.**
- [ ] Per-league unit economics (MMS cost vs price) — the Phase 4 gate.

## Constraints (researched — don't re-derive)

- No official iMessage API. These vendors run real Apple hardware; **ban risk is real**. Rent, never self-host a Mac farm.
- Bans come from carriers, not vendors, and a banned number is unrecoverable. A banned identity cannot rejoin an existing group thread.
- iMessage groups require every participant on iMessage (~29 cap). Group MMS is carrier-capped near 10. Leagues run 10–12.
- Sendblue clears the device-mix wall. The **size** wall is untested.
- Side bets are state-by-state regulated. Later, carefully scoped. The messaging layer does not make wagering legal.

## Roadmap (phased by risk retirement, not feature completeness)

- **P0** — transport proof. Device mix ✅ (Sendblue). Inbound correlation and group size ⬜
- **P1** — echo loop + Sleeper snapshot capture. ← *you are here*
- **P2** — thinnest valuable bot. Metric: **human replies per bot message**. This is the product go/no-go.
- **P3** — narrative memory, league culture, spiciness/presence dials. Pilot in a league you don't run.
- **P4** — productize: onboarding, multi-tenant, Stripe, ban recovery. Gate: unit economics.
- **P5** — harden and scale only as load demands.

## Historical: why Blooio was retired

Kept because the reasoning is load-bearing and re-deriving it costs a day.

Blooio's group send requires a linked iMessage chat; `POST /groups` without
`chat_guid` creates a record with no thread, so sends returned `202` and went
nowhere. The multi-recipient participant-list form worked on all-Apple groups
and failed on mixed ones with `device_send_error` code 4 and `protocol: pending`
— no wire service ever resolved. Its allocations are `shared`/`dedicated`/
`inbound`/`trial`/`2fa`, where `inbound` is reply-only
(`403 inbound_only_no_prior_inbound`). Its messaging-safety caps are worth
remembering for any vendor: max 3 messages to a new recipient before they
respond, a consecutive-message streak cap, one re-engagement message after 14
days silent, and no links or media before the recipient writes back — **a
tapback clears the streak counter**, which makes "get one reaction" a real
engagement mechanic rather than a nicety.

`scripts/whoami.js`, `scripts/groups.js`, `scripts/inspect.js`,
`scripts/capabilities.js`, and `scripts/simulate-webhook.js` are Blooio-only and
retained for reference.
