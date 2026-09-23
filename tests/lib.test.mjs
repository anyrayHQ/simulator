import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, savedPct } from '../lib/usage.mjs';
import { checkFacts, survivingFacts, compareArms } from '../lib/facts.mjs';
import { rateFor, costOf } from '../lib/rates.mjs';
import { validateWorkload } from '../lib/workloads.mjs';
import { parseEnvFile, resolveConfig } from '../lib/env.mjs';
import { parseCompletion, parseMessages } from '../lib/gateway.mjs';
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
  const parsed = parseEnvFile('# comment\nANYRAY_API_KEY="ark_abc"\nPROOF_REPEATS=5\n\n');
  assert.equal(parsed.ANYRAY_API_KEY, 'ark_abc');
  assert.equal(parsed.PROOF_REPEATS, '5');
});

test('env: a missing key fails loudly rather than calling an open endpoint', () => {
  assert.throws(() => resolveConfig({ ANYRAY_GATEWAY_URL: 'https://gw' }), /ANYRAY_API_KEY/);
  assert.throws(() => resolveConfig({ ANYRAY_GATEWAY_URL: 'https://gw', ANYRAY_API_KEY: 'k', PROOF_REPEATS: '0' }), /positive integer/);
  const cfg = resolveConfig({ ANYRAY_GATEWAY_URL: 'https://gw/', ANYRAY_API_KEY: 'k' });
  assert.equal(cfg.gatewayUrl, 'https://gw');
  assert.equal(cfg.repeats, 3);
});

test('gateway: both response shapes parse', () => {
  assert.equal(parseCompletion({ choices: [{ message: { content: 'hi' } }] }).answer, 'hi');
  assert.equal(parseMessages({ content: [{ type: 'text', text: 'hi' }, { type: 'thinking', text: 'no' }] }).answer, 'hi');
});

test('judge: JSON is extracted from a chatty reply', () => {
  assert.equal(
    extractJsonObject('Sure — here you go: {"winner":"A","why":"it names the {brace} error"} done'),
    '{"winner":"A","why":"it names the {brace} error"}'
  );
});
