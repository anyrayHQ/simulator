// Read .env (no dependency — the file is four lines and we are not going to make
// a customer `npm install` to read it) and resolve the run config.

import { readFileSync, existsSync } from 'node:fs';

/** Parse a .env file into a plain object. Ignores comments and blank lines. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Real environment wins over .env, so CI and one-off overrides work as expected. */
export function loadEnv(path = '.env', env = process.env) {
  const fromFile = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  return { ...fromFile, ...env };
}

/**
 * Anthropic-native and OpenAI-compatible differ in auth header, endpoint path
 * and usage field names. Guess from the base URL, since that is nearly always
 * right, and let an explicit value override for a proxy or a self-hosted model.
 */
export function detectDialect(url, explicit) {
  if (explicit) return explicit;
  return /anthropic\.com/i.test(url) ? 'anthropic' : 'openai';
}

export function defaultEndpoint(dialect) {
  return dialect === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
}

/**
 * The optional THIRD arm: straight to the provider, no gateway at all.
 *
 * The two normal arms both traverse Anyray's proxy — one with optimization
 * bypassed — so "without Anyray" really means "Anyray forwarding unchanged". An
 * evaluator is right to notice that, and it is not answerable by argument: the
 * only honest reply is to measure a genuinely direct call and show that the
 * bypassed arm's token count matches it.
 *
 * Deliberately NOT read from ANTHROPIC_API_KEY / OPENAI_API_KEY. On an enrolled
 * machine those are part of the Anyray routing, so borrowing one is exactly how
 * a "direct" control ends up going through the gateway and proves nothing while
 * looking rigorous. The lab hit this; the variable is separate on purpose.
 */
export function resolveDirect(env, fallbackModel) {
  const url = (env.DIRECT_BASE_URL || '').replace(/\/+$/, '');
  if (!url) return null;
  if (!env.DIRECT_API_KEY) {
    throw new Error(
      'DIRECT_BASE_URL is set but DIRECT_API_KEY is not. The direct arm needs your own provider key — ' +
        'and it must be given explicitly, never borrowed from ANTHROPIC_API_KEY or OPENAI_API_KEY, which on an ' +
        'enrolled machine route through the gateway and would make the "direct" arm a second gateway arm.'
    );
  }
  if (/anyray/i.test(url)) {
    throw new Error(
      `DIRECT_BASE_URL points at ${url}, which looks like an Anyray host. The direct arm must bypass Anyray entirely, or it measures nothing.`
    );
  }
  const dialect = detectDialect(url, env.DIRECT_DIALECT);
  return {
    providerUrl: url,
    apiKey: env.DIRECT_API_KEY,
    dialect,
    endpoint: env.DIRECT_ENDPOINT || defaultEndpoint(dialect),
    model: env.DIRECT_MODEL || fallbackModel,
  };
}

export function resolveConfig(env) {
  const url = (env.ANYRAY_GATEWAY_URL || '').replace(/\/+$/, '');
  const missing = [];
  if (!url) missing.push('ANYRAY_GATEWAY_URL');
  if (!env.ANYRAY_API_KEY) missing.push('ANYRAY_API_KEY');
  // No default model: shipping one means a fresh clone fails on its first call
  // against any deployment that does not happen to route it.
  if (!env.PROOF_MODEL) missing.push('PROOF_MODEL');
  if (missing.length) {
    throw new Error(
      `missing ${missing.join(' and ')} — copy .env.example to .env and fill it in`
    );
  }
  const repeats = Number(env.PROOF_REPEATS ?? 3);
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new Error(`PROOF_REPEATS must be a positive integer, got ${env.PROOF_REPEATS}`);
  }
  return {
    gatewayUrl: url,
    apiKey: env.ANYRAY_API_KEY,
    model: env.PROOF_MODEL,
    repeats,
    endpoint: env.PROOF_ENDPOINT || '/v1/chat/completions',
    maxTokens: Number(env.PROOF_MAX_TOKENS ?? 1024),
    timeoutMs: Number(env.PROOF_TIMEOUT_MS ?? 120000),
    // Optional third arm. Null unless DIRECT_BASE_URL is set.
    direct: resolveDirect(env, env.PROOF_MODEL),
  };
}
