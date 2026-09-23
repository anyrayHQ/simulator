// Load and validate the workload files. A workload is one of the customer's own
// prompts plus the facts a correct answer has to carry.

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Validate one workload, returning the list of problems (empty = valid). */
export function validateWorkload(wl, file) {
  const problems = [];
  const where = file ? `${file}: ` : '';
  if (!wl || typeof wl !== 'object') return [`${where}not a JSON object`];
  if (!wl.id) problems.push(`${where}missing "id"`);
  if (!Array.isArray(wl.mustInclude) || wl.mustInclude.length === 0) {
    problems.push(`${where}"mustInclude" must be a non-empty array of required facts`);
  } else if (wl.mustInclude.some((f) => typeof f !== 'string' || !f.trim())) {
    problems.push(`${where}every entry in "mustInclude" must be a non-empty string`);
  }
  const msgs = wl.body?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    problems.push(`${where}"body.messages" must be a non-empty array`);
  }
  if (wl.body?.model) {
    problems.push(`${where}"body.model" is set — the model comes from PROOF_MODEL so both arms match`);
  }
  if (wl.body?.stream) problems.push(`${where}"body.stream" must not be set`);
  return problems;
}

export function loadWorkloads(dir = 'workloads', { only = null } = {}) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const workloads = [];
  const problems = [];
  for (const f of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      problems.push(`${f}: invalid JSON — ${e.message}`);
      continue;
    }
    const wl = { id: basename(f, '.json'), ...parsed };
    const bad = validateWorkload(wl, f);
    if (bad.length) problems.push(...bad);
    else workloads.push(wl);
  }
  const selected = only ? workloads.filter((w) => w.id === only || w.id.includes(only)) : workloads;
  return { workloads: selected, problems };
}

/**
 * CACHE ISOLATION — why every run stamps a unique id into its prompts.
 *
 * Provider prompt caches outlive a proof run. Running this repeatedly inside
 * the TTL (Anthropic ~5 min), the SECOND run's very first call already hits the
 * cache the FIRST run left behind. Measured live: after four runs, every
 * optimized call came back `cache_read_input_tokens: 2857` — including the one
 * the report was about to label "the first request, cold".
 *
 * That is not a rounding error, it is the difference between a measurement and
 * a flattering number, and it favours whichever arm Anyray made cacheable. A
 * customer who runs the proof twice would watch the saving grow for no reason
 * but their own repetition.
 *
 * The fix has to defeat a PREFIX cache, so it has to change the prefix: one id,
 * generated per run, stamped into the EARLIEST block the provider renders.
 *
 * Which block that is matters, and getting it wrong is silent. Providers render
 * `tools` -> `system` -> `messages`, and a cache breakpoint caches everything up
 * to itself. Anyray's cache_optimizer put its breakpoint on TOOLS for our
 * tool-heavy workload, so stamping the first message changed nothing the cache
 * keyed on: two back-to-back runs both came back
 * `cache_read_input_tokens: 2857` on their very first call. The stamp has to go
 * where the cache actually looks. Then:
 *
 *   - across runs   the prefix differs, so nothing carries over. Every run
 *                   starts genuinely cold.
 *   - within a run  all repeats share the id, so repeats 2 and 3 exercise the
 *                   cache exactly as a customer's resent prefix would.
 *
 * It goes into BOTH arms identically, so it cannot tilt the comparison — it
 * costs each arm the same handful of tokens. It is disclosed in the run output
 * and in the report, because silently editing someone's prompt and then
 * reporting a number about it would be the same sin in a different direction.
 */
export function stampRunId(workload, runId) {
  const marker = `[anyray proof-run ${runId} — identical in both arms; see README, "Cache isolation"]`;
  const body = { ...workload.body };

  // TOOLS first: rendered before everything else, so if the workload carries
  // any, this is the only place a stamp defeats the cache. A declared tool is
  // added rather than an existing description edited — the catalogue is often
  // the thing being measured, and quietly rewriting someone's tool definition
  // to make our instrument work is not a trade worth making. One extra tool,
  // in both arms, disclosed.
  if (Array.isArray(body.tools) && body.tools.length) {
    body.tools = [
      ...body.tools,
      {
        type: 'function',
        function: {
          name: `anyray_proof_run_${runId}`,
          description: marker,
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ];
  } else if (typeof body.system === 'string' && body.system) {
    body.system = `${marker}\n${body.system}`;
  } else {
    const msgs = [...(body.messages ?? [])];
    const first = msgs[0];
    if (!first) return workload;
    msgs[0] =
      typeof first.content === 'string'
        ? { ...first, content: `${marker}\n${first.content}` }
        : { ...first, content: [{ type: 'text', text: marker }, ...(first.content ?? [])] };
    body.messages = msgs;
  }
  return { ...workload, body };
}

/** Where the stamp landed, for the disclosure line. */
export function stampTarget(workload) {
  if (Array.isArray(workload.body?.tools) && workload.body.tools.length) return 'tools';
  if (typeof workload.body?.system === 'string' && workload.body.system) return 'system';
  return 'first message';
}

export const newRunId = () => randomUUID().slice(0, 8);
