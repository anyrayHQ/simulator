# The optimizer container

`proof-run` needs one thing from the Anyray side: a container that exposes two
endpoints on `localhost:8088`. This file is the contract. Anything that answers
these two calls will work; the client in this repo talks to nothing else.

The mock in `tests/mock-optimizer.mjs` implements exactly this contract, which
is how the client side is tested without the real image.

## `GET /health`

```json
{
  "ready": true,
  "embedder": "warm",
  "optimizerVersion": "1.14.2",
  "defaultsRevision": 7
}
```

| Field | Meaning |
|---|---|
| `ready` | The container can serve `/v1/optimize` correctly. `false` while still loading. |
| `embedder` | `loading` \| `warm` \| `disabled`. Omit the field entirely on a build with no semantic strategies. |
| `optimizerVersion` | Which build produced these numbers. Goes in the report. `null` is reported honestly as unknown. |
| `defaultsRevision` | Which defaults the pipeline is running. |

**`ready` must stay `false` until the embedding model is resident.** This is the
one requirement that is not negotiable, and it is not defensive programming.

The optimizer's embedder loads lazily, and until it is resident the semantic
strategies silently fall back to lexical ranking. The container still answers,
still returns a transformed request, and still reports a saving — just a
different one, from a different pipeline. In the benchmarks suite this produced
a **33-point swing on identical input**: `33-synonym-gap-logs` measured 94%
saved / 50% key facts **FAIL** as the first row of a cold run, and 61% / 100%
**PASS** re-run against the same optimizer once warm.

In a customer's hands that is the worst failure we can ship. The first workload
is the one they are watching, and a cold container can show them a fact loss we
did not cause. `prove.mjs` polls `/health` and refuses to measure until it is
ready — but it can only refuse if the container tells the truth here.

## `POST /v1/optimize`

Request:

```json
{
  "endpoint": "/v1/chat/completions",
  "request": { "model": "…", "messages": [ … ], "tools": [ … ] },
  "metadata": { "tool": "proof-run" }
}
```

Response:

```json
{
  "request": { "…the transformed body…" },
  "decisions": [{ "strategy": "context_compression" }, { "strategy": "relevance_filter" }]
}
```

- `request` is **required**. A response without it is treated as an error, not
  as a zero saving — a transform that did not happen must never be measured as
  "Anyray saved nothing".
- `decisions[].strategy` (or `.kind` / `.name`) feeds the "which strategies
  fired" column in the report. An empty array is fine.
- **The default pipeline, unchanged.** No admin token, no per-strategy pinning.
  The customer measures what they would actually get on a default install, not
  a hand-tuned configuration.

## What the image must not do

- **No phone-home.** No licence check, no telemetry, no config fetch. The claim
  this repo makes — that no prompt reaches Anyray — has to survive someone
  running `docker run --network none` and watching it still work.
- **No prompt persistence.** Nothing written to disk that outlives the
  container, and nothing logged beyond token counts.
- **Bound to localhost.** `compose.yml` publishes to `127.0.0.1:8088`, so this
  is belt-and-braces, but the image should not assume otherwise.

## Open, and blocking

1. **Can the optimizer run standalone?** If it needs to reach an Anyray service
   on startup for defaults, licensing or strategy config, the privacy claim dies
   and this design changes shape. This is the question to answer first.
2. **How big is the image with the embedding model?** "Easy" dies somewhere
   north of a few GB, and a prospect on a hotel wifi is exactly who we are
   trying to convince.
3. **Which registry, and is it public?** `compose.yml` assumes
   `ghcr.io/anyrayhq/optimizer`. A private registry means a login step, which
   means an account, which is the thing we removed.
