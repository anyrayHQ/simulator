// The direct arm, when the provider is AWS Bedrock.
//
// A gateway that routes Claude through Bedrock has no Anthropic key to compare
// against, so "direct" has to mean Bedrock too — otherwise the control arm runs
// on a different provider and a token delta could be the provider, not us.
//
// Bedrock does not speak the workload's OpenAI-compatible shape. We translate to
// the Anthropic Messages body InvokeModel takes, sign with SigV4 (no SDK: this
// repo has no dependencies and is not getting any for one arm), and read back an
// Anthropic-native `usage`, which normalizeUsage already understands.

import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** `https://bedrock-runtime.us-east-1.amazonaws.com` -> `us-east-1`. */
export function regionFromUrl(url) {
  const m = /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/i.exec(url);
  if (!m) throw new Error(`cannot read an AWS region from DIRECT_BASE_URL ${url}; expected https://bedrock-runtime.<region>.amazonaws.com`);
  return m[1];
}

/**
 * OpenAI chat body -> Anthropic Messages body, the shape InvokeModel takes for
 * Claude. Consecutive same-role turns are merged: tool results come back as
 * user turns, and a run of them followed by the user's question must be one.
 */
export function toAnthropicBody(body, { maxTokens } = {}) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  const textBlocks = (content) => {
    if (content == null || content === '') return [];
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return content.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : { type: 'text', text: b?.text ?? '' }));
  };

  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(...textBlocks(m.content).map((b) => b.text));
    } else if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content }]);
    } else if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => ({
        type: 'tool_use',
        id: c.id,
        name: c.function?.name,
        input: safeJson(c.function?.arguments),
      }));
      push('assistant', [...textBlocks(m.content), ...calls]);
    } else {
      push('user', textBlocks(m.content));
    }
  }

  const out = { anthropic_version: 'bedrock-2023-05-31', messages };
  if (system.length) out.system = system.join('\n\n');
  if (body.tools?.length) {
    out.tools = body.tools.map((t) => {
      const f = t.function ?? t;
      return { name: f.name, description: f.description, input_schema: f.parameters ?? f.input_schema ?? { type: 'object' } };
    });
  }
  if (body.temperature != null) out.temperature = body.temperature;
  out.max_tokens = body.max_tokens ?? body.max_completion_tokens ?? maxTokens;
  return out;
}

function safeJson(s) {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

let cachedCreds = null;

/**
 * AWS credentials: the standard env vars first, else whatever the AWS CLI
 * resolves (profiles, SSO, MFA caches). Asking the CLI means every way a
 * machine is already logged in works, without this repo reimplementing any.
 */
export function awsCredentials(env = process.env) {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN };
  }
  if (cachedCreds) return cachedCreds;
  let out;
  try {
    out = execFileSync('aws', ['configure', 'export-credentials', '--format', 'process'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(
      `the Bedrock direct arm needs AWS credentials: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, set DIRECT_API_KEY to a Bedrock API key, or log in to the AWS CLI (${String(e.stderr || e.message).trim().slice(0, 200)})`
    );
  }
  const j = JSON.parse(out);
  cachedCreds = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.SessionToken };
  return cachedCreds;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

/** SigV4 headers for one POST. `now` is injectable so the signature is testable. */
export function signV4({ url, body, region, service = 'bedrock', creds, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  // Non-S3 services sign each path segment encoded a second time. The request
  // line carries `%3A` for the `:` in a model id; the canonical path `%253A`.
  const canonicalUri = u.pathname.split('/').map((s) => encodeURIComponent(s)).join('/');
  const headers = { 'content-type': 'application/json', host: u.host, 'x-amz-date': amzDate };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const names = Object.keys(headers).sort();
  const canonical = [
    'POST',
    canonicalUri,
    '',
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    sha256(body),
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let key = hmac(`AWS4${creds.secretAccessKey}`, day);
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const { host, ...rest } = headers;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

/** Request URL and headers for one InvokeModel call. */
export function bedrockRequest(direct, payloadJson, { env = process.env, now } = {}) {
  const url = `${direct.providerUrl}/model/${encodeURIComponent(direct.model)}/invoke`;
  // A Bedrock API key is a bearer token and needs no signing.
  if (direct.apiKey) {
    return { url, headers: { 'content-type': 'application/json', authorization: `Bearer ${direct.apiKey}` } };
  }
  const headers = signV4({ url, body: payloadJson, region: regionFromUrl(direct.providerUrl), creds: awsCredentials(env), now });
  return { url, headers };
}
