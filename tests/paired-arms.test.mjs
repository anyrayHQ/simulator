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
  assert.ok(stamped.body.messages[0].content.startsWith(`[anyray-simulator ${runId}`));
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
  assert.ok(withSystem.body.system.startsWith('[anyray-simulator abc12345'));

  const bare = stampRunId({ id: 'w', body: { messages: [{ role: 'user', content: 'hi' }] } }, 'abc12345');
  assert.ok(bare.body.messages[0].content.startsWith('[anyray-simulator abc12345'));
});

test('report.html loads nothing from a third party', async () => {
  // The report holds the customer's prompts and both answers. An earlier version
  // pulled webfonts from Google, so opening it made a request to a third party
  // from inside their network — on a page the README says never leaves their
  // machine. A link they may click is fine; a resource the page FETCHES is not.
  const { renderReport } = await import('../report.mjs');
  const html = renderReport({
    ranAt: new Date().toISOString(),
    gatewayUrl: 'https://gw.example.com',
    model: 'claude-sonnet-4-5',
    endpoint: '/v1/chat/completions',
    repeats: 3,
    summary: {
      model: 'claude-sonnet-4-5', repeats: 3, rows: [],
      cost: { before: 0, after: 0, savedPct: 0, priced: false, cacheState: 'none', usdSavedPct: 0, notMeasured: 0 },
      quality: { checked: 0, clean: 0, regressions: [], inconclusive: [] },
      errors: [],
    },
  });
  // Anything that causes a fetch on load: src=, @import, url(), link rel.
  const fetched = [
    ...html.matchAll(/(?:src|href)\s*=\s*"(https?:\/\/[^"]+)"/gi),
    ...html.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/[^"')]+)/gi),
    ...html.matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)/gi),
  ].map((m) => ({ url: m[1], tag: m[0] }));

  // An <a href> is a link the reader may choose to follow, not a load.
  const resourceLoads = fetched.filter((f) => /^src/i.test(f.tag) || /@import/i.test(f.tag) || /^url\(/i.test(f.tag));
  assert.deepEqual(resourceLoads, [], `report fetches third-party resources: ${JSON.stringify(resourceLoads)}`);
  assert.ok(!/<link[^>]+href\s*=\s*"https?:/i.test(html), 'report <link>s to an external stylesheet');
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/i.test(html), 'report still references Google Fonts');
});

test('--redact removes every verbatim string from the customer, and says what it kept', async () => {
  // The reason anyone runs this is that somebody ELSE asked whether the savings
  // are real, so the report has to travel. The full one carries production
  // prompts and both answers; this asserts the shareable one carries neither,
  // on the hardest case — a regression, where fact names are what the report is
  // otherwise shouting about.
  const { renderReport } = await import('../report.mjs');
  const SECRET = ['ECONNRESET', 'payments-api', 'ord_88412', 'ACME-INTERNAL-HOSTNAME'];
  const data = {
    ranAt: '2026-09-23T00:00:00.000Z',
    gatewayUrl: 'https://gw.example.com',
    model: 'claude-sonnet-4-5',
    endpoint: '/v1/chat/completions',
    repeats: 3,
    summary: {
      model: 'claude-sonnet-4-5',
      repeats: 3,
      rows: [
        {
          id: 'example-01-log-dump',
          title: 'ACME-INTERNAL-HOSTNAME incident',
          bypassed: { billedInput: 9036, cacheRead: 0, cacheWrite: 0, uncachedInput: 9036, output: 50 },
          optimized: { billedInput: 2892, cacheRead: 0, cacheWrite: 0, uncachedInput: 2892, output: 50 },
          savedPct: 68,
          facts: {
            total: 3, bypassedKept: 3, optimizedKept: 1,
            lost: ['ECONNRESET', 'payments-api'], missingBoth: [], recovered: [],
            regression: true, inconclusive: false,
          },
          strategies: ['context_compression'],
          optimizeStatus: 'applied', optimizeNotes: [], suppressed: [],
          inconsistent: { bypassed: null, optimized: null },
          errors: [],
          answers: {
            bypassed: 'The failure was ECONNRESET on payments-api for ord_88412.',
            optimized: 'Something went wrong with ord_88412.',
          },
        },
      ],
      cost: { before: 9036, after: 2892, savedPct: 68, priced: false, cacheState: 'none', usdSavedPct: 0, notMeasured: 0 },
      quality: { checked: 1, clean: 0, regressions: [], inconclusive: [] },
      errors: [],
    },
  };
  data.summary.quality.regressions = [data.summary.rows[0]];

  const shareable = renderReport(data, { redact: true });
  for (const secret of SECRET) {
    assert.ok(!shareable.includes(secret), `shareable report leaked "${secret}"`);
  }
  // No answers section at all.
  assert.ok(!shareable.includes('Both answers'), 'shareable report still renders answers');
  assert.ok(!shareable.includes('Something went wrong'), 'shareable report leaked an answer');

  // But the numbers a reader actually needs survive.
  assert.ok(shareable.includes('9,036') && shareable.includes('2,892'), 'lost the token counts');
  assert.ok(/68%/.test(shareable), 'lost the saving');
  assert.ok(/lost a fact/i.test(shareable), 'a regression must still read as a regression');
  assert.ok(/2 of 3 required fact/.test(shareable), 'lost the fact count');
  assert.ok(shareable.includes('context_compression'), 'lost which strategies fired');

  // And it must disclose what it still carries rather than imply it is clean.
  assert.ok(/check before you send it/i.test(shareable), 'no disclosure of what remains');

  // The full report is unchanged: it is the one that keeps everything.
  const full = renderReport(data);
  for (const secret of ['ECONNRESET', 'payments-api']) assert.ok(full.includes(secret));
  assert.ok(full.includes('Both answers'));
});

