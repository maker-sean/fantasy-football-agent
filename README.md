# Commish

Commish is an AI agent that lives in a fantasy football league's group chat, answering
questions and writing weekly recaps grounded in six seasons of that league's own history.
This repo is public as a writeup of the design decisions behind it. It covers how you
evaluate output that has no right answer, what broke in production, and why the model
layer is split three ways.

## What it is, and why it exists

Commish is an AI agent that lives inside a fantasy football league's group chat, the real
thread on iMessage and RCS rather than a separate app anyone would have to be persuaded to
open. It holds six seasons of league history in Postgres (582 games, 1,020 draft picks,
2,297 transactions) and speaks into the thread on its own schedule. It writes a weekly
recap that names what actually happened, sends draft countdowns, grades trades, runs
waiver post-mortems, and answers directly whenever somebody addresses it. It exists
because a league's group chat is at its best for about three weeks a year. After the draft
the conversation dies, and the league's own history sits unread in an app nobody opens on
a Tuesday, including the closest game ever played, the playoff run that started from
fourth, and the manager who has made 390 roster moves and won nothing. The bet is that the
material is already there and what is missing is something to bring it up unprompted. It
went live in a real 12-person league on 22 August 2026, and 11 of the 13 people on the
thread talked to it in the first two hours.

## Where to look

The four files that carry most of the reasoning below.

| File | What it does |
|---|---|
| [`src/stats.js`](src/stats.js) | Computes every number the bot says out loud, deterministically, with no model in the loop. The split that makes the rest testable. |
| [`src/decide.js`](src/decide.js) | Decides whether to reply at all. Layered, defaults to silence, and documents why the two failure directions are not symmetric. |
| [`scripts/retrieval-bench.js`](scripts/retrieval-bench.js) | The paired full-context versus routed-context harness. Scored on facts lost, not tokens saved. |
| [`scripts/decide-replay.js`](scripts/decide-replay.js) | Replays real recorded group traffic through the reply gate offline, so "would this have been annoying?" is answerable without sending anything. |

## Evaluating output with no right answer

The hard part of this product is that its output has no right answer. There is no label
for whether a roast landed. My response was to make most of the problem have a right
answer anyway, with a strict split where [`src/stats.js`](src/stats.js) computes every
number deterministically, with no model in the loop and full unit test coverage, and the
model is handed those numbers and permitted only to supply voice. Arithmetic becomes
testable and the genuinely subjective residual shrinks to something small enough to judge
by hand. For that residual I lean on paired comparison and on behavior rather than on
rubrics. [`scripts/retrieval-bench.js`](scripts/retrieval-bench.js) runs the same twelve
questions with the full league context and with a routed subset, and the metric is
deliberately not token count. It is whether the routed answer *lost a fact* the full
answer had, because that is the failure a cost saving can hide.
[`scripts/decide-replay.js`](scripts/decide-replay.js) replays real recorded group traffic
through the reply gate offline and answers "would this bot have been annoying?" without
sending anything, which matters because tuning a chattiness threshold against live humans
is expensive and, if you overshoot, unrecoverable. `REPLY_DRY_RUN` does the same thing
against live traffic while staying silent.

**The metric that decides the product is whether a bot message pulls a human back into
the thread. It's running at 94%.**

That number needs its caveats stated, because they're most of it. One league. Eight days.
Reactions count as engagement, and a tapback is cheap. Everyone on the thread knows whose
bot it is, and novelty is at its peak. The measurement that would mean something is the
same number in month three, in a league I don't run, and it isn't in yet. But it's the
number the whole design points at, and it's the right one to be watching.

## What broke

The failure modes were mostly not the ones I expected, and almost none of them were the
model writing badly. The dominant one was the model computing something it should have
been handed. Asked who had the most top-three finishes, it read twelve rows and answered
"A and B, three each". Asked the same question slightly differently a minute later, it
said "B and C, two each". Both wrong, disagreeing with each other, off a list sitting in
front of it. Ranking is precisely the operation nobody can verify after the fact.

The same thing happens one row over. Handed a table that correctly said one manager was
0-3 on trade value and another was 0-2, the bot answered that both were 0-3. Both numbers
were printed correctly. One had been carried onto the neighbouring name.

That's worse than a hallucination. An invented number often looks wrong. A fused one never
does.

The second was the bot talking to itself. iMessage tapbacks arrive over the wire as ordinary
group messages whose body wraps a *quote* of the thing reacted to, so on launch night 47
reactions appeared and the bot dutifully answered its own echo. Nineteen of those were the bot
replying to a quote of its own name. It was having a great time.

The third was the worst. A league received its draft-day announcement twice, correctly on
Saturday evening and then again at 2:40pm Sunday, five hours before its own draft. The
announcer's timing logic was right. The test suite was the bug. `test/draftannounce.test.js`
ran `delete from system_flags` in four places against the same database the product uses,
wiping every live league's "already announced" marker, and running the suite that afternoon is
what sent the text.

