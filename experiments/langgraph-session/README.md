# Session experiment (LangGraph)

The repo above this one proves a **per-request** saving: one request, sent
twice, compared. It says so on its own front page, because that is the honest
limit of a paired bench.

This measures the other thing. A LangGraph agent investigates an incident, and
runs until it decides it is done — so **turns are an outcome, not a parameter**.
That is the number a replay harness structurally cannot produce: a recorded
transcript's turns already happened under whatever policy was live.

It matters because a per-call saving and a per-session saving can point in
opposite directions. If the optimizer removes context the agent then goes back
for, tokens per call fall and turns rise, and the bill can end up flat or worse.
A per-request bench sees only the first half of that and reports a win.

## The two arms

| | Route | What it measures |
|---|---|---|
| `direct` | your provider, no gateway | the real counterfactual |
| `anyray` | your gateway, the ordinary request | the deployed pipeline |

The direct arm takes its key from `DIRECT_API_KEY` and nothing else. On a
machine enrolled with Anyray, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` *are*
the routing — borrowing one is how a "direct" control quietly goes through the
gateway and produces a null result that looks rigorous. A routing check runs
before any call: a direct arm resolving to an `anyray` host is refused.

## Run it

```bash
python3.12 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
cp .env.example .env          # both arms, and your own provider key
./.venv/bin/python run.py --dry-run     # config + task, calls nothing
./.venv/bin/python run.py --episodes 5
```

**Each episode is a full agent session on your bill** — several model calls and
tens of thousands of input tokens. Start with `--episodes 1`.

## What it reports

```
                          direct      anyray
  episodes completed           5           5
  task passed                  5           5
  turns / session           4.20        4.60
  input tokens / session  47,115      31,880
  cost / session          $0.1414     $0.1002

  Cost per session: -29.1% with Anyray.
  Turns per session: +0.40. This is the number a per-request bench cannot see.
```

Arms alternate per episode, so a slow patch at the provider lands on both.
Results are written after every episode.

## Read it carefully

- **Small samples say nothing.** Five episodes per arm cannot separate a 5%
  difference from noise. The agentbench harness in the optimizer lab exists for
  the same question at n>1,000, and its t1 result — ~10% fewer tokens per call,
  four more turns, session slightly *more* expensive — is exactly the shape this
  is built to expose.
- **One task is one shape.** The task here is tool-output-heavy on purpose,
  which is where eliding strategies have the most to remove and the most to get
  wrong. Another task would give another answer.
- **The grader is substring survival**, the same rule the per-request simulator
  uses: it is biased toward reporting damage rather than hiding it.
