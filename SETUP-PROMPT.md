# Setup prompt

**Paste everything below the line into your coding agent**, from inside a
checkout of this repo, with your own project open. It's written for an agent to
execute, not for a person to read.

It will check whether this is worth doing at all, ask for your gateway URL and
key, verify that a request actually succeeds, find the prompts your project
really sends, turn the ten most typical into workloads, work out the facts each
answer must carry, scrub anything sensitive, and then stop and show you what it
captured. It will **not** run the proof — you do that, after you've looked.

It is also told when to stop and say "don't bother", which matters more than the
happy path: a report built on prompts that were never yours proves nothing, and
costs you provider budget to produce.

---

You are setting up a simulator run for the Anyray gateway. Work through these
steps in order. Gather facts first, state a plan, get a yes, then act. Stop at
the end of step 6 and report back; do not run `prove.mjs`.

## Step 0 — Preflight, and whether this is worth doing at all

Read-only. Change nothing and install nothing yet.

```sh
node --version                      # needs >= 20
git rev-parse --show-toplevel       # are we inside the simulator checkout?
ls .env 2>/dev/null                 # already configured?
command -v anyray-connect           # is this machine enrolled?
```

Then look at the project the person actually wants measured — not this repo —
and answer one question before anything else: **does this project send prompts
to a model?** Grep it for a `messages` array, a system prompt, an SDK client, a
recorded transcript.

### When to tell them not to bother

Say so plainly and stop. A setup that produces a meaningless report wastes their
provider budget and their afternoon, and it costs us more credibility than
having no tool at all.

- **No real prompts in the project.** If it consumes a hosted agent rather than
  calling models itself, there is nothing here to capture. Ask whether they can
  paste two or three prompts they actually send. If they cannot, stop.
- **No gateway yet.** This measures a deployed Anyray gateway on their own
  traffic. Without one there is nothing to bypass, and the two arms are
  identical. Point them at `anyrayHQ/benchmarks` instead — committed results
  anyone can reproduce — and stop.
- **They want a session-level answer.** "Will my agent bill go down" is not what
  this measures, and a per-request number read as a session verdict is exactly
  how these conversations go wrong. Say so, point at the gateway's audited
  holdout, and stop.
- **They have not agreed to spend provider budget.** Every workload costs
  2 × `PROOF_REPEATS` real calls. Ten workloads is about sixty. Get a yes.
- **The prompts cannot be scrubbed.** If the real traffic is regulated data and
  removing it would leave a prompt that no longer means anything, this is the
  wrong instrument. Stop rather than measuring a sanitised fiction.

### State the plan and wait

Before changing anything, tell them in plain language:

1. which workloads you intend to capture, and from where
2. that their prompts will be written to `workloads/` on this machine —
   gitignored, but real traffic on disk
3. what the run will cost in provider calls, and that it is their bill
4. that this proves per request, not per session
5. how to undo it — delete `workloads/*` and `.env`

Wait for an explicit yes. Then continue.

## Step 1 — Configure

Read `.env.example`. Copy it to `.env` if `.env` doesn't already exist.

Ask the person for:

- **the Anyray gateway URL** — the base URL their tools already send model calls
  to
- **an Anyray client key** (`ark_…`) — a client key, not an admin token
- **the model** to prove it on — the id their application actually sends. There
  is no default and you must not invent one: every deployment routes a different
  set, and a model this gateway does not serve fails on the first call. If they
  are unsure, their Anyray console lists what it serves.

If this machine is enrolled with Anyray, the gateway URL may already be
discoverable: `anyray-connect doctor --json` reports the gateway it routes to.
Offer what you find as the default; don't assume it's right.

Write the answers into `.env`. **Never print the key** — not in your reply, not
in a summary, not into any other file. Do not commit `.env`; it's gitignored,
and it must stay that way.

## Step 2 — Verify Anyray is actually in the path

Before anything else, prove the plumbing works. Do not hand-roll a `curl` for
this — the values live in `.env`, which is not exported into your shell, so a
command referencing `$ANYRAY_GATEWAY_URL` silently sends a request to nowhere.
Use the repo's own smoke test, which reads `.env` the same way the real run
does:

```sh
node prove.mjs --workload example-02
```

That is six calls against a deliberately trivial workload, and it exercises the
whole path: both arms, the bypass header, the provider's usage field, and the
fact check.

**It should report roughly 0% saved and keep its facts.** That workload is a
short question with nothing worth trimming, so 0% is the correct answer, not a
failure.

If it fails, the run names the cause. The four you are likely to hit:

- **`PROOF_MODEL is "..." and this gateway does not serve it`** — every
  deployment routes a different set of models. Ask them which model their
  application actually sends, and use that; the dollar figure depends on its
  rate. Do not guess another name.
- **`ANYRAY_API_KEY is not valid`** — wrong key, or one minted for a different
  deployment. Suggest `anyray-connect doctor --json`. Stop and report.
- **`402 ... no entitlement lease`** — the deployment will not serve `/v1/*` at
  all. Nothing in `.env` fixes this. Stop and tell them to talk to whoever runs
  the gateway.
- **`Nothing answered at ...`** — wrong host, or it is not reachable from here.

**Do not continue to step 3 until that run succeeds.** Capturing ten workloads
against broken config wastes their time and their money, and a simulator run
against a gateway that is not in the path measures nothing while looking like a
result.

## Step 3 — Find their real prompts

Search this project for prompts that are actually sent to a model. Look for:

