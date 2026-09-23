// One call to THE CUSTOMER'S OWN PROVIDER, with their own key.
//
// This is the only request in the whole tool that leaves their machine, and it
// goes exactly where their application already sends traffic. Anyray is not in
// this path: the optimizer transformed the body first, locally, and then got
// out of the way. That is what lets the README say — without an asterisk — that
// no prompt ever reaches us.
//
// Both arms call this identically. The ONLY difference between them is whether
// the body was transformed by the local optimizer first.

import { fetchRetry } from './http.mjs';

/** OpenAI-compatible /v1/chat/completions response -> { answer, usage }. */
export function parseCompletion(body) {
  const choice = body?.choices?.[0] ?? {};
  const content = choice.message?.content ?? '';
  const answer = Array.isArray(content)
    ? content.map((b) => b?.text ?? '').join('')
    : String(content);
  return { answer, usage: body?.usage ?? {}, finishReason: choice.finish_reason ?? null };
}

/** Anthropic-native /v1/messages response -> { answer, usage }. */
export function parseMessages(body) {
  const answer = (body?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b?.text ?? '')
    .join('');
  return { answer, usage: body?.usage ?? {}, finishReason: body?.stop_reason ?? null };
}

/**
 * Provider auth differs by dialect and getting it wrong is a 401 that looks like
 * a bad key. Anthropic-native wants `x-api-key` plus a version header; every
 * OpenAI-compatible endpoint wants `Authorization: Bearer`.
 */
export function authHeaders({ dialect, apiKey }) {
  if (dialect === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${apiKey}` };
}

export async function callProvider(cfg, body, { fetchImpl = fetch } = {}) {
  const headers = {
    'content-type': 'application/json',
    ...authHeaders({ dialect: cfg.dialect, apiKey: cfg.apiKey }),
  };
  const payload = { ...body, model: cfg.model };
  if (payload.max_tokens == null) payload.max_tokens = cfg.maxTokens;

  const started = Date.now();
  let res;
  try {
    res = await fetchRetry(
      `${cfg.providerUrl}${cfg.endpoint}`,
      () => ({ method: 'POST', headers, body: JSON.stringify(payload) }),
      { timeoutMs: cfg.timeoutMs, fetchImpl }
    );
  } catch (e) {
    // Node's fetch reports every connection failure as a bare "fetch failed"
    // and hides the reason on .cause — the one thing the reader needs.
    const cause = e?.cause?.message ?? e?.cause?.code;
    throw new Error(cause ? `${e.message} (${cause})` : e.message);
  }
  if (!res.ok) {
    const text = (await res.text?.().catch(() => '')) ?? '';
    throw new Error(`provider ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const parsed = cfg.dialect === 'anthropic' ? parseMessages(json) : parseCompletion(json);
  return { ...parsed, latencyMs: Date.now() - started };
}
