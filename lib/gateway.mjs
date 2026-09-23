// One call to the customer's gateway. Same URL, same key, same model, same body
// on both arms — the ONLY difference is the `x-anyray-optimize: off` header on
// the bypassed arm. If anything else differed, the comparison would not be one.

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
 * Send one workload body.
 * optimize 'off' sets the bypass header; 'on' sends the request your app would
 * normally send, with no Anyray header at all — the point is that the optimized
 * arm is the ordinary path, not a special one.
 */
export async function callGateway(cfg, body, { optimize, fetchImpl = fetch } = {}) {
  const path = cfg.endpoint;
  const native = path.includes('/messages');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.apiKey}`,
    // Names this repo as the caller so the run shows up as a simulator run on the
    // dashboard rather than as whoever's laptop it happened to execute on.
    'x-anyray-metadata': JSON.stringify({ tool: 'anyray-simulator' }),
    // Asks the gateway for the content-free `x-anyray-optimization` response
    // header, which is what fills the "which strategies fired" column. The
    // gateway gates it behind this header, so without it that column is empty
    // on every workload and the report silently loses the one piece of
    // evidence that Anyray did anything at all.
    'x-anyray-test': '1',
  };
  if (native) headers['anthropic-version'] = '2023-06-01';
  if (optimize === 'off') headers['x-anyray-optimize'] = 'off';

  const payload = { ...body, model: cfg.model };
  if (payload.max_tokens == null) payload.max_tokens = cfg.maxTokens;

  const started = Date.now();
  let res;
  try {
    res = await fetchRetry(
      `${cfg.gatewayUrl}${path}`,
      () => ({ method: 'POST', headers, body: JSON.stringify(payload) }),
      { timeoutMs: cfg.timeoutMs, fetchImpl }
    );
  } catch (e) {
    // Node's fetch reports every connection failure as a bare "fetch failed"
    // and hides the real reason on .cause — which is the one thing the person
    // reading this needs.
    const cause = e?.cause?.message ?? e?.cause?.code;
    throw new Error(cause ? `${e.message} (${cause})` : e.message);
  }
  if (!res.ok) {
    const text = (await res.text?.().catch(() => '')) ?? '';
    throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const parsed = native ? parseMessages(json) : parseCompletion(json);

  // What the gateway says it did. Absent is not an error — a bypassed call has
  // nothing to report, and not every deployment emits it.
  //
  // The decision objects key the strategy name as `kind`, and the interesting
  // part is often the `summary`: a live gateway answered our log-dump workload
  // with status "skipped" and the reason "turn declared no callable tool, so
  // pin-dependent strategies stood down". Reading only a `strategy` field threw
  // all of that away and rendered an empty Strategies column, which read as
  // "Anyray did nothing" when the truth was "Anyray decided not to, and said
  // why". That distinction is the whole difference between a tool an evaluator
  // trusts and one they don't.
  let optimization = null;
  const hdr = res.headers?.get?.('x-anyray-optimization');
  if (hdr) {
    try {
      const decoded = JSON.parse(hdr);
      const decisions = Array.isArray(decoded) ? decoded : (decoded?.decisions ?? []);
      optimization = {
        status: Array.isArray(decoded) ? null : (decoded?.status ?? null),
        strategies: [
          ...new Set(decisions.map((d) => d?.kind ?? d?.strategy ?? d?.name).filter(Boolean)),
        ],
        notes: decisions.map((d) => d?.summary).filter(Boolean),
        suppressed: (decoded?.suppressedKinds ?? []).map(
          (s) => `${s?.kind ?? '?'} (${s?.reason ?? '?'})`
        ),
      };
    } catch {
      optimization = null;
    }
  }
  return {
    ...parsed,
    strategies: optimization?.strategies ?? [],
    optimization,
    latencyMs: Date.now() - started,
  };
}