- request bodies with a `messages` array, in source, tests, or fixtures
- prompt templates and system prompts held in files or constants
- recorded transcripts, cassettes, eval sets, or logged request payloads
- the prompts inside any agent, RAG, or tool-calling code

Prefer **big, repetitive, real** prompts over small pretty ones: a pasted log, a
file the agent re-read, a tool catalogue sent on every turn, a long retrieved
context. Those are where a gateway either earns its keep or doesn't.

Read `workloads/example-01-log-dump.json` and
`workloads/example-03-tool-bloat.json` for the shapes that matter most.

If the project has no prompts in it — it's a consumer of a hosted agent rather
than a codebase that calls models — say so and ask the person to paste two or
three prompts they actually send. Don't invent prompts. A proof on made-up
traffic is worth nothing to them.

## Step 4 — Write ten workloads

Pick the **ten most typical**, not the ten most flattering. Deliberately include
at least one short prompt with nothing to trim — a run where every workload wins
is a run nobody believes, and `example-02-small-question` is there to make that
concrete.

Write each to `workloads/<nn>-<short-slug>.json`:

```json
{
  "title": "One line: what this prompt is for",
  "mustInclude": ["ECONNRESET", "payments-api", "ord_88412"],
  "body": {
    "temperature": 0,
    "messages": [{ "role": "user", "content": "…the real prompt…" }]
  }
}
```

Rules:

- **Do not set `body.model`.** The model comes from `.env` so both arms match.
- **Do not set `body.stream`.**
- Keep `temperature` at 0 where the API allows it. Less run-to-run variation
  means the fact check measures the gateway, not the dice.
- Include `tools` in `body` if the real request carries them — a tool catalogue
  is often most of the prompt.
- Name the files `01-`…`10-`. Anything matching `example-*` is a shipped
  example, so don't overwrite those — and once at least one workload of theirs
  exists, `prove.mjs` skips the examples automatically. They are our fixtures;
  the customer should not be paying to re-measure them.

## Step 5 — Work out the required facts

This is the part that takes judgement. For each workload, `mustInclude` is the
short list of things an answer **must** contain to be correct — the customer's
own definition of a right answer, which is what makes the quality verdict theirs
rather than ours.

Good facts are **short, verbatim, and load-bearing**: an error code
(`ECONNRESET`), an identifier (`ord_88412`), a service name (`payments-api`), a
function name, a number that carries the answer.

Bad facts, and why:

- **Prose** — `"explains the root cause clearly"`. Can't be checked by substring
  and will read as a failure when the answer is fine.
- **Anything the model would say anyway** — `"error"`, `"the"`. Proves nothing.
- **Things not in the prompt.** If the answer isn't derivable from the context,
  both arms miss it, and the workload is discarded as inconclusive. Wasted calls.
- **Long exact sentences.** A reworded answer is still a correct answer.

Two to four facts per workload is usually right. Matching is case-insensitive
and ignores runs of whitespace; nothing else is normalized.

If you can't state what a correct answer must contain, that prompt is a poor
workload. Drop it and pick another.

## Step 6 — Scrub, validate, and stop

**Scrub before you finish.** These files hold real traffic. Replace, consistently
across each workload so the prompt still makes sense:

- API keys, tokens, passwords, connection strings — remove entirely
- customer names, email addresses, phone numbers
- internal hostnames and IPs, where they aren't the point of the prompt
- anything under NDA or covered by their data policy

If a fact you chose is itself sensitive, choose a different fact rather than
leaving the sensitive one in. `workloads/` is gitignored, but the files are still
on disk and the prompts still go to a provider.

Validate what you wrote — this calls nothing and costs nothing:

```sh
node prove.mjs --dry-run
```

Fix anything it reports. Then **stop** and tell the person:

1. which workloads you captured, one line each, and why you picked them
2. the `mustInclude` facts for each, so they can correct your judgement — you
   are guessing at what their right answer looks like, and they aren't
3. what you scrubbed
4. what the run will cost: 2 × `PROOF_REPEATS` provider calls per workload, on
   their bill
5. that they run `node prove.mjs` themselves when they're happy

Do not run `node prove.mjs`. It spends their money, and they should look at the
workloads first.

## Keep the claims bounded

If they ask what this proves, keep every answer factual and limited. The tool's
whole value is that an evaluator can check it, so overselling here costs more
than it gains.

- **Per request, not per session.** A live agent reacts to what changed and may
  take a different number of turns. We have measured this: on one agent task the
  optimizer cut tokens per call about 10% and the session took four more turns,
  ending up slightly more expensive. Both numbers are true. This tool sees the
  first and cannot see the second.
- **The token counts are the provider's, the facts are theirs.** Neither is ours
  to adjust. That is the point, and it is the strongest thing you can say.
- **It can return a bad verdict, and that is deliberate.** If a required fact
  stops surviving, the run says so and exits non-zero, cost win or not.
- **A 0% row is a real result, not a broken tool.** It can mean the prompt had
  nothing worth removing, or that the deployment has those strategies off. The
  report prints the gateway's own reason. Do not explain it away.
- **Quality checking is substring survival, not comprehension.** A fact that the
  model paraphrased away counts as missing. That is a deliberate bias toward
  reporting damage rather than hiding it, and it means false alarms are possible
  and false reassurance is less so.
- **Nothing leaves their infrastructure** beyond the requests that already flow
  through their own gateway. The repo sends nothing to Anyray.
