import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, runTool, grade, REQUIRED } from '../lib/world.mjs';
import { runSession, buildRequest } from '../lib/agent.mjs';
import { compare, verdict } from '../session.mjs';

test('world: the same seed gives byte-identical files, and the answer is findable', () => {
  assert.deepEqual(buildWorld(7), buildWorld(7));
  assert.notDeepEqual(buildWorld(7), buildWorld(8));
  const w = buildWorld(7);
  assert.match(runTool(w, 'grep', { pattern: 'ECONNRESET' }), /logs\/checkout-2\.log:\d+:.*payments-api/);
  assert.doesNotMatch(runTool(w, 'grep', { pattern: 'ECONNRESET', path: 'logs/checkout-0.log' }), /ECONNRESET/);
  assert.match(runTool(w, 'read', { path: 'deploy/CHANGELOG.md' }), /#4411/);
  assert.match(runTool(w, 'read', { path: 'deploy/history/payments-client.yaml@4410' }), /keepalive_idle_ms: 30000/);
  // The red herring is loud: pod 0 carries more ERROR lines than the real failure.
  const count = (p) => runTool(w, 'grep', { pattern: 'ERROR', path: p }).split('\n').length;
  assert.ok(count('logs/checkout-0.log') > count('logs/checkout-2.log'));
});

test('world: tools behave like a coding agent\'s and never throw', () => {
  const w = buildWorld(7);
  assert.equal(runTool(w, 'glob', { pattern: 'deploy/**' }), 'deploy/CHANGELOG.md\ndeploy/history/payments-client.yaml@4410');
  assert.match(runTool(w, 'read', { path: 'README.md', offset: 1, limit: 1 }), /^\s+1\t# checkout$/);
  assert.match(runTool(w, 'read', { path: 'nope' }), /no such file/);
  assert.match(runTool(w, 'grep', { pattern: '(' }), /bad pattern/);
  assert.match(runTool(w, 'nope', {}), /unknown tool/);
});

test('grade: every required fact, case-insensitive', () => {
  assert.equal(grade(REQUIRED.join(' ').toLowerCase()).solved, true);
  const g = grade('payments-api ECONNRESET, redis MOVED');
  assert.equal(g.solved, false);
  assert.deepEqual(g.missing, ['keepalive_idle_ms', '4411']);
  assert.equal(grade(null).solved, false);
});

test('buildRequest places cache breakpoints like a harness: system, last tool, newest message', () => {
  const body = buildRequest({
    system: 's', tools: [{ name: 'a' }, { name: 'b' }], maxTokens: 10, cache: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] }],
  });
  assert.ok(body.system[0].cache_control);
  assert.deepEqual(body.tools.map((t) => Boolean(t.cache_control)), [false, true]);
  assert.deepEqual(body.messages.map((m) => Boolean(m.content.at(-1).cache_control)), [false, false, true]);
  const plain = buildRequest({ system: 's', tools: [{ name: 'a' }], maxTokens: 10, cache: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] });
  assert.equal(JSON.stringify(plain).includes('cache_control'), false);
});

test('runSession: tools run, turns are counted, finish ends it, extra tools route out', async () => {
  const script = [
    { content: [{ type: 'tool_use', id: '1', name: 'grep', input: { pattern: 'ECONNRESET' } }], usage: { input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 10 } },
    { content: [{ type: 'tool_use', id: '2', name: 'anyray_retrieve', input: { handle: 'ctx_x' } }], usage: { input_tokens: 10, cache_read_input_tokens: 150, output_tokens: 10 } },
    { content: [{ type: 'tool_use', id: '3', name: 'finish', input: { answer: 'payments-api ECONNRESET keepalive_idle_ms #4411' } }], usage: { input_tokens: 10, cache_read_input_tokens: 300, output_tokens: 20 } },
  ];
  const sent = [];
  const extra = [];
  const s = await runSession({
    send: async (body) => (sent.push(body), script[sent.length - 1]),
    files: buildWorld(7),
    stamp: 'test',
    extraTools: [{ name: 'anyray_retrieve', description: 'r', input_schema: { type: 'object' } }],
    callExtra: async (name, input) => (extra.push([name, input]), 'the original bytes'),
  });
  assert.equal(s.turns, 3);
  assert.equal(s.stop, 'finish');
  assert.equal(s.solved, true);
  assert.deepEqual(s.toolCounts, { grep: 1, anyray_retrieve: 1, finish: 1 });
  assert.deepEqual(extra, [['anyray_retrieve', { handle: 'ctx_x' }]]);
  assert.deepEqual(s.usage, { uncachedInput: 120, cacheWrite: 50, cacheRead: 450, billedInput: 620, output: 40 });
  // The transcript is resent in full each turn, and the grep result went back.
  assert.equal(sent[2].messages.length, 5);
  assert.match(sent[1].messages[2].content[0].content, /checkout-2\.log/);
  assert.match(sent[0].system[0].text, /^\[session test\]/);
});