Smaller ones cost real trust too. "Commish" is a *human* in every league, so a bot answering to
it barges into conversations about a person, and answering "nothing on record for that name"
about a manager who is simply new reads as a broken lookup rather than a true statement.

## What changed

Grounding stopped being a prompt instruction and became a structural constraint. Every
superlative the bot is allowed to utter is now precomputed into an explicit `LEAGUE
EXTREMES` block, ties are printed as ties, and any ranking not in that block is off limits
no matter how obvious it looks from the data. The designed answer to an unanswerable
superlative became refuse-then-redirect. Decline the ranking, then immediately hand over
the nearest fact that *is* computed, because refusing alone is a worse answer than the
question deserved. Reactions are now pattern-detected and excluded as a *reason* to speak
while still being kept in conversation history. The test suite incident produced three
fixes rather than one. Cleanup is scoped to each file's own fixture league, and the single
test that needs a live league refuses any league already carrying a flag and deletes only
what it wrote. All countdown copy is anchored to absolute dates, since "draft is tomorrow"
is a claim about when a message is *read* and nothing controls that. And each notice got a
bounded window so a late fire is never due again, because a missed notice beats a wrong
one.

## Deterministic data, nondeterministic reader

Everything this bot talks about is already exact. Six seasons of scores, records and draft
picks sit in Postgres as rows that do not move. The model is the only nondeterministic
component in the system, and nearly every real failure came from putting those two things
together carelessly. The lesson the codebase kept relearning, written into
[`src/draftgrade.js`](src/draftgrade.js) after it had already been learned in four other
places, is that a model quotes reliably and fuses unreliably.

The model's access to the data was narrowed until quoting was the only thing left to do.
Numbers are computed in [`src/stats.js`](src/stats.js). Draft observations are written as
finished sentences in code and the model is asked to repeat them rather than derive them.
Projections are labelled as Sleeper's, and adjusting, averaging or totalling them is forbidden
outright. Every one of those rules closed a hole where the model had been free to do arithmetic
or comparison on data that was already correct before it arrived.

The same reasoning drives the decisioning layer, which is the one place the model touches
nothing at all. [`src/decide.js`](src/decide.js) runs layers in order and the first to
return a verdict settles it. Layer 0 is hard suppression, Layer 1 is direct address, and
both are ordinary deterministic code. Layer 2, heuristic interjection, and Layer 3, a gate
model, exist in the structure as stubs that throw if called. Whether the bot speaks is
decided today without asking a model anything. That is deliberate rather than unfinished.
The cost of a wrong decision to speak is a muted number you are never told about and
cannot undo, so the judgment carrying the most risk is the one held furthest away from the
nondeterministic part of the system.

## Architecture

It is a Node worker against Postgres, with the seams placed where vendors and models are
likely to move. Snapshots are insert-only and captured on a kickoff cron, because Sleeper
serves current state only, and the pre-kickoff starting lineup, which is most of the roast
material, is unrecoverable once games begin. A [`MessagingProvider`](src/provider.js)
interface keeps league logic from importing any vendor, which is what let the first SMS
provider be swapped out in an hour when it turned out it could not send into a group
containing a single Android phone. Inbound runs by polling with the cursor in Postgres
rather than by webhook, because the active provider's receive webhook silently never fires
for group messages and the host's disk is ephemeral.

The model layer is deliberately three-tier. Haiku 4.5 does classification only. It reads
the question and picks context sections off a fixed menu in
[`src/retrieve.js`](src/retrieve.js), and it is explicitly not allowed to compose a lookup.
That constraint is the architectural decision I am most willing to defend. The recurring
failure in this codebase is a model deriving a fact it should have been handed, and a
router that wrote its own query would have put the system straight back into that business
for a saving I did not need. For the same reason I made the router **fail open**, so on
error, timeout, or nonsense it loads the entire context, which is exactly the behavior that
shipped before the router existed. The cost of that choice is a slow, expensive reply. The
cost of failing closed is a confident answer with a section missing. I'd rather pay for
the slow reply.

Sonnet is the workhorse for both generating surfaces, the weekly recap and the direct
answer. It earns that spot because the binding constraint here is not throughput. Every
generation is gated by a human addressing the bot or by a once-a-week recap, so volume is
inherently low. The constraint is voice quality at a latency a live group chat will
tolerate, and Sonnet clears the voice bar while staying fast enough that a reply lands
while people are still looking at the thread. The stable persona prefix is marked with
`cache_control`, so the expensive part of each call is cached and the marginal cost per
message is just the league context and the reply. On launch night, 57 generated replies
over two hours cost about fifty cents. Opus is wired in as the comparison for production
weeks rather than the default, on the view that the model should be the last thing scaled
up, after the grounding is structural enough that a bigger model would only be buying prose.
