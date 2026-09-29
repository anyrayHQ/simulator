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
import { TOOLS, TASK, FOLLOWUPS, runTool, grade, gradeAgainst } from './world.mjs';

export const SYSTEM =
  'You are a senior engineer working a production incident. Use the tools you are given. ' +
  'Be methodical and verify before concluding. When done, call `finish` with a short answer that states exactly what the task asks for.';

const mark = { type: 'ephemeral' };

/**
 * A person thinking before the next prompt. Past the provider's 5-minute cache
 * TTL, the whole transcript is billed again at full price on the next turn,
 * which is where trimming the transcript earns most.
 */
const idle = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);

/** The body for one turn, with harness-style cache breakpoints when asked. */
/** Headroom for adaptive thinking, which sets no budget of its own. */
const ADAPTIVE_ROOM = 16000;

/**
 * `thinking` is a token budget (`type: enabled`) or `{ effort }` for adaptive
 * thinking, the only kind newer models accept (Sonnet 5 400s on `enabled`).
 */
function thinkingFields(thinking) {
  if (!thinking) return {};
  if (typeof thinking === 'number') return { thinking: { type: 'enabled', budget_tokens: thinking } };
  return { thinking: { type: 'adaptive' }, ...(thinking.effort ? { output_config: { effort: thinking.effort } } : {}) };
}

export function buildRequest({ system, tools, messages, maxTokens, cache, thinking }) {
  const body = {
    // Thinking tokens count against max_tokens, so the answer keeps its own room.
    max_tokens: !thinking ? maxTokens : maxTokens + (typeof thinking === 'number' ? thinking : ADAPTIVE_ROOM),
    ...thinkingFields(thinking),
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
export async function runSession({ send, files, scenario, stamp, maxTurns = 30, maxTokens = 4096, cache = true, thinking = 0, followups = 0, pauseMs = 0, extraTools = [], callExtra }) {
  // The stamp makes each session's prompt unique, so no arm or round can ride
  // a cache another one warmed.
  const system = `[session ${stamp}]\n${SYSTEM}`;
  // A scenario (e.g. lib/watch.mjs) brings its own task, tools, grader and a
  // per-session tool runner; without one, the incident repository in `files`.
  const task = scenario?.task ?? TASK;
  const run = scenario ? scenario.runner() : (name, input) => runTool(files, name, input);
  const judge = scenario ? (a) => gradeAgainst(scenario.required, a) : grade;
  // Follow-ups are further user prompts on the same transcript, sent after each
  // answer: a person who keeps asking in one session. Everything before a
  // follow-up is then a past turn, including its thinking — which is what
  // thinking_replay_trim may drop and a single-prompt session never produces.
  const extra = (scenario?.followups ?? FOLLOWUPS).slice(0, followups);
  if (extra.length < followups) throw new Error(`this task has only ${extra.length} follow-up(s)`);
  const segments = [{ judge }, ...extra.map((f) => ({ prompt: f.prompt, judge: (a) => gradeAgainst(f.required, a) }))];
  const answers = [];
  const tools = [...(scenario?.tools ?? TOOLS), ...extraTools];
  const extraNames = new Set(extraTools.map((t) => t.name));
  const messages = [{ role: 'user', content: [{ type: 'text', text: task }] }];
  const perTurn = [];
  const toolCounts = {};
  let answer = null;
  let stop = 'max_turns';
  const started = Date.now();

  for (let turn = 1; turn <= maxTurns; turn++) {
    const json = await send(buildRequest({ system, tools, messages, maxTokens, cache, thinking }));
    const usage = normalizeUsage(json.usage ?? {});
    perTurn.push(usage);
    const content = json.content ?? [];
    messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no output)' }] });

    const calls = content.filter((b) => b.type === 'tool_use');
    const next = segments[answers.length + 1];
    if (!calls.length) {
      // A turn with no tool call: take the text as the answer, like a harness
      // that ends when the model stops asking for tools.
      answer = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      stop = json.stop_reason === 'max_tokens' ? 'max_tokens' : 'no_tool_call';
      if (stop === 'max_tokens' || !next) break;
      answers.push(answer);
      messages.push({ role: 'user', content: [{ type: 'text', text: next.prompt }] });
      stop = 'max_turns';
      answer = null;
      await idle(pauseMs);
      continue;
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
            : run(c.name, c.input);
      results.push({ type: 'tool_result', tool_use_id: c.id, content: out });
    }
    if (stop === 'finish' && next) {
      // The next prompt rides with the tool results, as a harness sends a
      // message typed while the agent was finishing.
      answers.push(answer);
      messages.push({ role: 'user', content: [...results, { type: 'text', text: next.prompt }] });
      stop = 'max_turns';
      answer = null;
      await idle(pauseMs);
      continue;
    }
    messages.push({ role: 'user', content: results });
    if (stop === 'finish') break;
  }
  answers.push(answer);

  // Solved means every prompt was answered; a segment never reached fails.
  const graded = segments.map((seg, i) => seg.judge(answers[i]));
  const found = graded.flatMap((g) => g.found);
  const missing = graded.flatMap((g) => g.missing);

  const usage = sumUsage(perTurn);
  return {
    turns: perTurn.length,
    stop,
    answer: segments.length > 1 ? answers.map((a) => a ?? '(not reached)').join('\n\n---\n\n') : answer,
    solved: graded.every((g) => g.solved),
    found,
    missing,
    ...(segments.length > 1 ? { segments: graded.map((g) => g.solved) } : {}),
    usage,
    peakContext: Math.max(0, ...perTurn.map((u) => u.billedInput)),
    // Per turn, so prefix churn shows: after the first turn a stable prefix
    // writes only what is new; a rewrite that moves each turn writes far more.
    cacheWriteByTurn: perTurn.map((u) => u.cacheWrite),
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
    // An experiment arm also names itself as its own client tool, which is the
    // one caller field the gateway's traces keep. That is what lets a run be
    // audited afterwards (audit.mjs) for which strategies actually acted.
    'x-anyray-metadata': JSON.stringify(
      experiment ? { tool: `anyray-simulator-cc-${experiment}`, experiment } : { tool: 'anyray-simulator-session' }
    ),
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
