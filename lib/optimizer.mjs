// The Anyray optimizer, running in a container on the customer's own machine.
//
// Two calls, both local:
//   GET  /health         is it up, and is the embedding model resident yet?
//   POST /v1/optimize    run the pipeline over a request, get it transformed
//
// We talk to it over its public contract only — the same contract the gateway
// uses — so the container can be rebuilt without touching this repo. No admin
// token and no config changes: the customer measures the DEFAULT pipeline,
// which is what they would actually get, rather than a per-strategy pin.

import { fetchRetry } from './http.mjs';

export class Optimizer {
  constructor({ url, timeoutMs = 30000, fetchImpl = fetch }) {
    this.url = String(url).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async health() {
    const res = await this.fetch(`${this.url}/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`optimizer /health returned ${res.status}`);
    return res.json();
  }

  /**
   * THE READINESS GATE, and it is not ceremony.
   *
   * The optimizer's embedding model loads lazily. Until it is resident the
   * semantic strategies silently fall back to lexical ranking — the optimizer
   * still answers, still returns a transformed request, and still reports a
   * saving. It is just a DIFFERENT saving, on a different trim, and the answer
   * quality can differ with it.
   *
   * This is measured, not theoretical: in the benchmarks suite the same
   * workload scored 94% saved / 50% key facts FAIL as the first row of a cold
   * run, and 61% / 100% PASS re-run against the same optimizer once warm. A
   * 33-point swing on identical input, decided by nothing but running order.
   *
   * In a customer's hands that is the worst bug available to us: the first
   * workload is the one they are watching, and a cold container can show them a
   * fact loss we did not cause. So we wait, visibly, and refuse to measure
   * until the container says it is ready.
   */
  async waitUntilReady({ timeoutMs = 180000, pollMs = 2000, onWait = () => {} } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let announced = false;
    for (;;) {
      try {
        const h = await this.health();
        last = h;
        // `embedder` absent means a build with no semantic strategies; that is a
        // legitimate configuration, not a cold start, so `ready` alone governs.
        const warm = h.embedder == null || ['warm', 'ready', 'disabled'].includes(h.embedder);
        if (h.ready !== false && warm) return h;
      } catch (e) {
        last = { error: e.message };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `the optimizer at ${this.url} did not become ready within ${Math.round(timeoutMs / 1000)}s ` +
            `(last: ${JSON.stringify(last)}).\n` +
            `Measuring against a cold optimizer produces a real number for the wrong pipeline, so this run stops instead.`
        );
      }
      if (!announced) {
        onWait(last);
        announced = true;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Which optimizer produced these numbers. Null fields report honestly. */
  async provenance() {
    try {
      const h = await this.health();
      return {
        optimizerVersion: h.optimizerVersion ?? null,
        defaultsRevision: h.defaultsRevision ?? null,
        embedder: h.embedder ?? null,
      };
    } catch {
      return { optimizerVersion: null, defaultsRevision: null, embedder: null };
    }
  }

  /** Run the default pipeline over one request. Returns the transformed body. */
  async optimize(request, { endpoint = '/v1/chat/completions' } = {}) {
    const res = await fetchRetry(
      `${this.url}/v1/optimize`,
      () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, request, metadata: { tool: 'proof-run' } }),
      }),
      { timeoutMs: this.timeoutMs, fetchImpl: this.fetch }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST /v1/optimize failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    if (!body?.request) {
      throw new Error('optimizer returned no `request` — cannot measure a transform that did not happen');
    }
    const strategies = (body.decisions ?? [])
      .map((d) => d?.strategy ?? d?.kind ?? d?.name)
      .filter(Boolean);
    return { request: body.request, strategies, decisions: body.decisions ?? [] };
  }
}
