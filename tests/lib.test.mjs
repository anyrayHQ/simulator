import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, savedPct } from '../lib/usage.mjs';
import { checkFacts, survivingFacts, compareArms } from '../lib/facts.mjs';
import { rateFor, costOf, loadRates } from '../lib/rates.mjs';
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

test('rates: exact and dated model ids resolve; unknown ones report nothing', () => {
  const rates = {
    models: { 'claude-sonnet-5': { input: 2, output: 10 } },
    cache: { writeMultiplier: 1.25, readMultiplier: 0.1 },
  };
  assert.equal(rateFor(rates, 'claude-sonnet-5').input, 2);
  assert.equal(rateFor(rates, 'claude-sonnet-5-20260514').input, 2);
  assert.equal(rateFor(rates, 'claude-sonnet-5[1m]').input, 2);
  assert.equal(rateFor(rates, 'some-other-model'), null);
  assert.equal(costOf(rates, 'some-other-model', { uncachedInput: 1e6, cacheWrite: 0, cacheRead: 0, output: 0 }), null);
});

test('rates: a NEW model never inherits an OLDER model\'s rate by prefix', () => {
  // claude-opus-5-5 shipped at $4/$20 and delimiter-extends claude-opus-5 at
  // $5/$25. A longest-prefix match prices it 25% HIGH while looking priced,
  // which over-states the saving — the exact direction this repo must not err.
  const real = loadRates('rates.json');
  assert.equal(rateFor(real, 'claude-opus-5-5').input, 4);
  assert.equal(rateFor(real, 'claude-opus-5').input, 5);
  // An id we have never heard of prices at nothing, not at its neighbour's rate.
  assert.equal(rateFor(real, 'claude-opus-7-turbo'), null);
  assert.equal(rateFor(real, 'claude-sonnet-5-prod'), null);
});

test('rates: cache reads and writes price at their own rates', () => {
  const rates = { models: { m: { input: 10, output: 50 } }, cache: { writeMultiplier: 1.25, readMultiplier: 0.1 } };
  const cost = costOf(rates, 'm', { uncachedInput: 0, cacheWrite: 1e6, cacheRead: 1e6, output: 0 });
  assert.equal(Number(cost.toFixed(2)), 13.5); // 12.50 write + 1.00 read
});

