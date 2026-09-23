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

export function resolveConfig(env) {
  const url = (env.ANYRAY_GATEWAY_URL || '').replace(/\/+$/, '');
  const missing = [];
  if (!url) missing.push('ANYRAY_GATEWAY_URL');
  if (!env.ANYRAY_API_KEY) missing.push('ANYRAY_API_KEY');
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
    model: env.PROOF_MODEL || 'claude-sonnet-5',
    repeats,
    endpoint: env.PROOF_ENDPOINT || '/v1/chat/completions',
    maxTokens: Number(env.PROOF_MAX_TOKENS ?? 1024),
    timeoutMs: Number(env.PROOF_TIMEOUT_MS ?? 120000),
  };
}
