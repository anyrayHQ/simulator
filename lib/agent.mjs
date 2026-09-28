// One agent session: a model with tools works a task until it calls `finish`,
// runs out of turns, or overflows its context. TURNS ARE AN OUTCOME here, not a
// parameter — the thing a per-request bench structurally cannot measure. Remove
// context the agent still needs and tokens per call fall while turns rise; only
// a live session shows which wins.
//
// The request shape copies a real coding harness rather than an idealised one:
// Anthropic Messages, the full transcript resent every turn, and (by default)
// cache breakpoints on the system prompt, the tool list and the newest message,
// the way Claude Code places them. That is what makes cache effects — the
// dominant cost of a real session — show up in the bill.

import { fetchRetry } from './http.mjs';
import { bedrockRequest } from './bedrock.mjs';
import { normalizeUsage, sumUsage } from './usage.mjs';
import { TOOLS, TASK, runTool, grade } from './world.mjs';

export const SYSTEM =
  'You are a senior engineer investigating a production incident in a repository. ' +
  'Use the tools to look at files; you cannot run commands. Be methodical and verify before concluding. ' +
  'When done, call `finish` with a short answer naming the upstream service, the exact error, the config key that changed, and the PR number.';

const mark = { type: 'ephemeral' };

/** The body for one turn, with harness-style cache breakpoints when asked. */
export function buildRequest({ system, tools, messages, maxTokens, cache }) {
  const body = {
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, ...(cache ? { cache_control: mark } : {}) }],
    tools: tools.map((t, i) => (cache && i === tools.length - 1 ? { ...t, cache_control: mark } : t)),
    messages: messages.map((m) => ({ ...m, content: m.content.map((b) => ({ ...b })) })),
  };
  if (cache) {
    const last = body.messages[body.messages.length - 1];
    const block = last.content[last.content.length - 1];
    last.content[last.content.length - 1] = { ...block, cache_control: mark };
  }
  return body;
}

/**
 * Run one session. `send(body)` returns the provider's Anthropic-shaped JSON;
 * `extraTools` are served by `callExtra(name, input)` (Anyray's retrieval tools
 * on an enrolled client).
 */
export async function runSession({ send, files, stamp, maxTurns = 30, maxTokens = 4096, cache = true, extraTools = [], callExtra }) {
  // The stamp makes each session's prompt unique, so no arm or round can ride
  // a cache another one warmed.
  const system = `[session ${stamp}]\n${SYSTEM}`;
  const tools = [...TOOLS, ...extraTools];
  const extraNames = new Set(extraTools.map((t) => t.name));
  const messages = [{ role: 'user', content: [{ type: 'text', text: TASK }] }];
  const perTurn = [];
  const toolCounts = {};
  let answer = null;
  let stop = 'max_turns';
  const started = Date.now();

  for (let turn = 1; turn <= maxTurns; turn++) {
    const json = await send(buildRequest({ system, tools, messages, maxTokens, cache }));
    const usage = normalizeUsage(json.usage ?? {});
    perTurn.push(usage);
    const content = json.content ?? [];
    messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no output)' }] });

    const calls = content.filter((b) => b.type === 'tool_use');
    if (!calls.length) {
      // A turn with no tool call: take the text as the answer, like a harness
      // that ends when the model stops asking for tools.
      answer = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      stop = json.stop_reason === 'max_tokens' ? 'max_tokens' : 'no_tool_call';
      break;
    }
    const results = [];
    for (const c of calls) {
      toolCounts[c.name] = (toolCounts[c.name] ?? 0) + 1;
      if (c.name === 'finish') {
        answer = c.input?.answer ?? '';
        stop = 'finish';
      }
      const out =
        c.name === 'finish'
          ? 'Answer recorded.'
          : extraNames.has(c.name)
            ? await callExtra(c.name, c.input).catch((e) => `Error: ${e.message}`)
            : runTool(files, c.name, c.input);
      results.push({ type: 'tool_result', tool_use_id: c.id, content: out });
    }
    messages.push({ role: 'user', content: results });
    if (stop === 'finish') break;
  }

  const usage = sumUsage(perTurn);
  return {
    turns: perTurn.length,
    stop,
    answer,
    ...grade(answer),
    usage,
    peakContext: Math.max(0, ...perTurn.map((u) => u.billedInput)),
    toolCounts,
    latencyMs: Date.now() - started,
  };
}

// ---------- senders: where one turn's request goes ----------

async function postJson(url, headers, payload, timeoutMs) {
  let res;
  try {
    res = await fetchRetry(url, () => ({ method: 'POST', headers, body: payload }), { timeoutMs });
  } catch (e) {
    const cause = e?.cause?.message ?? e?.cause?.code;
    throw new Error(cause ? `${e.message} (${cause})` : e.message);
  }
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json();
}

/** Through the gateway. `optimize: 'off'` is the bypassed arm. */
export function gatewaySender(cfg, { optimize, experiment }) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.apiKey}`,
    'anthropic-version': '2023-06-01',
    // `experiment` is matched by an admin-defined optimizer rule
    // (`when.metadata.experiment`), which is how one arm runs a single strategy
    // without changing what anyone else's traffic gets.
    'x-anyray-metadata': JSON.stringify({ tool: 'anyray-simulator-session', ...(experiment ? { experiment } : {}) }),
    ...(cfg.provider ? { 'x-anyray-provider': cfg.provider } : {}),
    ...(optimize === 'off' ? { 'x-anyray-optimize': 'off' } : {}),
  };
  return (body) => postJson(`${cfg.gatewayUrl}/v1/messages`, headers, JSON.stringify({ ...body, model: cfg.model }), cfg.timeoutMs);
}

/** Straight to the provider, nothing of ours in the path. */
export function directSender(cfg) {
  const d = cfg.direct;
  if (d.dialect === 'bedrock') {
    return (body) => {
      const payload = JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', ...body });
      const { url } = bedrockRequest(d, payload);
      return fetchRetry(url, () => ({ method: 'POST', headers: bedrockRequest(d, payload).headers, body: payload }), { timeoutMs: cfg.timeoutMs })
        .then(async (res) => {
          if (!res.ok) throw new Error(`bedrock ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
          return res.json();
        });
    };
  }
  if (d.dialect !== 'anthropic') throw new Error(`session mode needs an Anthropic or Bedrock direct arm, not ${d.dialect}`);
  const headers = { 'content-type': 'application/json', 'x-api-key': d.apiKey, 'anthropic-version': '2023-06-01' };
  return (body) => postJson(`${d.providerUrl}/v1/messages`, headers, JSON.stringify({ ...body, model: d.model }), cfg.timeoutMs);
}

/** Anyray's retrieval MCP (`/mcp`) as tools, the way an enrolled client has them. */
export async function retrievalTools(cfg) {
  const rpc = async (method, params) => {
    const json = await postJson(
      `${cfg.gatewayUrl}/mcp`,
      { 'content-type': 'application/json', accept: 'application/json', 'x-anyray-api-key': cfg.apiKey },
      JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      cfg.timeoutMs
    );
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  };
  const { tools = [] } = await rpc('tools/list');
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema ?? { type: 'object' } })),
    call: async (name, input) => {
      const r = await rpc('tools/call', { name, arguments: input ?? {} });
      return (r?.content ?? []).map((b) => b.text ?? '').join('\n') || JSON.stringify(r);
    },
  };
}
