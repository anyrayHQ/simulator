import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, savedPct } from '../lib/usage.mjs';
import { checkFacts, survivingFacts, compareArms } from '../lib/facts.mjs';
import { rateFor, costOf } from '../lib/rates.mjs';
import { validateWorkload } from '../lib/workloads.mjs';
import { parseEnvFile, resolveConfig } from '../lib/env.mjs';
import { parseCompletion, parseMessages, authHeaders } from '../lib/provider.mjs';
import { extractJsonObject } from '../judge.mjs';

test('usage: both dialects normalize to the same shape', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 20 }), {
    uncachedInput: 100, cacheWrite: 0, cacheRead: 0, billedInput: 100, output: 20,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 100, output_tokens: 20 }), {
    uncachedInput: 100, cacheWrite: 0, cacheRead: 0, billedInput: 100, output: 20,
  });
});

test('usage: a cache hit cannot masquerade as a saving', () => {
  // Anthropic: input_tokens EXCLUDES the cached read. Reading prompt_tokens
  // alone here would book a 99% "saving" that is really a warm cache.
  const anthropic = normalizeUsage({ input_tokens: 12, cache_read_input_tokens: 9000, output_tokens: 5 });
  assert.equal(anthropic.billedInput, 9012);
  // OpenAI-compatible: prompt_tokens INCLUDES the cached read, so the same
  // bytes must not be counted twice.
  const openai = normalizeUsage({ prompt_tokens: 9012, prompt_tokens_details: { cached_tokens: 9000 }, completion_tokens: 5 });
  assert.equal(openai.billedInput, 9012);
  assert.equal(openai.uncachedInput, 12);
});

test('usage: cache writes count toward input', () => {
  const u = normalizeUsage({ input_tokens: 100, cache_creation_input_tokens: 400 });
  assert.equal(u.billedInput, 500);
});

test('savedPct handles a zero baseline without dividing by it', () => {
  assert.equal(savedPct(0, 0), 0);
  assert.equal(savedPct(100, 25), 75);
  assert.equal(savedPct(310, 310), 0);
});

test('facts: matching ignores case and whitespace runs, not substance', () => {
  assert.equal(checkFacts('Failed with econnreset on the socket.', ['ECONNRESET']).kept, 1);
  assert.equal(checkFacts('the payments   api fell over', ['payments-api']).kept, 0);
  assert.equal(checkFacts('order\nord_88412 failed', ['ord_88412']).kept, 1);
});

test('facts: survival requires every run, not a lucky one', () => {
  const runs = [{ answer: 'ECONNRESET on payments-api' }, { answer: 'something went wrong' }];
  assert.deepEqual([...survivingFacts(runs, ['ECONNRESET'])], []);
  const consistent = [{ answer: 'ECONNRESET here' }, { answer: 'also ECONNRESET' }];
  assert.deepEqual([...survivingFacts(consistent, ['ECONNRESET'])], ['ECONNRESET']);
});

test('facts: the asymmetry — a fact both arms miss is not our regression', () => {
  const r = compareArms({
    bypassedRuns: [{ answer: 'nothing useful' }],
    optimizedRuns: [{ answer: 'nothing useful' }],
    mustInclude: ['ord_88412'],
  });
  assert.equal(r.regression, false);
  assert.equal(r.inconclusive, true);
  assert.deepEqual(r.missingBoth, ['ord_88412']);
});

test('facts: a fact lost only with Anyray on IS a regression', () => {
  const r = compareArms({
    bypassedRuns: [{ answer: 'ECONNRESET on payments-api for ord_88412' }],
    optimizedRuns: [{ answer: 'payments-api had trouble with ord_88412' }],
    mustInclude: ['ECONNRESET', 'payments-api', 'ord_88412'],
  });
  assert.equal(r.regression, true);
  assert.deepEqual(r.lost, ['ECONNRESET']);
  assert.equal(r.bypassedKept, 3);
  assert.equal(r.optimizedKept, 2);
});

test('rates: exact, dated and prefixed model ids resolve; unknown ones do not', () => {
  const rates = {
    models: { 'claude-sonnet-5': { input: 2, output: 10 } },
    cache: { writeMultiplier: 1.25, readMultiplier: 0.1 },
  };
  assert.equal(rateFor(rates, 'claude-sonnet-5').input, 2);
  assert.equal(rateFor(rates, 'claude-sonnet-5-20260514').input, 2);
  assert.equal(rateFor(rates, 'claude-sonnet-5-prod').input, 2);
  assert.equal(rateFor(rates, 'some-other-model'), null);
  assert.equal(costOf(rates, 'some-other-model', { uncachedInput: 1e6, cacheWrite: 0, cacheRead: 0, output: 0 }), null);
});

test('rates: cache reads and writes price at their own rates', () => {
  const rates = { models: { m: { input: 10, output: 50 } }, cache: { writeMultiplier: 1.25, readMultiplier: 0.1 } };
  const cost = costOf(rates, 'm', { uncachedInput: 0, cacheWrite: 1e6, cacheRead: 1e6, output: 0 });
  assert.equal(Number(cost.toFixed(2)), 13.5); // 12.50 write + 1.00 read
});

