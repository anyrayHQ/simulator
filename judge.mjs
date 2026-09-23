#!/usr/bin/env node
// Optional second opinion. Shows your own model both answers — shuffled and
// unlabelled — and asks which is better, or whether they tie.
//
// Two rules make this worth reading:
//   1. The judge is never told which answer came from which arm. The order is
//      randomized per workload and the labels are A and B.
//   2. The grading call itself runs with `x-anyray-optimize: off`, so we cannot
//      influence the judging prompt on its way to the model.
//
// It is indicative, not a verdict. Ten workloads is ten data points.
//
//   node prove.mjs && node judge.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadEnv, resolveConfig } from './lib/env.mjs';
import { callGateway } from './lib/gateway.mjs';

const RUBRIC =
  'You are grading two answers to the same task. Judge only which answer better ' +
  'serves someone who asked this question: correctness first, then completeness, ' +
  'then clarity. Length is not a virtue in itself. If neither is clearly better, ' +
  'say tie. Reply with ONLY a JSON object: ' +
  '{"winner":"A"|"B"|"tie","why":"one short sentence"}.';

/** First balanced JSON object in a string, ignoring braces inside strings. */
export function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object in judge reply');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error('unterminated JSON object in judge reply');
}

/** The question the workload asked, as plain text, for the judge's context. */
function questionOf(result, workloadBody) {
  const msgs = workloadBody?.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const content = lastUser?.content;
  const text = Array.isArray(content)
    ? content.map((b) => b?.text ?? '').join('\n')
    : String(content ?? '');
  return text.slice(0, 2000) || result.title || result.id;
}

async function main() {
  const file = process.argv.includes('--in')
    ? process.argv[process.argv.indexOf('--in') + 1]
    : 'results.json';
  if (!existsSync(file)) {
    console.error(`${file} not found — run \`node prove.mjs\` first.`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const cfg = resolveConfig(loadEnv());

  const rows = [];
  for (const res of data.results) {
    const bypassed = res.bypassedRuns.find((r) => !r.error)?.answer;
    const optimized = res.optimizedRuns.find((r) => !r.error)?.answer;
    if (!bypassed || !optimized) continue;

    // Coin flip per workload: which arm gets to be "A".
    const optimizedIsA = Math.random() < 0.5;
    const A = optimizedIsA ? optimized : bypassed;
    const B = optimizedIsA ? bypassed : optimized;

    const prompt = `TASK:\n${questionOf(res, res.body)}\n\nANSWER A:\n${A}\n\nANSWER B:\n${B}`;
    // A system-ROLE message is invalid on /v1/messages, where the instruction
    // belongs in top-level `system`. Same rubric either way.
    const body = cfg.endpoint.includes('/messages')
      ? { temperature: 0, system: RUBRIC, messages: [{ role: 'user', content: prompt }] }
      : { temperature: 0, messages: [{ role: 'system', content: RUBRIC }, { role: 'user', content: prompt }] };

    try {
      // optimize:'off' — the grading call bypasses Anyray entirely.
      const r = await callGateway({ ...cfg, maxTokens: 300 }, body, { optimize: 'off' });
      const parsed = JSON.parse(extractJsonObject(r.answer));
      const winner =
        parsed.winner === 'tie'
          ? 'tie'
          : (parsed.winner === 'A') === optimizedIsA
            ? 'optimized'
            : 'bypassed';
      rows.push({ id: res.id, winner, why: String(parsed.why ?? '') });
      console.log(`${res.id.padEnd(30)} ${winner.padEnd(10)} ${parsed.why ?? ''}`);
    } catch (e) {
      rows.push({ id: res.id, error: e.message });
      console.error(`${res.id}: judge failed — ${e.message}`);
    }
  }

  const tally = { optimized: 0, bypassed: 0, tie: 0 };
  for (const r of rows) if (r.winner) tally[r.winner]++;
  const judged = tally.optimized + tally.bypassed + tally.tie;
  console.log('');
  console.log(
    `BLIND GRADING (indicative)\n  with Anyray preferred ${tally.optimized}, without ${tally.bypassed}, tie ${tally.tie}, over ${judged} workload(s)`
  );
  console.log(
    `  ${judged} workloads is a small sample, graded by one model. Read it as a smell test, not as the quality verdict — that is the fact check in prove.mjs.`
  );

  writeFileSync('judge.json', JSON.stringify({ judgedAt: new Date().toISOString(), model: cfg.model, rows, tally }, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
