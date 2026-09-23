#!/usr/bin/env node
// The one command. Sends each workload twice — bypassed and optimized — repeats
// each arm, and answers both questions: does it cost less, and are the answers
// still the same?
//
//   node prove.mjs                      every workload in workloads/
//   node prove.mjs --workload 04-...    just one
//   node prove.mjs --repeats 1          a smoke test, not a proof
//   node prove.mjs --dry-run            validate workloads, call nothing
//
// Writes results.json (gitignored — it holds your prompts and both answers).

import { writeFileSync } from 'node:fs';
import { loadEnv, resolveConfig } from './lib/env.mjs';
import { loadWorkloads, stampRunId, newRunId } from './lib/workloads.mjs';
import { callGateway } from './lib/gateway.mjs';
import { normalizeUsage } from './lib/usage.mjs';
import { loadRates } from './lib/rates.mjs';
import { summarize, renderRow, renderVerdicts } from './lib/verdict.mjs';

function parseArgs(argv) {
  const a = { only: null, repeats: null, dryRun: false, dir: 'workloads', out: 'results.json' };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--workload') a.only = argv[++i];
    else if (f === '--repeats') a.repeats = Number(argv[++i]);
    else if (f === '--dry-run') a.dryRun = true;
    else if (f === '--no-cache-isolation') a.noCacheIsolation = true;
    else if (f === '--dir') a.dir = argv[++i];
    else if (f === '--out') a.out = argv[++i];
    else if (f === '--help' || f === '-h') a.help = true;
  }
  return a;
}

const USAGE = `node prove.mjs [--workload <id>] [--repeats <n>] [--dry-run] [--dir workloads]`;

/** One arm of one repeat. Failures are recorded, not thrown: one 400 on one
 *  workload should not throw away the rest of a run you are paying for. */
async function runOnce(cfg, wl, optimize) {
  try {
    const r = await callGateway(cfg, wl.body, { optimize });
    return {
      optimize,
      answer: r.answer,
      usage: normalizeUsage(r.usage),
      rawUsage: r.usage,
      strategies: r.strategies,
      // Carries the gateway's status/summary/suppressed reasons, so a
      // deliberate stand-down survives into the report as a reason.
      optimization: r.optimization ?? null,
      finishReason: r.finishReason,
      latencyMs: r.latencyMs,
    };
  } catch (e) {
    return { optimize, error: e.message, usage: normalizeUsage({}), answer: '' };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);

  const { workloads, problems } = loadWorkloads(args.dir, { only: args.only });
  for (const p of problems) console.error(`workload problem — ${p}`);
  if (!workloads.length) {
    console.error(
      `\nNo usable workloads in ${args.dir}/. Paste SETUP-PROMPT.md into your coding agent to capture some.`
    );
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(`${workloads.length} workload(s) valid:`);
    for (const w of workloads) console.log(`  ${w.id}  ${w.mustInclude.length} required fact(s)`);
    if (problems.length) process.exit(1);
    return;
  }

  const cfg = resolveConfig(loadEnv());
  if (args.repeats) cfg.repeats = args.repeats;
  const rates = loadRates();

  const calls = workloads.length * cfg.repeats * 2;
  console.log(
    `${workloads.length} workload(s) x ${cfg.repeats} run(s) x 2 arms = ${calls} calls to ${cfg.gatewayUrl} as ${cfg.model}. These are billed to you.\n`
  );

  // One id per run, stamped into both arms, so a previous run's provider cache
  // cannot flatter this one. See lib/workloads.mjs.
  const runId = newRunId();
  if (!args.noCacheIsolation) {
    console.log(
      `Cache isolation: this run stamps id ${runId} into every prompt, identically in both arms, so a previous run's provider cache cannot be mistaken for a saving. Disable with --no-cache-isolation.\n`
    );
  }

  const results = [];
  let firstCall = true;
  for (const rawWl of workloads) {
    const wl = args.noCacheIsolation ? rawWl : stampRunId(rawWl, runId);
    const bypassedRuns = [];
    const optimizedRuns = [];
    for (let i = 0; i < cfg.repeats; i++) {
      // Alternate which arm goes first. Whichever runs first pays to warm the
      // provider's prompt cache; alternating keeps that cost from landing on the
      // same arm every time and biasing the comparison.
      const order = i % 2 === 0 ? ['off', 'on'] : ['on', 'off'];
      for (const arm of order) {
        const run = await runOnce(cfg, wl, arm);
        // If the very first call fails, the config is wrong, not the workload.
        // Stop here rather than spending the customer's money discovering the
        // same failure another fifty times.
        if (firstCall && run.error) {
          throw new Error(
            `first call failed, so nothing was measured:\n  ${run.error}\n\n` +
              `Check ANYRAY_GATEWAY_URL (${cfg.gatewayUrl}) and ANYRAY_API_KEY in .env. ` +
              `A 401 or 402 usually means the key is not valid for this gateway — ` +
              `\`anyray-connect doctor --json\` reports which.`
          );
        }
        firstCall = false;
        (arm === 'off' ? bypassedRuns : optimizedRuns).push(run);
        if (run.error) console.error(`  ${wl.id} [anyray ${arm}] failed: ${run.error}`);
      }
    }
    // `body` rides along so judge.mjs can quote the question back to the judge
    // without re-reading workloads/ (which the customer may have moved on from).
    const res = { id: wl.id, title: wl.title, mustInclude: wl.mustInclude, body: wl.body, bypassedRuns, optimizedRuns };
    results.push(res);
    const summary = summarize({ results: [res], model: cfg.model, rates, repeats: cfg.repeats });
    console.log(renderRow(summary.rows[0]));
  }

  const summary = summarize({ results, model: cfg.model, rates, repeats: cfg.repeats });
  console.log(renderVerdicts(summary));

  writeFileSync(
    args.out,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        runId: args.noCacheIsolation ? null : runId,
        cacheIsolation: !args.noCacheIsolation,
        gatewayUrl: cfg.gatewayUrl,
        model: cfg.model,
        repeats: cfg.repeats,
        endpoint: cfg.endpoint,
        results,
        summary,
      },
      null,
      2
    ) + '\n'
  );
  console.log(
    `\nWrote ${args.out}. Run \`node report.mjs\` for the readable version, or ` +
      `\`node report.mjs --redact\` for a copy you can send on with the prompts and answers removed.`
  );

  // A lost fact is a failing proof, and CI should be able to see that.
  if (summary.quality.regressions.length) process.exit(2);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
