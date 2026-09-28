<p align="center">
  <strong>Anyray Simulator</strong>
</p>

<p align="center">
  <strong>Your prompts. Your gateway. Your numbers.</strong>
</p>

<p align="center">
  <sub>Run your own traffic through Anyray twice and find out what it costs — and whether the answers still hold.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-3c873a" alt="Node 20+">
  <img src="https://img.shields.io/badge/dependencies-none-1a7f5a" alt="No dependencies">
  <img src="https://img.shields.io/badge/scope-per--request-8a5a00" alt="Per-request">
  <img src="https://img.shields.io/badge/your%20prompts-never%20committed-0e6a6a" alt="Prompts never committed">
</p>

---

You asked how you'd know the savings are real. This is the answer we'd want if we
were you: a repo you run yourself, on your own prompts, against your own gateway,
where every number comes from your provider rather than from us.

One command sends each prompt twice — once with Anyray bypassed, once the way
your app already sends it — and answers two questions:

1. **Does it cost less?** Input tokens, from your provider's own `usage` field.
2. **Are the answers still right?** Checked against facts *you* declared a
   correct answer must carry.

Same model, same key, same path. One header is the only difference.

---

> ### This proves per request, not per session
>
> Every number here compares one request sent twice. A live agent reacts to what
> changed and may take a different number of turns, so a per-request saving is
> **not** a session-level saving. Measuring that takes weeks of real traffic and
> is what the gateway's audited holdout is for
> (`GET /admin/v1/spend/quality-parity`).
>
> We lead with this because a small paired bench read as a session-level verdict
> is how these conversations go wrong. If we ship a per-request tool, we call it
> per-request.

---

## Quick start

```bash
git clone https://github.com/anyrayHQ/simulator.git
cd simulator
cp .env.example .env          # gateway URL, client key, model
```

Three values, and **`PROOF_MODEL` has no default** — set it to a model your
gateway actually routes, ideally the one your app already sends. Every
deployment serves a different set, so a shipped default would just fail on your
first call.

Check the plumbing first — one cheap workload, six calls:

```bash
node prove.mjs --workload example-02
```

Then capture your own traffic. Paste **[SETUP-PROMPT.md](./SETUP-PROMPT.md)** into
Claude Code, Cursor, or whichever agent you already have open. It finds the
prompts your project actually sends, works out what each answer must contain,
scrubs anything sensitive, and stops for your review. It will not run the proof —
you do that.

```bash
node prove.mjs                # the run — writes results.json AND report.html
node report.mjs --redact      # a copy you can send on: numbers, no content
```

Interrupted partway through? Run the same command again and it picks up where
it stopped, keeping the workloads you already paid for. `--fresh` starts over.

Node 20+. No `npm install`, no dependencies, no account beyond the client key you
already have.

> **This spends your provider budget.** Each workload costs 2 × `PROOF_REPEATS`
> calls — six by default. Before spending anything the run prints the call count
> and a rough ceiling in dollars, worked out assuming no saving at all and every
> answer running to `PROOF_MAX_TOKENS`, so the real bill lands under it.
>
> Results are written after every workload, so a run interrupted at workload
> nine still has the eight you already paid for — and re-running resumes from
> there rather than buying them again.

## What a run looks like

```
example-01-log-dump          18,940 →  7,210   62%  facts kept 3/3
example-02-small-question       310 →    310    0%  facts kept 3/3
example-03-tool-bloat         8,455 →  2,110   75%  facts kept 3/3

1 — COST
  input tokens   27,705 → 9,630   65% lower
  at list price  $0.14 → $0.05

2 — QUALITY
  every required fact survived, in all 3 runs, on 3 of 3 checked workloads
```

One of the shipped examples saves nothing at all. That's deliberate: a short
question has nothing worth removing, and you should see an honest 0% before you
believe any of the other numbers.

## And it has to be able to fail

Pointed at a gateway that drops a required fact:

```
example-01-log-dump           9,036 →  2,892   68%  LOST FACTS (2/3 vs 3/3)
  ! only missing after the trim: ECONNRESET
```

Note it still reports the cost win alongside. **Cheaper and worse is a real
outcome and the tool says so**, and the run exits non-zero so CI can gate on it.
A proof tool that cannot return a bad verdict is marketing, and an evaluator
spots that in the first five minutes. The failure path is tested rather than
asserted — `npm test` runs the whole thing against a mock gateway in both
states.

