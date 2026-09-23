# Proof run

Point this at your own Anyray gateway, give it your own prompts, and run one
command. It sends each prompt twice — once with Anyray bypassed, once the normal
way — and answers two questions with numbers you can check:

1. **Does it cost less?** Input tokens, taken from your provider's own `usage`
   field on both runs.
2. **Are the answers still right?** Checked against facts *you* declared a
   correct answer has to carry.

Neither number is ours to adjust. Same model, same key, same path — one header
is the only difference between the two runs.

---

## What this proves, and what it doesn't

**This proves per request. It does not prove per session.**

Every number here compares one request sent twice. A live coding agent reacts to
what changed: if a reply is shaped differently it may take a different number of
turns, and a per-request saving is not the same as a cheaper session. Proving
*that* takes weeks of your real traffic, and it's what the gateway's audited
holdout is for. Don't let anyone — including us — read this report as a
session-level verdict.

| Question | Does this repo answer it? |
|---|---|
| Is Anyray actually in my request path? | **Yes** — setup fails loudly if it isn't |
| How many tokens does it take out of my prompts? | **Yes** — exactly, from the provider's count |
| What does that save me in dollars? | **Yes** — at published list rates |
| Do the answers still contain what I need? | **Yes** — facts you declared, checked on every run |
| Would a human prefer the unoptimized answer? | **Indicative** — blind grading, small sample |
| Does my whole agent session get cheaper? | **No** — use the gateway's audited holdout |

---

## Five steps, about twenty minutes

```
1. Clone this repo             public, no account
2. Paste SETUP-PROMPT.md       into your coding agent
3. It captures your workloads  your prompts + the facts that matter
4. node prove.mjs              the proof run
5. node report.mjs             open report.html
```

Steps 2 and 3 are the point: your own coding agent does the setup and the
capture, so there's no wizard to babysit and **you** picked the workloads.

```sh
git clone https://github.com/anyrayHQ/proof-run.git
cd proof-run
cp .env.example .env          # gateway URL, client key, model, repeats
# paste SETUP-PROMPT.md into Claude Code / Cursor / your agent of choice
node prove.mjs
node report.mjs && open report.html
```

Requires Node 20+. No dependencies, no `npm install`, no account.

### What it costs you

Each workload is **2 × `PROOF_REPEATS` provider calls on your bill** — six by
default. Ten workloads is sixty calls. Three runs per arm is the default because
a model's answer varies between identical runs, and one sample can't tell a real
change from ordinary variation. Drop it to 1 for a smoke test; that's a smoke
test, not a proof.

---

## What it measures

### Cost is exact

Input token counts come from the provider's own `usage` field on **both** runs.
Identical bytes give an identical count, so the number is reproducible rather
than estimated — and if the two repeats of one arm ever disagree, the run says
so, because on identical input they shouldn't.

Cached input is counted at full weight. Providers report cached tokens
separately, and on Anthropic `input_tokens` *excludes* them — so reading that
field alone would let a warm prompt cache show up as a saving we didn't earn.
The headline count is every input-side token the provider reported:

```
billed input = uncached input + cache writes + cache reads
```

The run also alternates which arm goes first across repeats, so neither arm gets
the warm side every time.

### Quality is your definition

Each workload declares the facts a correct answer has to carry. After every run,
the answer is checked for each one.

```json
{
  "title": "Find the failure in last night's logs",
  "mustInclude": ["ECONNRESET", "payments-api", "ord_88412"],
  "body": { "temperature": 0, "messages": [ "..." ] }
}
```

A fact counts as surviving only if it appeared in **every** run of that arm —
one good answer out of three is a coin landing our way, not survival.

**The asymmetry is the point.** A workload counts as a regression only when a
fact survived **without** Anyray and stopped surviving **with** it. If both sides
miss a fact, the model couldn't answer the question from that prompt in the first
place, or the fact was written wrong — either way it isn't damage we caused, and
the report says so instead of counting it. Without that rule, a badly written
check reads as harm.

When a trim does break something, the run names what was lost and exits non-zero:

```
example-01-log-dump    9,036 → 2,892   68%  LOST FACTS (2/3 vs 3/3)
  ! only missing with Anyray on: ECONNRESET
```

That path is tested, not assumed — `tests/end-to-end.test.mjs` runs the whole
thing against a mock gateway in both states, and the regression case is what
shows the quality check is load-bearing rather than decorative.

### An optional second opinion

```sh
node judge.mjs
```

Shows your own model both answers, shuffled and unlabelled, and asks which is
better or whether they tie. The judge is never told which side came from us, and
the grading call runs with Anyray bypassed so we can't influence it. Ten
workloads graded by one model is a small sample, and the report says so.

---

## Files

| | |
|---|---|
| `SETUP-PROMPT.md` | Paste into your coding agent. It does steps 2 and 3. |
| `prove.mjs` | Both arms, both verdicts. The one command. |
| `judge.mjs` | Optional blind grading. |
| `report.mjs` | Writes `report.html`. |
| `rates.json` | Published list prices. Edit if your contract rate differs. |
| `workloads/` | Three worked examples. Yours land here and are **gitignored**. |
| `.env.example` | Gateway, key, model, repeats. |

One of the three examples (`example-02-small-question`) saves nothing at all.
It's there on purpose: a short question has nothing worth removing, and you
should see an honest 0% in your own report before you believe any of the other
numbers.

### Your prompts stay yours

Everything the setup prompt writes into `workloads/` is your own traffic, and
`.gitignore` keeps all of it — plus `results.json` and `report.html`, which hold
both models' answers — out of git. Nothing leaves your machine except the
requests you were going to send to your own gateway anyway.

---

## Why this isn't in the benchmarks repo

| | [`benchmarks`](https://github.com/anyrayHQ/benchmarks) | `proof-run` |
|---|---|---|
| Points at | the optimizer on `:8088` | your gateway |
| Credential | admin token | a client key |
| Payloads | synthetic, committed | yours, never committed |
| Token counts | tokenizer estimate | provider's `usage` field |
| Calls a provider | no | yes, on your bill |
| Results | committed — anyone reproduces them | private, unique to you |

The value proposition is inverted. Benchmarks is credible *because* its results
are committed and anyone gets the same numbers. This is credible *because* the
numbers are yours alone. Want numbers you can check against ours?
[anyrayHQ/benchmarks](https://github.com/anyrayHQ/benchmarks). Want numbers from
your own traffic? You're in the right place.

---

## Troubleshooting

**`missing ANYRAY_GATEWAY_URL` / `missing ANYRAY_API_KEY`** — copy
`.env.example` to `.env` and fill it in.

**`gateway 401` or `gateway 402`** — the key isn't valid for that gateway, or
enrollment lapsed. `anyray-connect doctor --json` reports which.

**Both arms report identical token counts on every workload** — the bypass
header isn't reaching the optimizer, so you're measuring the same path twice.
Check that the URL is your Anyray gateway and not the provider directly.

**`repeats disagree on input tokens`** — something varied between two runs of
the *same* arm that shouldn't have: a system prompt with a timestamp in it, or a
non-deterministic gateway. Worth chasing before you trust the delta.