test('runSession: a turn without a tool call ends the session with its text as the answer', async () => {
  const s = await runSession({
    send: async () => ({ content: [{ type: 'text', text: 'redis MOVED is the cause' }], stop_reason: 'end_turn', usage: {} }),
    files: buildWorld(7), stamp: 't',
  });
  assert.equal(s.turns, 1);
  assert.equal(s.stop, 'no_tool_call');
  assert.equal(s.solved, false);
});

test('verdict: cheaper must hold in most rounds AND at Q3, and noise is named', () => {
  const rounds = (xs) => xs.map((x) => ({ a: { cost: x }, b: { cost: 1 } }));
  assert.equal(verdict(compare(rounds([0.6, 0.7, 0.8, 0.9]), 'a', 'b')), 'cheaper, beyond noise');
  assert.equal(verdict(compare(rounds([1.5, 1.4, 1.3, 0.9]), 'a', 'b')), 'costs more');
  const noise = compare(rounds([0.5, 1.8, 1.0]), 'a', 'b');
  assert.equal(verdict(compare(rounds([0.7, 1.2, 1.1]), 'a', 'b'), noise), 'inside the noise band');
  assert.equal(verdict(compare(rounds([0.5, 0.6]), 'a', 'b')), 'too few rounds to call');
});

test('an experiment arm tags its requests so an optimizer rule can match them', async () => {
  const { gatewaySender } = await import('../lib/agent.mjs');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (seen.push(init.headers), { ok: true, status: 200, json: async () => ({ content: [], usage: {} }) });
  try {
    const cfg = { gatewayUrl: 'https://gw', apiKey: 'k', model: 'm', timeoutMs: 1000 };
    await gatewaySender(cfg, { optimize: 'on', experiment: 'cache_optimizer' })({ messages: [] });
    await gatewaySender(cfg, { optimize: 'on' })({ messages: [] });
    await gatewaySender(cfg, { optimize: 'off' })({ messages: [] });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(JSON.parse(seen[0]['x-anyray-metadata']), { tool: 'anyray-simulator-session', experiment: 'cache_optimizer' });
  assert.deepEqual(JSON.parse(seen[1]['x-anyray-metadata']), { tool: 'anyray-simulator-session' });
  assert.equal(seen[2]['x-anyray-optimize'], 'off');
});

test('compare pools several baseline arms per round', () => {
  const rounds = [{ t: { cost: 2 }, d: { cost: 1 }, c: { cost: 4 } }];
  assert.equal(compare(rounds, 't', ['d', 'c']).ratios[0], 1);
  assert.equal(compare(rounds, 't', 'd').ratios[0], 2);
});

test('the small world is much smaller but holds the same incident', () => {
  const big = buildWorld(7), small = buildWorld(7, { small: true });
  const size = (w) => Object.values(w).join('').length;
  assert.ok(size(small) * 3 < size(big));
  assert.match(runTool(small, 'grep', { pattern: 'ECONNRESET', path: 'logs/checkout-2.log' }), /payments-api/);
  assert.match(runTool(small, 'grep', { pattern: 'MOVED', path: 'logs/checkout-0.log' }), /redis MOVED/);
  assert.deepEqual(buildWorld(7, { small: true }), small);
});

test('verdict: a cheaper arm that solves fewer tasks is reported as worse, not cheaper', () => {
  const rounds = [0.1, 0.1, 0.1, 0.1].map((x) => ({ a: { cost: x }, b: { cost: 1 } }));
  const c = compare(rounds, 'a', 'b');
  assert.equal(verdict(c, null, { n: 4, solved: 0, baselineSolved: 4 }), 'WORSE: solved 0/4 vs 4/4 baseline');
  assert.equal(verdict(c, null, { n: 4, solved: 4, baselineSolved: 4 }), 'cheaper, beyond noise');
});