test('rates: a model that reads cached input below the house tier is honoured', () => {
  // Fable 5.1 reads at 0.025x, not the house 0.1x. Inheriting the house tier
  // would charge cached tokens 4x their real cost, and on warm agent traffic
  // cached reads are most of the input.
  const real = loadRates('rates.json');
  const oneMillionCachedReads = { uncachedInput: 0, cacheWrite: 0, cacheRead: 1e6, output: 0 };
  const usd = (m) => Number(costOf(real, m, oneMillionCachedReads).toFixed(4));
  assert.equal(usd('claude-fable-5-1'), 0.25);
  assert.equal(usd('claude-opus-5-5'), 0.2);
  // Opus 5 declares no override, so it stays on the house 0.1x of $5.
  assert.equal(usd('claude-opus-5'), 0.5);
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
  assert.throws(
    () => resolveConfig({ ANYRAY_GATEWAY_URL: 'https://gw', ANYRAY_API_KEY: 'k', PROOF_MODEL: 'm', PROOF_REPEATS: '0' }),
    /positive integer/
  );
  // PROOF_MODEL has no default on purpose: a shipped one fails on the first
  // call against any deployment that does not route it.
  assert.throws(
    () => resolveConfig({ ANYRAY_GATEWAY_URL: 'https://gw', ANYRAY_API_KEY: 'k' }),
    /PROOF_MODEL/
  );
  const cfg = resolveConfig({ ANYRAY_GATEWAY_URL: 'https://gw/', ANYRAY_API_KEY: 'k', PROOF_MODEL: 'm' });
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

test('usage: a cache WRITE is not added on top of an OpenAI-compatible total', () => {
  // Both objects were captured from a live Bedrock-backed gateway: the same
  // prompt, two consecutive runs, one writing the cache and one reading it.
  // The prompt is 3231 tokens in both cases — the 2857 is a subset, not an
  // addition. Adding it reported a 19% token INCREASE where there was no
  // change at all.
  const wrote = normalizeUsage({
    prompt_tokens: 3231,
    completion_tokens: 72,
    prompt_tokens_details: { cached_tokens: 0 },
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 2857,
  });
  const read = normalizeUsage({
    prompt_tokens: 3231,
    completion_tokens: 65,
    prompt_tokens_details: { cached_tokens: 2857 },
    cache_read_input_tokens: 2857,
    cache_creation_input_tokens: 0,
  });
  assert.equal(wrote.billedInput, 3231);
  assert.equal(read.billedInput, 3231);
  // Identical bytes, identical count — which is the property the whole repeats
  // -disagree guard exists to police.
  assert.equal(wrote.billedInput, read.billedInput);
  assert.equal(wrote.cacheWrite, 2857);
  assert.equal(read.cacheRead, 2857);
});

test('usage: Anthropic-native still SUMS, because input_tokens excludes cache', () => {
  const u = normalizeUsage({
    input_tokens: 374,
    cache_creation_input_tokens: 2857,
    cache_read_input_tokens: 0,
    output_tokens: 40,
  });
  assert.equal(u.billedInput, 3231);
});

test('the first failed call names the real problem, not a guess', async () => {
  // Found by running the README's own quick start from a clean clone: the
  // shipped PROOF_MODEL was not served by the gateway, and the error told the
  // user to go check their API key.
  const { firstCallHint } = await import('../prove.mjs');
  const cfg = { model: 'claude-sonnet-5', gatewayUrl: 'https://gw.example.com' };

  // The same gateway phrases this two different ways depending on the upstream
  // it routes to, so match the message, never the status code.
  for (const wire of [
    'gateway 404: {"error":{"message":"The model `claude-sonnet-5` does not exist."}}',
    'gateway 400: {"error":{"message":"bedrock error: The provided model identifier is invalid."}}',
  ]) {
    const model = firstCallHint(wire, cfg);
    assert.match(model, /PROOF_MODEL is "claude-sonnet-5"/, wire);
    assert.ok(!/API_KEY/.test(model), `must not send them to check the key: ${wire}`);
  }

  const auth = firstCallHint('gateway 401: valid client key required', cfg);
  assert.match(auth, /ANYRAY_API_KEY/);
  assert.match(auth, /anyray-connect doctor/);

  const entitlement = firstCallHint('gateway 402: payment required', cfg);
  assert.match(entitlement, /entitlement lease/);
  assert.ok(/Nothing in \.env fixes that/.test(entitlement), 'must not imply the user can fix it');

  const net = firstCallHint('fetch failed (connect ECONNREFUSED 127.0.0.1:45999)', cfg);
  assert.match(net, /Nothing answered at/);
});

test('shipped examples step aside once the customer has their own', async () => {
  // Running SETUP-PROMPT.md end to end put two captured workloads in a run of
  // six: two thirds of the report was our synthetic fixtures, and 24 of 36
  // billed calls bought the customer nothing.
  const { partitionExamples } = await import('../lib/workloads.mjs');
  const all = [
    { id: 'example-01-log-dump' },
    { id: 'example-02-small-question' },
    { id: '01-incident-triage' },
    { id: '02-pr-review' },
  ];
  const { captured, examples } = partitionExamples(all);
  assert.deepEqual(captured.map((w) => w.id), ['01-incident-triage', '02-pr-review']);
  assert.equal(examples.length, 2);
  // With nothing captured, the examples ARE the run — otherwise a fresh clone
  // would have nothing to demonstrate.
  const fresh = partitionExamples([{ id: 'example-01-log-dump' }]);
  assert.equal(fresh.captured.length, 0);
  assert.equal(fresh.examples.length, 1);
});

test('a truncated answer is never reported as a lost fact', async () => {
  // PROOF_MAX_TOKENS is OUR ceiling. A fact the answer never reached is missing
  // because we cut it off, not because the model dropped it. Verified live: at
  // max_tokens 12 a real answer came back "The failing order is ord_88412,
  // which failed in" and two facts read as missing.
  const { compareArms, wasTruncated } = await import('../lib/facts.mjs');
  assert.ok(wasTruncated({ finishReason: 'length' }));
  assert.ok(wasTruncated({ finishReason: 'max_tokens' }));
  assert.ok(!wasTruncated({ finishReason: 'end_turn' }));

  // THE DANGEROUS CASE: only the optimized arm truncates. Without the guard
  // that is a "LOST FACTS" headline blaming us for our own token ceiling —
  // the most expensive wrong answer this tool can give.
  const asymmetric = compareArms({
    bypassedRuns: [{ answer: 'ECONNRESET on payments-api for ord_88412', finishReason: 'end_turn' }],
    optimizedRuns: [{ answer: 'The failing order is ord_88412, which', finishReason: 'length' }],
    mustInclude: ['ECONNRESET', 'payments-api', 'ord_88412'],
  });
  assert.equal(asymmetric.truncated, true);
  assert.equal(asymmetric.regression, false, 'a truncated arm must not be reported as a regression');
  assert.equal(asymmetric.inconclusive, true);

  // A genuine loss, with both arms finishing cleanly, still reports.
  const real = compareArms({
    bypassedRuns: [{ answer: 'ECONNRESET on payments-api for ord_88412', finishReason: 'end_turn' }],
    optimizedRuns: [{ answer: 'Something failed for ord_88412', finishReason: 'end_turn' }],
    mustInclude: ['ECONNRESET', 'payments-api', 'ord_88412'],
  });
  assert.equal(real.truncated, false);
  assert.equal(real.regression, true);
});
