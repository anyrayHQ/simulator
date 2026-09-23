// The diagram, asserted.
//
//   one workload  ──┬── 3x  Anyray OFF  (x-anyray-optimize: off) ──┐
//                   └── 3x  Anyray ON   (the normal request)    ───┴─→ compare
//   same model · same key · same path · one header different
//
// Everything else in this repo is downstream of that claim being true. These
// tests check the claim itself: that the two arms differ in exactly one header,
// that the gateway treats them differently, and that a run cannot be flattered
// by a cache a PREVIOUS run left warm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callGateway } from '../lib/gateway.mjs';
import { stampRunId, newRunId } from '../lib/workloads.mjs';

const cfg = {
  gatewayUrl: 'https://gw.test',
  apiKey: 'ark_test',
  model: 'claude-sonnet-4-5',
  endpoint: '/v1/chat/completions',
  maxTokens: 64,
  timeoutMs: 5000,
};
const body = { temperature: 0, messages: [{ role: 'user', content: 'hello' }] };

/** Capture what would go on the wire. */
function recorder(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: status < 400,
      status,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      text: async () => '',
    };
  };
  return { calls, fetchImpl };
}

test('the two arms differ in EXACTLY one header, and nothing else', async () => {
  const { calls, fetchImpl } = recorder();
  await callGateway(cfg, body, { optimize: 'off', fetchImpl });
  await callGateway(cfg, body, { optimize: 'on', fetchImpl });
  const [off, on] = calls;

  // Same path, same model, same body, same key.
  assert.equal(off.url, on.url);
  assert.deepEqual(off.body, on.body);
  assert.equal(off.headers.authorization, on.headers.authorization);
  assert.equal(off.body.model, cfg.model);

  // The only difference in the header set.
  const diff = [...new Set([...Object.keys(off.headers), ...Object.keys(on.headers)])]
    .filter((k) => off.headers[k] !== on.headers[k]);
  assert.deepEqual(diff, ['x-anyray-optimize'], `headers differed in more than the bypass: ${diff}`);
  assert.equal(off.headers['x-anyray-optimize'], 'off');
  assert.equal(on.headers['x-anyray-optimize'], undefined, 'the ON arm must be the ORDINARY request, carrying no Anyray header at all');
});

test('both arms ask the gateway for its decisions, so neither is a different code path', async () => {
  const { calls, fetchImpl } = recorder();
  await callGateway(cfg, body, { optimize: 'off', fetchImpl });
  await callGateway(cfg, body, { optimize: 'on', fetchImpl });
  for (const c of calls) assert.equal(c.headers['x-anyray-test'], '1');
});

test('cache isolation stamps BOTH arms identically, so it cannot tilt the comparison', () => {
  const runId = newRunId();
  const wl = { id: 'w', mustInclude: ['x'], body };
  const stamped = stampRunId(wl, runId);
  // The id lands at the very START — a prefix cache is defeated by a changed
  // prefix and by nothing else.
  assert.ok(stamped.body.messages[0].content.startsWith(`[anyray proof-run ${runId}`));
  assert.ok(stamped.body.messages[0].content.includes('hello'));
  // The workload object is not mutated: both arms are built from the same
  // stamped body, so whatever it costs, it costs both equally.
  assert.equal(wl.body.messages[0].content, 'hello');
});

test('a fresh run gets a fresh id, so no two runs share a cache prefix', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newRunId()));
  assert.equal(ids.size, 50);
  const wl = { id: 'w', body };
  const a = stampRunId(wl, newRunId()).body.messages[0].content;
  const b = stampRunId(wl, newRunId()).body.messages[0].content;
  assert.notEqual(a, b, 'two runs must not produce a byte-identical prefix');
});

test('cache isolation handles block content, not just strings', () => {
  const wl = { id: 'w', body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } };
  const out = stampRunId(wl, 'abc12345').body.messages[0].content;
  assert.equal(out[0].type, 'text');
  assert.ok(out[0].text.includes('abc12345'));
  assert.equal(out[1].text, 'hi');
});

test('the stamp lands where the CACHE looks, not merely where it is convenient', () => {
  // Providers render tools -> system -> messages, and a breakpoint caches
  // everything up to itself. A live gateway put its breakpoint on TOOLS, so a
  // stamp in the first message left the cached bytes byte-identical across runs
  // and two back-to-back runs both read 2857 tokens from cache on call one.
  const withTools = stampRunId(
    { id: 'w', body: { tools: [{ type: 'function', function: { name: 'a' } }], messages: [{ role: 'user', content: 'hi' }] } },
    'abc12345'
  );
  assert.equal(withTools.body.tools.length, 2);
  assert.ok(withTools.body.tools.at(-1).function.name.includes('abc12345'));
  // The customer's own tools are untouched — we add, never rewrite.
  assert.equal(withTools.body.tools[0].function.name, 'a');
  assert.equal(withTools.body.messages[0].content, 'hi');

  const withSystem = stampRunId({ id: 'w', body: { system: 'You are X.', messages: [{ role: 'user', content: 'hi' }] } }, 'abc12345');
  assert.ok(withSystem.body.system.startsWith('[anyray proof-run abc12345'));

  const bare = stampRunId({ id: 'w', body: { messages: [{ role: 'user', content: 'hi' }] } }, 'abc12345');
  assert.ok(bare.body.messages[0].content.startsWith('[anyray proof-run abc12345'));
});
