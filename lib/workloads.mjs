// Load and validate the workload files. A workload is one of the customer's own
// prompts plus the facts a correct answer has to carry.

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

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
