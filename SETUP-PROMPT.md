# Setup prompt

**Paste everything below the line into your coding agent**, from inside a
checkout of this repo, with your own project open. It's written for an agent to
execute, not for a person to read.

It will check your provider config and the local container, find real prompts in
your project, turn the ten most typical into workloads, work out the facts each
answer must carry, scrub anything sensitive, and then stop and show you what it
captured. It will **not** run the proof — you do that, after you've looked.

---

You are setting up a proof run for the Anyray gateway. Work through these steps
in order. Stop at the end of step 6 and report back; do not run `prove.mjs`.

## Step 1 — Configure

Read `.env.example`. Copy it to `.env` if `.env` doesn't already exist.

Ask the person for:

- **their provider base URL** — Anthropic, OpenAI, or a model they host
  themselves
- **their own provider API key** — theirs, not an Anyray one. There is no Anyray
  account involved in this at all.
- **the model** to prove it on — one they actually run in production

Write the answers into `.env`. **Never print the key** — not in your reply, not
in a summary, not into any other file. Do not commit `.env`; it's gitignored,
and it must stay that way.

If they are uneasy about running real prompts against a hosted provider at all,
point out that `PROVIDER_BASE_URL` accepts a local model (Ollama, vLLM, LM
Studio). With one of those, nothing leaves the machine.

## Step 2 — Verify the plumbing, cheaply

Two checks. Do both before capturing anything.

**The container is up and warm:**

```sh
curl -sS http://localhost:8088/health
```

`ready` must be `true` and `embedder` must not be `loading`. If the container
isn't running, `docker compose up -d`; if the embedder is still loading, wait.
A cold optimizer silently measures a different pipeline, so this matters more
than it looks.

**The provider answers, and the whole loop works** — one cheap workload, six
calls:

```sh
node prove.mjs --workload example-02
```

That one is a short question with nothing to trim, so it should report roughly
0% saved and keep its facts. If it fails:

- **`provider 401`** — wrong key, or wrong dialect. The error names the dialect
  it used; set `PROVIDER_DIALECT` to the other one.
- **`did not become ready`** — the container. See above.
- **connection refused** — `PROVIDER_BASE_URL` is wrong.

**Do not continue to step 3 until that run succeeds.** Capturing ten workloads
against broken config wastes their time and their money.

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
  example, so don't overwrite those.

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
   their own provider bill
5. that they run `node prove.mjs` themselves when they're happy

Do not run `node prove.mjs`. It spends their money, and they should look at the
workloads first.
