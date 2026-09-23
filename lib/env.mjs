// Read .env (no dependency — the file is six lines and we are not going to make
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
 * right, and let PROVIDER_DIALECT override when it isn't (a proxy, a gateway of
 * their own, a self-hosted model on an unusual host).
 */
export function detectDialect(providerUrl, explicit) {
  if (explicit) return explicit;
  return /anthropic\.com/i.test(providerUrl) ? 'anthropic' : 'openai';
}

export function defaultEndpoint(dialect) {
  return dialect === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
}

export function resolveConfig(env) {
  const providerUrl = (env.PROVIDER_BASE_URL || '').replace(/\/+$/, '');
  const missing = [];
  if (!providerUrl) missing.push('PROVIDER_BASE_URL');
  if (!env.PROVIDER_API_KEY) missing.push('PROVIDER_API_KEY');
  if (missing.length) {
    throw new Error(
      `missing ${missing.join(' and ')} — copy .env.example to .env and fill it in.\n` +
        `This is YOUR provider key, used to call YOUR provider directly. It is not sent to Anyray.`
    );
  }
  const repeats = Number(env.PROOF_REPEATS ?? 3);
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new Error(`PROOF_REPEATS must be a positive integer, got ${env.PROOF_REPEATS}`);
  }
  const dialect = detectDialect(providerUrl, env.PROVIDER_DIALECT);
  return {
    providerUrl,
    apiKey: env.PROVIDER_API_KEY,
    dialect,
    endpoint: env.PROOF_ENDPOINT || defaultEndpoint(dialect),
    optimizerUrl: (env.OPTIMIZER_URL || 'http://localhost:8088').replace(/\/+$/, ''),
    model: env.PROOF_MODEL || 'claude-sonnet-5',
    repeats,
    maxTokens: Number(env.PROOF_MAX_TOKENS ?? 1024),
    timeoutMs: Number(env.PROOF_TIMEOUT_MS ?? 120000),
    readyTimeoutMs: Number(env.PROOF_READY_TIMEOUT_MS ?? 180000),
  };
}