## How the two numbers are made

<details>
<summary><strong>Cost — from the provider, not from us</strong></summary>

<br>

Input token counts come from your provider's own `usage` field on **both** runs.
Identical bytes give an identical count, so the number is reproducible rather
than estimated — and if two repeats of one arm ever disagree, the run says so,
because on identical input they shouldn't.

**Cached input is counted at full weight.** Providers report cached tokens
separately, and the two dialects disagree about what their input field means:
Anthropic's `input_tokens` *excludes* cached reads, while an OpenAI-compatible
`prompt_tokens` already *contains* them. Getting that backwards moves the
headline by the size of the cache, in our favour. Both shapes are pinned by
tests built from live payloads.

**Each run is cache-isolated.** A provider's prompt cache outlives a simulator run,
and it doesn't help both arms equally — Anyray adds the cache breakpoints, so
the optimized body caches and the bypassed one doesn't. Run the proof twice
inside the TTL and the second run's first call is already a hit. So every run
stamps a unique id into both arms, defeating the cross-run cache while leaving
the within-run repeats intact. It's disclosed in the output and it goes in both
arms, so it cannot tilt the comparison. Disable with `--no-cache-isolation`.

</details>

<details>
<summary><strong>Quality — your definition, not ours</strong></summary>

<br>

Each workload declares the facts a correct answer has to carry:

```json
{
  "title": "Find the failure in last night's logs",
  "mustInclude": ["ECONNRESET", "payments-api", "ord_88412"],
  "body": { "temperature": 0, "messages": [ "..." ] }
}
```

A fact counts as surviving only if it appeared in **every** run of that arm. One
good answer out of three is a coin landing our way, not survival.

**The asymmetry is the point.** A workload counts against us only when a fact
survived **without** Anyray and stopped surviving **with** it. If both sides miss
a fact, the model couldn't answer from that prompt in the first place — that
isn't ours, and the report says so instead of counting it. Without that rule, a
badly written check reads as harm we caused.

</details>

<details>
<summary><strong>An optional second opinion</strong></summary>

<br>

```bash
node judge.mjs
```

Your own model reads both answers, shuffled and unlabelled, and says which is
better or whether they tie. The judge is never told which side came from us, and
the grading call runs with Anyray bypassed so we can't influence it. Ten
workloads graded by one model is a small sample, and the report says so.

</details>

## "But your baseline still goes through your proxy"

It does, and that is a fair objection: the bypassed arm sends
`x-anyray-optimize: off` through the same gateway, so it measures *Anyray
forwarding unchanged*, not *no Anyray*.

That is not answerable by argument, so the repo measures it. Set
`DIRECT_BASE_URL` and `DIRECT_API_KEY` in `.env` and every workload gets a third
call, straight to your provider with nothing of ours in the path. The run then
reports whether the two baselines agree:

```
   Is the bypassed arm really a baseline?
   Yes — on all 6 workload(s) a direct call to your provider reported the SAME
   input tokens (27,705) as the call through Anyray with optimization off.
   The proxy forwards your bytes unaltered.
```

and when they do not agree, it says that instead, with the per-workload deltas —
because a baseline that is not clean makes every saving above it suspect, and
you should hear that from the tool rather than discover it yourself.

It costs one extra call per repeat per workload, and it needs your own provider
key. That key is a separate variable on purpose: on a machine enrolled with
Anyray, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are part of the routing, so
borrowing one would quietly make the "direct" arm a second gateway arm.

## Session mode: what a real harness sees

`prove.mjs` sends one request twice. A real agent doesn't work that way. It
resends a growing transcript every turn, reads most of it from the provider's
prompt cache at a fraction of the price, and decides for itself how many turns
to take. A trim that saves tokens on one request can break that cache, or send
the agent back for what was removed, so the **session** costs more even though
each request got cheaper. Per-request results don't show that. Session mode does.

```bash
node session.mjs              # 3 rounds; use --rounds 6 or more before concluding anything
```

An agent with coding-agent tools (`glob`, `read`, `grep`, `finish`) investigates a
production incident in a generated repository: about 110k tokens of pod logs, a
config, a deploy history, and a loud harmless error as a red herring. It runs
until it calls `finish`. The repository is generated from a seed, so every arm
sees the same files. Each round runs these arms at the same time:

