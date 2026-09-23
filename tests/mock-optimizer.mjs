// A stand-in for the Anyray optimizer container. Implements the two endpoints
// proof-run actually uses, so the client side can be verified end to end before
// the real image exists.
//
//   GET  /health        { ready, embedder, optimizerVersion, defaultsRevision }
//   POST /v1/optimize   { endpoint, request, metadata } -> { request, decisions }
//
// Modes:
//   healthy    trims the context but keeps every answer-bearing line
//   dropping   the trim also loses a fact — the state that proves the quality
//              check is load-bearing rather than decorative
//   cold       stays `embedder: "loading"` for a while before going warm, so
//              the readiness gate has something real to wait for
//   stuck      never becomes ready; the run must refuse rather than measure
//
//   node tests/mock-optimizer.mjs dropping 8088

import { createServer } from 'node:http';

/** Keep the lines that carry an answer, drop the routine ones. */
function trimMessages(messages, { dropFirstFact = false }) {
  return messages.map((m) => {
    if (typeof m.content !== 'string') return m;
    const lines = m.content.split('\n');
    if (lines.length < 8) return m; // nothing worth trimming
    const interesting = lines.filter(
      (l) => /ERROR|WARN|ECONNRESET|failed|504|search_logs/i.test(l) || !/INFO|heartbeat/i.test(l)
    );
    const kept = dropFirstFact
      ? interesting.filter((l) => !l.includes('ECONNRESET') && !l.includes('search_logs'))
      : interesting;
    return { ...m, content: kept.join('\n') };
  });
}

export function startMockOptimizer({ mode = 'healthy', port = 0, warmAfterMs = 0 } = {}) {
  const startedAt = Date.now();
  const server = createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      const warm =
        mode === 'stuck' ? false : Date.now() - startedAt >= warmAfterMs;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ready: warm,
          embedder: warm ? 'warm' : 'loading',
          optimizerVersion: 'mock-0.1.0',
          defaultsRevision: 7,
        })
      );
      return;
    }

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const { request } = JSON.parse(raw || '{}');
      const dropFirstFact = mode === 'dropping';
      const out = { ...request };
      const decisions = [];

      if (Array.isArray(request?.messages)) {
        const before = JSON.stringify(request.messages).length;
        out.messages = trimMessages(request.messages, { dropFirstFact });
        const after = JSON.stringify(out.messages).length;
        if (after < before) decisions.push({ strategy: 'context_compression' });
      }
      // A large tool catalogue is most of an agent's prompt; keep the ones the
      // question could plausibly need.
      if (Array.isArray(request?.tools) && request.tools.length > 4) {
        out.tools = dropFirstFact
          ? request.tools.filter((t) => t?.function?.name !== 'search_logs').slice(0, 4)
          : request.tools.filter((t) => /log|alert|metric|incident/.test(t?.function?.name ?? '')).slice(0, 4);
        decisions.push({ strategy: 'relevance_filter' });
      }

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ request: out, decisions }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] || 'healthy';
  const port = Number(process.argv[3] || 8088);
  const warmAfterMs = Number(process.argv[4] || 0);
  const { url } = await startMockOptimizer({ mode, port, warmAfterMs });
  console.log(`mock optimizer (${mode}) on ${url}`);
}
