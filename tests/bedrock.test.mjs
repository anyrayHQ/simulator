import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicBody, signV4, regionFromUrl, bedrockRequest } from '../lib/bedrock.mjs';
import { resolveDirect, resolveConfig } from '../lib/env.mjs';
import { rateFor, loadRates } from '../lib/rates.mjs';
import { callGateway } from '../lib/gateway.mjs';

test('bedrock: an agent transcript translates to alternating Anthropic turns', () => {
  const out = toAnthropicBody(
    {
      temperature: 0,
      tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }],
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'investigate' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'c0', content: 'a.txt' },
        { role: 'user', content: 'which file?' },
      ],
    },
    { maxTokens: 64 }
  );
  assert.equal(out.system, 'be terse');
  assert.equal(out.max_tokens, 64);
  assert.equal(out.temperature, 0);
  assert.deepEqual(out.tools, [{ name: 'bash', description: 'run', input_schema: { type: 'object' } }]);
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(out.messages[1].content, [{ type: 'tool_use', id: 'c0', name: 'bash', input: { command: 'ls' } }]);
  // The tool result and the follow-up question share one user turn.
  assert.deepEqual(out.messages[2].content.map((b) => b.type), ['tool_result', 'text']);
});

test('bedrock: SigV4 double-encodes the model id in the canonical path, and is deterministic', () => {
  const args = {
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke',
    body: '{}',
    region: 'us-east-1',
    creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'tok' },
    now: new Date('2026-09-28T12:00:00Z'),
  };
  const a = signV4(args);
  assert.equal(a['x-amz-date'], '20260928T120000Z');
  assert.equal(a['x-amz-security-token'], 'tok');
  assert.match(a.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260928\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(signV4(args).authorization, a.authorization);
  assert.notEqual(signV4({ ...args, body: '{"x":1}' }).authorization, a.authorization);
});

test('bedrock: region comes from the runtime URL, and a Bedrock API key skips signing', () => {
  assert.equal(regionFromUrl('https://bedrock-runtime.eu-west-1.amazonaws.com'), 'eu-west-1');
  assert.throws(() => regionFromUrl('https://api.anthropic.com'), /region/);
  const r = bedrockRequest({ providerUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', model: 'us.anthropic.claude-sonnet-5', apiKey: 'brk' }, '{}');
  assert.equal(r.url, 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-5/invoke');
  assert.equal(r.headers.authorization, 'Bearer brk');
});

test('bedrock: a runtime URL selects the dialect and needs no DIRECT_API_KEY', () => {
  const d = resolveDirect({ DIRECT_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com' }, 'us.anthropic.claude-sonnet-5');
  assert.equal(d.dialect, 'bedrock');
  assert.equal(d.model, 'us.anthropic.claude-sonnet-5');
  // Every other provider still requires an explicit key.
  assert.throws(() => resolveDirect({ DIRECT_BASE_URL: 'https://api.anthropic.com' }, 'm'), /DIRECT_API_KEY/);
});

test('rates: Bedrock ids price as the model they name', () => {
  const rates = loadRates();
  assert.deepEqual(rateFor(rates, 'us.anthropic.claude-sonnet-5'), rateFor(rates, 'claude-sonnet-5'));
  assert.deepEqual(rateFor(rates, 'anthropic.claude-sonnet-4-5-20250929-v1:0'), rateFor(rates, 'claude-sonnet-4-5'));
  assert.equal(rateFor(rates, 'us.anthropic.claude-made-up-9'), null);
});

test('ANYRAY_PROVIDER pins the upstream on BOTH gateway arms', async () => {
  const cfg = resolveConfig({ ANYRAY_GATEWAY_URL: 'https://gw', ANYRAY_API_KEY: 'k', PROOF_MODEL: 'm', ANYRAY_PROVIDER: 'bedrock' });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) };
  };
  await callGateway(cfg, { messages: [] }, { optimize: 'off', fetchImpl });
  await callGateway(cfg, { messages: [] }, { optimize: 'on', fetchImpl });
  assert.deepEqual(seen.map((h) => h['x-anyray-provider']), ['bedrock', 'bedrock']);
});

test('PROOF_OMIT_PARAMS drops a field from the body every arm sends', async () => {
  const { omitParams } = await import('../lib/workloads.mjs');
  const wl = { id: 'w', body: { temperature: 0, messages: [] } };
  assert.deepEqual(omitParams(wl, ['temperature']).body, { messages: [] });
  assert.equal(wl.body.temperature, 0, 'the original workload is left alone');
  assert.equal(omitParams(wl, []), wl);
  const cfg = resolveConfig({ ANYRAY_GATEWAY_URL: 'https://gw', ANYRAY_API_KEY: 'k', PROOF_MODEL: 'm', PROOF_OMIT_PARAMS: 'temperature, top_p' });
  assert.deepEqual(cfg.omitParams, ['temperature', 'top_p']);
});