| Arm | What it is |
| --- | --- |
| `direct` | Straight to your provider (needs `DIRECT_BASE_URL`) |
| `control` | `direct` again. **The noise floor:** two identical arms still differ, because the agent takes a different path each time |
| `anyray` | Through the gateway, optimizing, with Anyray's `anyray_retrieve` and `anyray_recall` registered as an enrolled client has them |

Requests use the Anthropic Messages format, with cache breakpoints placed where
Claude Code places them (`--no-cache` for a plain SDK loop). No `temperature` is
pinned. Cost is the real bill: uncached input, cache writes, cache reads and
output, each at its own rate. For every round it reports cost, turns and whether
the task was solved. The Anyray-to-direct cost ratio counts as a result only if
Anyray is cheaper in more than 70% of rounds **and** its upper-quartile ratio is
below 1. A result that falls inside the control arm's spread is reported as
noise.

Useful flags: `--small` builds a repository about 5x smaller, so each session
costs cents and a screening run takes minutes. `--no-cache` sends no cache
markers, like a plain SDK loop. `--arms direct,control,anyray:<name>` runs one arm
per experiment. Each `anyray:<name>` arm tags its requests with
`experiment: <name>` in `x-anyray-metadata`, so an optimizer rule on your
gateway (`when.metadata.experiment`) can decide what that arm runs, for example
one strategy on its own, without changing anyone else's traffic.

`--thinking <budget>` turns on extended thinking, and `--followups <n>` asks up
to n more questions (3 on the incident task, 2 on watch) on the same
transcript, one after each answer, as a person does in one long session. Use
them together to test thinking replay trim. A session with one prompt is a
single turn, so all of its thinking belongs to the current turn and there is
nothing the trim may remove. A session with follow-ups counts as solved only if
every prompt in it was answered.

The provider's prompt cache decides most of a session's bill, so test both
sides of it. Prompts sent back to back keep the cache warm: a rewrite of an
earlier block then costs a cache write (about 12x a read), and it pays off only
if it stays the same on every later turn. `--pause <seconds>` waits between
prompts. Past the 5-minute cache lifetime the whole transcript is billed again
at full price, which is where trimming it earns most. Each session also records
`cacheWriteByTurn`: after the first turn a stable prefix writes only what is
new, so large repeated writes mean a strategy is churning the cache.

Two tasks are built in. `--task incident` (the default) has the agent read its
way to a root cause, touching most files once. `--task watch` has it re-run the
same log command on a live clock until a fix lands, so each observation mostly
repeats the last one. That repetition is the shape that dominates real
coding-agent traffic, and it is what the dedupe and back-reference strategies
target. On the incident task they have almost nothing to act on.

A cheaper arm that solves fewer tasks is reported as **WORSE**, never as a
saving. In testing, one strategy removed every tool but `finish`, came out 92%
"cheaper", and solved 0 of 10.

It also has to be able to fail, and it will. Sessions vary a lot: in our first
round, two identical direct sessions differed by 37%.

## Does it work on models other than Claude?

Yes. Nothing in the measurement is Claude-specific — it reads whichever dialect
your gateway speaks, `/v1/chat/completions` or `/v1/messages`, and takes the
token counts from whatever `usage` the provider returns. If your gateway routes
it, this measures it.

Two things to know:

- **`PROOF_MODEL` must be a model your gateway actually serves.** There is no
  default, and a model it does not route fails on the first call with a message
  saying so.
- **`rates.json` prices the published catalogue** — Claude, GPT, Gemini, Grok,
  Kimi, GLM, and the open-weight models. A model that is not in it reports
  **tokens only** rather than a guessed dollar figure, because an invented rate
  under a number whose whole value is being checkable is worse than an honest
  gap. Add yours to `rates.json` if it is missing; the percentage saved does not
  depend on it.

## Retrieval, and why your real number may be higher

Anyray will not remove a span unless it can prove the client could fetch it back
— a tool matching `anyray_retrieve`. Without that proof it deliberately stands
down rather than risk a trim nothing can undo, and the report prints the
gateway's own reason.

**This harness sends one request and reads one answer, so it cannot honour a
retrieval tool** — and the shipped workloads therefore do not declare one. If
they did, the optimizer would elide spans expecting a fetch that never comes, the
model would reply *"I need to retrieve the omitted lines"*, and the run would
report a fact loss we did not cause. It detects that case and declines to judge
rather than blaming us, but the cleaner answer is not to claim the capability.

