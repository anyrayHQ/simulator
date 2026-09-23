#!/usr/bin/env node
// The one command.
//
// Sends each of your prompts twice to YOUR provider with YOUR key: once as you
// wrote it, once after the local Anyray container has trimmed it. Then it
// answers both questions — does it cost less, and are the answers still right?
//
//   node prove.mjs                      every workload in workloads/
//   node prove.mjs --workload 04-...    just one (the smoke test)
//   node prove.mjs --repeats 1          a smoke test, not a proof
//   node prove.mjs --dry-run            validate workloads, call nothing
//   node prove.mjs --no-optimizer       baseline only; proves the plumbing
//
// Nothing here talks to Anyray. The optimizer runs on localhost; the only
// request that leaves this machine is the one to your own provider.
//
// Writes results.json (gitignored — it holds your prompts and both answers).

import { writeFileSync } from 'node:fs';
import { loadEnv, resolveConfig } from './lib/env.mjs';
import { loadWorkloads } from './lib/workloads.mjs';
import { callProvider } from './lib/provider.mjs';
import { Optimizer } from './lib/optimizer.mjs';
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
    else if (f === '--no-optimizer') a.noOptimizer = true;
    else if (f === '--dir') a.dir = argv[++i];
    else if (f === '--out') a.out = argv[++i];
    else if (f === '--help' || f === '-h') a.help = true;
  }
  return a;
}

const USAGE = `node prove.mjs [--workload <id>] [--repeats <n>] [--dry-run] [--no-optimizer]`;

/** One call. Failures are recorded, not thrown: one 400 on one workload should
 *  not throw away the rest of a run you are paying for. */
async function runOnce(cfg, body, arm) {
  try {
    const r = await callProvider(cfg, body);
    return {
      arm,
      answer: r.answer,
      usage: normalizeUsage(r.usage),
      rawUsage: r.usage,
      finishReason: r.finishReason,
      latencyMs: r.latencyMs,
    };
  } catch (e) {
    return { arm, error: e.message, usage: normalizeUsage({}), answer: '' };
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

  // Wait for the container before spending anything. A cold optimizer answers
  // normally and measures a different pipeline — see lib/optimizer.mjs.
  const opt = new Optimizer({ url: cfg.optimizerUrl, timeoutMs: cfg.timeoutMs });
  let provenance = { optimizerVersion: null, defaultsRevision: null, embedder: null };
  if (!args.noOptimizer) {
    try {
      await opt.waitUntilReady({
        timeoutMs: cfg.readyTimeoutMs,
        onWait: () =>
          console.log(
            `Waiting for the optimizer at ${cfg.optimizerUrl} to finish loading its embedding model.\n` +
              `Measuring before it is resident would measure a different pipeline, so this waits rather than guessing.\n`
          ),
      });
    } catch (e) {
      console.error(`${e.message}\n`);
      console.error(`Is the container up?  docker compose up -d`);
      process.exit(1);
    }
    provenance = await opt.provenance();
  }

  const calls = workloads.length * cfg.repeats * (args.noOptimizer ? 1 : 2);
  console.log(
    `${workloads.length} workload(s) x ${cfg.repeats} run(s) x ${args.noOptimizer ? 1 : 2} arm(s) = ${calls} calls ` +
      `to ${cfg.providerUrl} as ${cfg.model}. These are billed to you by your provider.`
  );
  console.log(
    `Anyray is not in this path: the optimizer runs at ${cfg.optimizerUrl} on this machine, and no prompt is sent to us.\n`
  );

  const results = [];
  let firstCall = true;
  for (const wl of workloads) {
    const baselineRuns = [];
    const optimizedRuns = [];
    let strategies = [];
    for (let i = 0; i < cfg.repeats; i++) {
      // Alternate which arm goes first. Whichever runs first pays to warm the
      // provider's prompt cache; alternating keeps that cost from landing on
      // the same arm every time and biasing the comparison.
      const order = i % 2 === 0 ? ['baseline', 'optimized'] : ['optimized', 'baseline'];
      for (const arm of order) {
        if (arm === 'optimized' && args.noOptimizer) continue;

        let body = wl.body;
        if (arm === 'optimized') {
          try {
            const t = await opt.optimize(wl.body, { endpoint: cfg.endpoint });
            body = t.request;
            strategies = [...new Set([...strategies, ...t.strategies])];
          } catch (e) {
            optimizedRuns.push({ arm, error: `optimizer: ${e.message}`, usage: normalizeUsage({}), answer: '' });
            console.error(`  ${wl.id} [optimize] failed: ${e.message}`);
            continue;
          }
        }

        const run = await runOnce(cfg, body, arm);
        // If the very first call fails, the config is wrong, not the workload.
        // Stop rather than spending the customer's money discovering it again.
        if (firstCall && run.error) {
          throw new Error(
            `first call failed, so nothing was measured:\n  ${run.error}\n\n` +
              `Check PROVIDER_BASE_URL (${cfg.providerUrl}) and PROVIDER_API_KEY in .env. ` +
              `A 401 usually means the key is wrong for this provider, or the dialect is — ` +
              `this run used "${cfg.dialect}" auth against ${cfg.endpoint}. Override with PROVIDER_DIALECT.`
          );
        }
        firstCall = false;
        (arm === 'baseline' ? baselineRuns : optimizedRuns).push(run);
        if (run.error) console.error(`  ${wl.id} [${arm}] failed: ${run.error}`);
      }
    }
    // `body` rides along so judge.mjs can quote the question back to the judge.
    const res = {
      id: wl.id,
      title: wl.title,
      mustInclude: wl.mustInclude,
      body: wl.body,
      strategies,
      bypassedRuns: baselineRuns,
      optimizedRuns,
    };
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
        providerUrl: cfg.providerUrl,
        optimizerUrl: args.noOptimizer ? null : cfg.optimizerUrl,
        model: cfg.model,
        dialect: cfg.dialect,
        endpoint: cfg.endpoint,
        repeats: cfg.repeats,
        provenance,
        results,
        summary,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`\nWrote ${args.out}. Run \`node report.mjs\` for the readable version.`);

  // A lost fact is a failing proof, and CI should be able to see that.
  if (summary.quality.regressions.length) process.exit(2);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