test('workloads: a workload without required facts is rejected', () => {
  assert.ok(validateWorkload({ id: 'x', body: { messages: [{ role: 'user', content: 'hi' }] } }, 'x.json').length);
  assert.equal(
    validateWorkload({ id: 'x', mustInclude: ['a'], body: { messages: [{ role: 'user', content: 'hi' }] } }, 'x.json').length,
    0
  );
});

test('workloads: a per-workload model would break the comparison, so it is rejected', () => {
  const problems = validateWorkload(
    { id: 'x', mustInclude: ['a'], body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] } },
    'x.json'
  );
  assert.ok(problems.some((p) => p.includes('body.model')));
});

test('env: .env parses, and the real environment wins', () => {
  const parsed = parseEnvFile('# comment\nPROVIDER_API_KEY="sk-abc"\nPROOF_REPEATS=5\n\n');
  assert.equal(parsed.PROVIDER_API_KEY, 'sk-abc');
  assert.equal(parsed.PROOF_REPEATS, '5');
});

test('env: a missing key fails loudly rather than calling an open endpoint', () => {
  assert.throws(() => resolveConfig({ PROVIDER_BASE_URL: 'https://api.x.com' }), /PROVIDER_API_KEY/);
  assert.throws(
    () => resolveConfig({ PROVIDER_BASE_URL: 'https://api.x.com', PROVIDER_API_KEY: 'k', PROOF_REPEATS: '0' }),
    /positive integer/
  );
  const cfg = resolveConfig({ PROVIDER_BASE_URL: 'https://api.x.com/', PROVIDER_API_KEY: 'k' });
  assert.equal(cfg.providerUrl, 'https://api.x.com');
  assert.equal(cfg.repeats, 3);
  // The optimizer defaults to localhost — never to anything of ours.
  assert.ok(cfg.optimizerUrl.startsWith('http://localhost'));
});

test('env: the provider dialect is detected, and overridable', () => {
  const anthropic = resolveConfig({ PROVIDER_BASE_URL: 'https://api.anthropic.com', PROVIDER_API_KEY: 'k' });
  assert.equal(anthropic.dialect, 'anthropic');
  assert.equal(anthropic.endpoint, '/v1/messages');
  const local = resolveConfig({ PROVIDER_BASE_URL: 'http://localhost:11434', PROVIDER_API_KEY: 'k' });
  assert.equal(local.dialect, 'openai');
  assert.equal(local.endpoint, '/v1/chat/completions');
  const forced = resolveConfig({ PROVIDER_BASE_URL: 'https://proxy.internal', PROVIDER_API_KEY: 'k', PROVIDER_DIALECT: 'anthropic' });
  assert.equal(forced.dialect, 'anthropic');
});

test('provider: auth header matches the dialect', () => {
  // Sending Bearer to Anthropic is a 401 that reads like a bad key.
  assert.deepEqual(authHeaders({ dialect: 'anthropic', apiKey: 'sk-ant-x' }), {
    'x-api-key': 'sk-ant-x',
    'anthropic-version': '2023-06-01',
  });
  assert.deepEqual(authHeaders({ dialect: 'openai', apiKey: 'sk-x' }), { authorization: 'Bearer sk-x' });
});

test('provider: both response shapes parse', () => {
  assert.equal(parseCompletion({ choices: [{ message: { content: 'hi' } }] }).answer, 'hi');
  assert.equal(parseMessages({ content: [{ type: 'text', text: 'hi' }, { type: 'thinking', text: 'no' }] }).answer, 'hi');
});

test('judge: JSON is extracted from a chatty reply', () => {
  assert.equal(
    extractJsonObject('Sure — here you go: {"winner":"A","why":"it names the {brace} error"} done'),
    '{"winner":"A","why":"it names the {brace} error"}'
  );
});

test('optimizer: readiness waits for the embedder, and gives up honestly', async () => {
  const { Optimizer } = await import('../lib/optimizer.mjs');

  // A cold embedder is NOT ready, even when /health answers 200.
  let state = { ready: true, embedder: 'loading' };
  const opt = new Optimizer({
    url: 'http://stub',
    fetchImpl: async () => ({ ok: true, json: async () => state }),
  });
  await assert.rejects(
    opt.waitUntilReady({ timeoutMs: 120, pollMs: 20 }),
    /did not become ready/
  );

  // Once warm, it returns immediately.
  state = { ready: true, embedder: 'warm' };
  assert.equal((await opt.waitUntilReady({ timeoutMs: 500, pollMs: 20 })).embedder, 'warm');

  // A build with no semantic strategies reports no embedder at all — that is a
  // configuration, not a cold start, so it must not hang forever.
  state = { ready: true };
  assert.ok(await opt.waitUntilReady({ timeoutMs: 500, pollMs: 20 }));
});

test('optimizer: a transform that did not happen is an error, not a zero saving', async () => {
  const { Optimizer } = await import('../lib/optimizer.mjs');
  const opt = new Optimizer({
    url: 'http://stub',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ decisions: [] }) }),
  });
  await assert.rejects(opt.optimize({ messages: [] }), /no `request`/);
});
