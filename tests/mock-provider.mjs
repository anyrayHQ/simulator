// A stand-in for the customer's provider. Answers from whatever context it is
// given, and reports `usage` the way a real provider does — so prove.mjs is
// exercised on the same field it will read in production.
//
// It answers with the facts it can still SEE in the prompt. That is the whole
// point: if the optimizer trims a fact out of the context, this provider stops
// being able to say it, exactly as a real model would.
//
//   node tests/mock-provider.mjs 8901

import { createServer } from 'node:http';

// What a model can say depends on what it can still SEE. Each entry maps a piece
// of EVIDENCE that must survive in the prompt to the fact(s) an answer can then
// carry. That is the behaviour we need from a stand-in: trim the evidence out of
// the context and the answer loses the fact, exactly as a real model would —
// including facts the model states in its own words rather than quoting
// ("gateway" never appears in the 504 prompt, but a model that can see the
// question will say it).
const ANSWER_KEY = [
  { evidence: 'ECONNRESET', facts: ['ECONNRESET'] },
  { evidence: 'payments-api', facts: ['payments-api'] },
  { evidence: 'ord_88412', facts: ['ord_88412'] },
  { evidence: 'HTTP status 504', facts: ['504', 'gateway'] },
  { evidence: 'search_logs', facts: ['search_logs'] },
];

function promptText(body) {
  const msgs = (body.messages ?? []).map((m) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  );
  const system = typeof body.system === 'string' ? body.system : '';
  const tools = body.tools ? JSON.stringify(body.tools) : '';
  return [system, ...msgs, tools].join('\n');
}

export function startMockProvider({ port = 0, flaky = false } = {}) {
  let seq = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const native = req.url.includes('/messages');
      const text = promptText(body);

      res.setHeader('content-type', 'application/json');

      // A grading call from judge.mjs. Always picks ANSWER A — so if judge.mjs
      // ever stopped shuffling, every workload would resolve to the same arm
      // and the test would catch it.
      if (text.includes('ANSWER A:')) {
        res.end(
          JSON.stringify({
            choices: [
              { message: { role: 'assistant', content: '{"winner":"A","why":"it names the failing service"}' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 12 },
          })
        );
        return;
      }

      // Say only what the surviving context still supports.
      const hay = text.toLowerCase();
      const visible = [
        ...new Set(
          ANSWER_KEY.filter((e) => hay.includes(e.evidence.toLowerCase())).flatMap((e) => e.facts)
        ),
      ];
      const answer = visible.length
        ? `The relevant details are: ${visible.join(', ')}.`
        : 'I could not determine that from the context provided.';

      let inputTokens = Math.round(text.length / 4);
      // Identical bytes must give an identical count. This breaks that on
      // purpose so the repeats-disagree guard has something to catch.
      if (flaky) inputTokens += seq++ % 2 === 0 ? 0 : 37;

      const payload = native
        ? {
            content: [{ type: 'text', text: answer }],
            stop_reason: 'end_turn',
            usage: { input_tokens: inputTokens, output_tokens: 24 },
          }
        : {
            choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
            usage: { prompt_tokens: inputTokens, completion_tokens: 24, total_tokens: inputTokens + 24 },
          };
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8901);
  const flaky = process.argv.includes('--flaky');
  const { url } = await startMockProvider({ port, flaky });
  console.log(`mock provider on ${url}`);
}
