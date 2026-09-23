// A stand-in gateway for end-to-end testing, in two states.
//
//   healthy:    with the header off it echoes the whole prompt back; with the
//               header absent (optimized) it trims the prompt but keeps every
//               answer-bearing fact.
//   dropping:   the trim also loses a fact. This is the state that proves the
//               quality check is load-bearing rather than decorative.
//
// It reports `usage` the way a real provider does, so prove.mjs is exercised on
// the same field it will read in production.

import { createServer } from 'node:http';

const FACTS = {
  'example-01-log-dump': ['ECONNRESET', 'payments-api', 'ord_88412'],
  'example-02-small-question': ['504', 'gateway'],
  'example-03-tool-bloat': ['search_logs', 'payments-api'],
};

/** Which workload this body came from, by looking for its distinctive marker. */
function identify(body) {
  const text = JSON.stringify(body);
  if (text.includes('ord_88412')) return 'example-01-log-dump';
  if (text.includes('HTTP status 504')) return 'example-02-small-question';
  if (text.includes('tool from the catalogue')) return 'example-03-tool-bloat';
  return 'unknown';
}

function promptChars(body) {
  const msgs = (body.messages ?? []).map((m) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  );
  const system = typeof body.system === 'string' ? body.system : '';
  const tools = body.tools ? JSON.stringify(body.tools) : '';
  return [system, ...msgs, tools].join('\n').length;
}

export function startMockGateway({ mode = 'healthy', port = 0 } = {}) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const id = identify(body);
      const bypassed = req.headers['x-anyray-optimize'] === 'off';
      const native = req.url.includes('/messages');
      const facts = FACTS[id] ?? [];

      // The small-question workload has nothing to trim, so both arms cost the
      // same — exactly the honest 0% the example exists to show.
      const chars = promptChars(body);
      const trimmable = id !== 'example-02-small-question';
      const inputTokens =
        bypassed || !trimmable ? Math.round(chars / 4) : Math.round((chars / 4) * 0.28);

      // A dropping gateway loses the first fact, but only on the optimized arm.
      const kept =
        !bypassed && mode === 'dropping' && trimmable ? facts.slice(1) : facts;
      const answer = kept.length
        ? `The relevant details are: ${kept.join(', ')}.`
        : 'I could not determine that from the context provided.';

      const payload = native
        ? {
            content: [{ type: 'text', text: answer }],
            stop_reason: 'end_turn',
            usage: { input_tokens: inputTokens, output_tokens: 24 },
          }
        : {
            choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: 24,
              total_tokens: inputTokens + 24,
            },
          };

      res.setHeader('content-type', 'application/json');
      if (!bypassed && trimmable) {
        res.setHeader(
          'x-anyray-optimization',
          JSON.stringify([{ strategy: 'context_compression' }, { strategy: 'relevance_filter' }])
        );
      }
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

// Run directly for a manual end-to-end check:
//   node tests/mock-gateway.mjs dropping 8799
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] || 'healthy';
  const port = Number(process.argv[3] || 8799);
  const { url } = await startMockGateway({ mode, port });
  console.log(`mock gateway (${mode}) on ${url}`);
}