test('the report is model-agnostic, and never prints money it does not have', async () => {
  const { renderReport } = await import('../report.mjs');
  const row = {
    id: 'w1', title: null,
    bypassed: { billedInput: 9036, cacheRead: 0, cacheWrite: 0, uncachedInput: 9036, output: 50 },
    optimized: { billedInput: 2892, cacheRead: 0, cacheWrite: 0, uncachedInput: 2892, output: 50 },
    savedPct: 68,
    facts: { total: 2, bypassedKept: 2, optimizedKept: 2, lost: [], missingBoth: [], recovered: [], regression: false, inconclusive: false, truncated: false },
    strategies: ['context_compression'], optimizeStatus: 'applied', optimizeNotes: [], suppressed: [],
    inconsistent: { bypassed: null, optimized: null }, errors: [],
    answers: { bypassed: 'a', optimized: 'b' },
  };
  const make = (model, cost) => ({
    ranAt: '2026-09-23T00:00:00.000Z', gatewayUrl: 'https://gw.example.com', model,
    endpoint: '/v1/chat/completions', repeats: 3,
    summary: {
      model, repeats: 3, rows: [row],
      cost: { before: 9036, after: 2892, savedPct: 68, cacheState: 'none', usdSavedPct: 68, notMeasured: 0, ...cost },
      quality: { checked: 1, clean: 1, regressions: [], inconclusive: [] },
      errors: [],
    },
  });

  // Any model id renders; nothing in the page is Claude-shaped.
  for (const model of ['gpt-5', 'gemini-2.5-pro', 'o4-mini', 'claude-sonnet-4-5', 'acme/internal-7b']) {
    const html = renderReport(make(model, { priced: true, beforeUSD: 0.07, afterUSD: 0.02 }));
    assert.ok(html.includes(model.replace('/', '/')), `${model} missing from the report`);
    assert.ok(html.includes('68%'));
  }

  // An unpriced model says so instead of inventing a figure.
  const unpriced = renderReport(make('acme-internal-7b', { priced: false, beforeUSD: null, afterUSD: null }));
  assert.match(unpriced, /No published rate for/);
  assert.ok(!/\$\d/.test(unpriced.split('1 — Cost')[1].split('</section>')[0]), 'printed a dollar figure with no rate');

  // A results.json that claims priced:true but carries no figures — hand-edited,
  // or written by an older build — must still not print money.
  const doctored = renderReport(make('acme-internal-7b', { priced: true, beforeUSD: null, afterUSD: null }));
  assert.match(doctored, /No published rate for/);
  assert.ok(!doctored.includes('$null') && !doctored.includes('$NaN'));
});

test('a body that already caps its answer is not given a second, wrong cap', async () => {
  // OpenAI's reasoning models reject `max_tokens` and require
  // `max_completion_tokens`. A customer's body is already correct for their
  // own provider; adding our spelling on top would 400 it.
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }), text: async () => '' };
  };
  const cfg = { gatewayUrl: 'https://gw', apiKey: 'k', model: 'o4-mini', endpoint: '/v1/chat/completions', maxTokens: 1024, timeoutMs: 5000 };

  await callGateway(cfg, { messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 256 }, { optimize: 'on', fetchImpl });
  assert.equal(calls[0].max_completion_tokens, 256);
  assert.equal(calls[0].max_tokens, undefined, 'added max_tokens next to max_completion_tokens');

  await callGateway(cfg, { messages: [{ role: 'user', content: 'hi' }], max_output_tokens: 99 }, { optimize: 'on', fetchImpl });
  assert.equal(calls[1].max_output_tokens, 99);
  assert.equal(calls[1].max_tokens, undefined);

  // With no ceiling of their own, ours applies — a runaway generation should
  // not be able to dominate their bill.
  await callGateway(cfg, { messages: [{ role: 'user', content: 'hi' }] }, { optimize: 'on', fetchImpl });
  assert.equal(calls[2].max_tokens, 1024);
});