So the saving measured here is **what a non-retrieval client gets**. The savings
that do survive — deduplicating repeated tool observations, restructuring for
cacheability — are the ones that need no handle. A real Anyray-routed agent with
the MCP tools registered is retrieval-capable and sees more than this.

## What it answers

| Question | Does this repo answer it? |
| --- | :--- |
| Does Anyray actually change my prompts? | **Yes** — the report names which strategies fired |
| How many tokens does it take out? | **Yes** — exactly, from the provider's count |
| What does that save me in dollars? | **Yes** — at published list rates |
| Do the answers still contain what I need? | **Yes** — facts I declared, checked every run |
| Would a human prefer the unoptimized answer? | **Indicative** — blind grading, small sample |
| Does my whole agent session get cheaper? | **Indicative** — `session.mjs`, on a fixed task, against a measured noise floor. Your own traffic over weeks: the gateway's audited holdout |

## Your prompts stay yours

Everything the setup prompt writes into `workloads/` is your own traffic, and
`.gitignore` keeps all of it — plus `results.json` and `report.html`, which hold
both models' answers — out of git. Nothing is sent anywhere except through the
gateway your traffic already flows through, and `report.html` loads no external
resources, so opening it makes no third-party request either.

Check rather than take our word:

```bash
git check-ignore -v .env results.json report.html
git status --short          # your captured workloads must not appear here
```

### Sending the result to whoever asked

The full `report.html` holds your prompts and both models' answers, which makes
it a poor thing to email. `node report.mjs --redact` writes
`report-shareable.html` with the same verdicts, token counts, percentages,
per-workload rows and strategy names — and no prompts, no answers, and no
required-fact strings, since a fact is a verbatim value out of your own data.

It tells you what it kept rather than claiming to be clean: your workload ids,
your gateway host and your model name are still in the file, because a reader
has to be able to refer to a row. Read it before you send it.

[SECURITY.md](./SECURITY.md) has the reporting process, and a plain list of what
this tool does **not** protect you from.

## Files

| | |
| --- | --- |
| `SETUP-PROMPT.md` | Paste into your coding agent. It captures your workloads. |
| `prove.mjs` | Both arms, both verdicts. The one command. |
| `judge.mjs` | Optional blind grading. |
| `session.mjs` | Session mode: whole agent sessions, direct vs control vs Anyray. |
| `report.mjs` | Writes `report.html`. |
| `rates.json` | Published list prices. Edit if your contract rate differs. |
| `workloads/` | Four worked examples. Yours land here, gitignored — and once any of yours exist, the examples are skipped (`--examples` forces them back). |

## The other half of the evidence

| | What it is | Whose numbers |
| --- | --- | --- |
| [`anyrayHQ/benchmarks`](https://github.com/anyrayHQ/benchmarks) | 40 synthetic workloads plus 8 public corpora, run against the optimizer with its results **committed** | ours, and anyone reproduces them |
| this repo | your prompts, your gateway, your provider's `usage` field | **yours alone**, and never committed |

The value proposition is inverted on purpose. Benchmarks is credible *because*
its results are in the tree and you can re-run them and get the same figures.
This is credible *because* the figures are yours and we never see them. Want
numbers you can check against ours? Go there. Want numbers from your own
traffic? You are in the right place.

## Troubleshooting

<details>
<summary><strong>Common failures and what they mean</strong></summary>

<br>

**`missing ANYRAY_GATEWAY_URL` / `missing ANYRAY_API_KEY`** — copy
`.env.example` to `.env` and fill it in.

**`gateway 401` or `gateway 402`** — the key isn't valid for that gateway, or
enrollment lapsed. `anyray-connect doctor --json` reports which.

**Every workload reports 0%** — check the Strategies column. Empty everywhere
means nothing fired: either the workloads are the wrong shape (a single pasted
log is one message; the eliding strategies target *agent* traffic, where the
same observation comes back turn after turn), or that deployment has them
disabled. A `stood down` note gives the gateway's own reason.

**`repeats disagree on input tokens`** — something varied between two runs of the
*same* arm that shouldn't have: a system prompt with a timestamp in it, or a
non-deterministic provider. Worth chasing before you trust the delta.

**`NOT MEASURED: the optimizer reported "timeout"`** — that request went through
unoptimized, so the row is a measurement of nothing. Re-run it.

</details>
