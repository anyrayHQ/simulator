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
node prove.mjs                # the run
node report.mjs               # writes report.html
```

Node 20+. No `npm install`, no dependencies, no account beyond the client key you
already have.

> **This spends your provider budget.** Each workload costs 2 × `PROOF_REPEATS`
> calls — six by default. Ten workloads ≈ 60 calls. The run prints the count
> before it starts.

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
outcome and the tool says so.** A proof tool that cannot return a bad verdict is
marketing, and an evaluator spots that in the first five minutes. The failure
path is tested, not asserted — `npm test` runs the whole thing against a mock
gateway in both states.

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

## What it answers

| Question | Does this repo answer it? |
| --- | :--- |
| Does Anyray actually change my prompts? | **Yes** — the report names which strategies fired |
| How many tokens does it take out? | **Yes** — exactly, from the provider's count |
| What does that save me in dollars? | **Yes** — at published list rates |
| Do the answers still contain what I need? | **Yes** — facts I declared, checked every run |
| Would a human prefer the unoptimized answer? | **Indicative** — blind grading, small sample |
| Does my whole agent session get cheaper? | **No** — use the gateway's audited holdout |

## Your prompts stay yours

Everything the setup prompt writes into `workloads/` is your own traffic, and
`.gitignore` keeps all of it — plus `results.json` and `report.html`, which hold
both models' answers — out of git. Nothing is sent anywhere except through the
gateway your traffic already flows through.

## Files

| | |
| --- | --- |
| `SETUP-PROMPT.md` | Paste into your coding agent. It captures your workloads. |
| `prove.mjs` | Both arms, both verdicts. The one command. |
| `judge.mjs` | Optional blind grading. |
| `report.mjs` | Writes `report.html`. |
| `rates.json` | Published list prices. Edit if your contract rate differs. |
| `workloads/` | Three worked examples. Yours land here, gitignored. |

## Why this isn't in the benchmarks repo

| | [`benchmarks`](https://github.com/anyrayHQ/benchmarks) | `anyray-simulator` |
| --- | --- | --- |
| Points at | the optimizer on `:8088` | your gateway |
| Credential | admin token | a client key |
| Payloads | synthetic, committed | yours, never committed |
| Token counts | tokenizer estimate | provider's `usage` field |
| Calls a provider | no | yes, on your bill |
| Results | committed — anyone reproduces them | private, unique to you |

The value proposition is inverted. Benchmarks is credible *because* its results
are committed and anyone gets the same numbers. This is credible *because* the
numbers are yours alone.

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