test('the direct arm never borrows an ambient, gateway-routed key', async () => {
  // On an enrolled machine ANTHROPIC_API_KEY / OPENAI_API_KEY are part of the
  // Anyray routing. Borrowing one is how a "direct" control ends up going
  // through the gateway and proves nothing while looking rigorous — the lab
  // documents hitting exactly this.
  const { resolveDirect } = await import('../lib/env.mjs');
  assert.equal(resolveDirect({}, 'm'), null, 'direct arm must be opt-in');
  assert.equal(
    resolveDirect({ ANTHROPIC_API_KEY: 'sk-ant-ambient' }, 'm'),
    null,
    'an ambient provider key must not silently enable the direct arm'
  );
  assert.throws(
    () => resolveDirect({ DIRECT_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'sk-ant-x' }, 'm'),
    /DIRECT_API_KEY/,
    'must demand its own key rather than borrowing the ambient one'
  );
  // And it must refuse to call an Anyray host "direct".
  assert.throws(
    () => resolveDirect({ DIRECT_BASE_URL: 'https://gateway.anyray.ai', DIRECT_API_KEY: 'k' }, 'm'),
    /must bypass Anyray entirely/
  );
  const ok = resolveDirect({ DIRECT_BASE_URL: 'https://api.anthropic.com/', DIRECT_API_KEY: 'sk-ant-x' }, 'claude-sonnet-4-5');
  assert.equal(ok.dialect, 'anthropic');
  assert.equal(ok.endpoint, '/v1/messages');
  assert.equal(ok.model, 'claude-sonnet-4-5');
});

test('a direct call carries no Anyray header and provider-shaped auth', async () => {
  const { callDirect } = await import('../lib/gateway.mjs');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 5 } }), text: async () => '' };
  };
  await callDirect(
    { providerUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-x', dialect: 'anthropic', endpoint: '/v1/messages', model: 'm' },
    { messages: [{ role: 'user', content: 'hi' }] },
    { maxTokens: 64, timeoutMs: 5000, fetchImpl }
  );
  const h = calls[0].headers;
  assert.equal(h['x-api-key'], 'sk-ant-x');
  assert.equal(h['anthropic-version'], '2023-06-01');
  // Nothing of ours may ride along, or it is not a direct call.
  for (const k of Object.keys(h)) {
    assert.ok(!/^x-anyray/i.test(k), `direct call carried ${k}`);
  }
  assert.ok(calls[0].url.startsWith('https://api.anthropic.com'));
});

test('the report table has as many header cells as body cells', async () => {
  // A header built separately from the rows drifts silently: adding the Direct
  // column to the body without the header shifted every value one place left,
  // so "Anyray off" displayed the direct count and "Saved" displayed facts.
  // The page still rendered. Nothing failed.
  const { renderReport } = await import('../report.mjs');
  const row = (withDirect) => ({
    id: 'w1', title: null,
    direct: withDirect ? { billedInput: 100, cacheRead: 0, cacheWrite: 0, uncachedInput: 100, output: 5 } : null,
    bypassed: { billedInput: 100, cacheRead: 0, cacheWrite: 0, uncachedInput: 100, output: 5 },
    optimized: { billedInput: 40, cacheRead: 0, cacheWrite: 0, uncachedInput: 40, output: 5 },
    savedPct: 60,
    facts: { total: 1, bypassedKept: 1, optimizedKept: 1, lost: [], missingBoth: [], recovered: [], regression: false, inconclusive: false, truncated: false },
    strategies: [], optimizeStatus: 'applied', optimizeNotes: [], suppressed: [],
    inconsistent: { bypassed: null, optimized: null }, errors: [],
    answers: { bypassed: 'a', optimized: 'b' },
  });
  const make = (proxyCheck) => ({
    ranAt: '2026-09-24T00:00:00.000Z', gatewayUrl: 'https://gw', model: 'claude-sonnet-4-5',
    endpoint: '/v1/chat/completions', repeats: 1,
    summary: {
      model: 'claude-sonnet-4-5', repeats: 1, rows: [row(Boolean(proxyCheck))], proxyCheck,
      cost: { before: 100, after: 40, savedPct: 60, priced: true, beforeUSD: 0.01, afterUSD: 0.004, cacheState: 'none', usdSavedPct: 60, notMeasured: 0 },
      quality: { checked: 1, clean: 1, regressions: [], inconclusive: [] },
      errors: [],
    },
  });
  const count = (html, tag) => (html.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;

  for (const proxyCheck of [null, { workloads: 1, direct: 100, bypassed: 100, delta: 0, identical: true, rows: [] }]) {
    const html = renderReport(make(proxyCheck));
    const head = html.split('<thead>')[1].split('</thead>')[0];
    const body = html.split('<tbody>')[1].split('</tbody>')[0];
    assert.equal(
      count(head, 'th'),
      count(body, 'td'),
      `header/body column mismatch with proxyCheck=${Boolean(proxyCheck)}`
    );
  }
});
