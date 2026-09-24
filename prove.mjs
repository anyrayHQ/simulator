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

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { loadEnv, resolveConfig } from './lib/env.mjs';
import { loadWorkloads, stampRunId, newRunId } from './lib/workloads.mjs';
import { callGateway, callDirect } from './lib/gateway.mjs';
import { normalizeUsage } from './lib/usage.mjs';
import { loadRates } from './lib/rates.mjs';
import { summarize, renderRow, renderVerdicts } from './lib/verdict.mjs';
import { renderReport } from './report.mjs';
import { costOf, fmtUSD } from './lib/rates.mjs';

function parseArgs(argv) {
  const a = { only: null, repeats: null, dryRun: false, dir: 'workloads', out: 'results.json' };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--workload') a.only = argv[++i];
    else if (f === '--repeats') a.repeats = Number(argv[++i]);
    else if (f === '--dry-run') a.dryRun = true;
    else if (f === '--examples') a.examples = true;
    else if (f === '--fresh') a.fresh = true;
    else if (f === '--no-report') a.noReport = true;
    else if (f === '--no-cache-isolation') a.noCacheIsolation = true;
    else if (f === '--dir') a.dir = argv[++i];
    else if (f === '--out') a.out = argv[++i];
    else if (f === '--help' || f === '-h') a.help = true;
  }
  return a;
}

const USAGE = `node prove.mjs [--workload <id>] [--repeats <n>] [--dry-run] [--examples] [--fresh] [--no-report] [--dir workloads]`;

/**
 * Pick up an INTERRUPTED run rather than re-buying what it already paid for.
 *
 * Only an interrupted one: a file marked complete means the last run finished,
 * and someone re-running then wants fresh numbers, not "nothing to do". And
 * only when the run is comparable — a different gateway, model or repeat count
 * would splice two incompatible halves into one verdict, which is worse than
 * spending the money again.
 */
function resumable(out, cfg, fresh) {
  if (fresh || !existsSync(out)) return null;
  let prior;
  try {
    prior = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    return null;
  }
  if (prior.complete !== false || !Array.isArray(prior.results) || !prior.results.length) return null;
  const mismatch = [
    prior.gatewayUrl !== cfg.gatewayUrl && 'gateway',
    prior.model !== cfg.model && 'model',
    prior.repeats !== cfg.repeats && 'repeats',
  ].filter(Boolean);
  if (mismatch.length) {
    console.log(
      `${out} holds an unfinished run with a different ${mismatch.join(' and ')}. Starting fresh rather than mixing two runs into one verdict.\n`
    );
    return null;
  }
  return prior;
}

/**
 * Name the ACTUAL problem on the first failed call.
 *
 * This is the first command a new user runs, and a wrong guess sends them to
 * check a credential that was never the issue. Caught by following the README's
 * own quick start from a clean clone: the shipped PROOF_MODEL was not a model
 * that gateway serves, and the hint said "a 401 or 402 usually means the key is
 * not valid" underneath a 404 about the model.
 */
export function firstCallHint(error, cfg) {
  const msg = String(error);
  // Gateways disagree about how to say "I don't serve that model": observed
  // 404 "The model `x` does not exist" on one upstream and 400 "The provided
  // model identifier is invalid" on another, from the SAME gateway. Match on
  // what the message says, not on the status code.
  if (/model identifier is invalid|does not exist|model.*not (found|supported)|unknown model|invalid model/i.test(msg)) {
    return (
      `PROOF_MODEL is "${cfg.model}", and this gateway does not serve it.\n` +
      `Set PROOF_MODEL in .env to a model your deployment actually routes — the one your app already sends is the right choice, ` +
      `since the dollar figure depends on its rate. Your Anyray console lists what this gateway serves.`
    );
  }
  if (/\b401\b|\b403\b/.test(msg)) {
    return (
      `That is an auth failure: ANYRAY_API_KEY is not valid for ${cfg.gatewayUrl}, or it was minted for a different deployment.\n` +
      `\`anyray-connect doctor --json\` reports which. Use a client key (ark_...), not an admin token.`
    );
  }
  if (/\b402\b/.test(msg)) {
    return `That is 402 Payment Required: the deployment holds no entitlement lease, so it will not serve /v1/* at all. Nothing in .env fixes that — talk to whoever runs the gateway.`;
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)) {
    return `Nothing answered at ANYRAY_GATEWAY_URL (${cfg.gatewayUrl}). Check the host, and that you can reach it from here.`;
  }
  return `Check ANYRAY_GATEWAY_URL (${cfg.gatewayUrl}) and ANYRAY_API_KEY in .env.`;
}

/** One arm of one repeat. Failures are recorded, not thrown: one 400 on one
 *  workload should not throw away the rest of a run you are paying for. */
async function runOnce(cfg, wl, optimize) {
  try {
    // 'direct' is not a gateway mode — it is a different destination. Routing
    // it through callGateway would send an unrecognised optimize value, which
    // means no bypass header, which means the "direct" arm silently measures an
    // OPTIMIZED call. That is the ambient-routing defect the lab warns about,
    // arriving through a typo instead of an env var.
    const r =
      optimize === 'direct'
        ? await callDirect(cfg.direct, wl.body, { maxTokens: cfg.maxTokens, timeoutMs: cfg.timeoutMs })
        : await callGateway(cfg, wl.body, { optimize });
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

/**
 * Write results after every workload, not once at the end.
 *
 * Each workload is 2 x repeats of real, billed provider calls. Writing only on
 * success meant a crash on workload 9 of 10 discarded the eight already paid
 * for — and the likeliest crash is a provider hiccup partway through a long
 * run, which is exactly when you least want to start over.
 */
function writeResults(out, cfg, runId, args, results, rates) {
  const summary = summarize({ results, model: cfg.model, rates, repeats: cfg.repeats });
  writeFileSync(
    out,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        runId: args.noCacheIsolation ? null : runId,
        cacheIsolation: !args.noCacheIsolation,
        gatewayUrl: cfg.gatewayUrl,
        model: cfg.model,
        repeats: cfg.repeats,
        endpoint: cfg.endpoint,
        complete: results.length === args.totalWorkloads,
        results,
        summary,
      },
      null,
      2
    ) + '\n'
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);

  const { workloads, problems, examplesSkipped } = loadWorkloads(args.dir, {
    only: args.only,
    examples: args.examples,
  });
  for (const p of problems) console.error(`workload problem — ${p}`);
  if (!workloads.length) {
    console.error(
      `\nNo usable workloads in ${args.dir}/. Paste SETUP-PROMPT.md into your coding agent to capture some.`
    );
    process.exit(1);
  }

  if (examplesSkipped) {
    console.log(
      `Running your ${workloads.length} captured workload(s). The ${examplesSkipped} shipped example(s) are skipped now that you have your own — they are our fixtures, and you would be paying for them. Use --examples to include them.\n`
    );
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

  // Resume before choosing a run id: a resumed run keeps the original, so every
  // workload in one results file shares one cache-isolation prefix.
  const prior = args.only ? null : resumable(args.out, cfg, args.fresh);
  const runId = prior?.runId ?? newRunId();
  const results = prior ? [...prior.results] : [];
  const done = new Set(results.map((r) => r.id));
  if (prior) {
    console.log(
      `Resuming an interrupted run: ${done.size} workload(s) already measured and paid for are kept. Use --fresh to start over.\n`
    );
  }
  if (!args.noCacheIsolation) {
    console.log(
      `Cache isolation: this run stamps id ${runId} into every prompt, identically in both arms, so a previous run's provider cache cannot be mistaken for a saving. Disable with --no-cache-isolation.\n`
    );
  }

  args.totalWorkloads = workloads.length;
  let firstCall = results.length > 0 ? false : true;
  // Quote only what this invocation will actually buy — on a resume the
  // already-paid workloads are not part of the bill, and including them would
  // over-quote by exactly the amount the resume just saved.
  const todo = workloads.filter((w) => !done.has(w.id));
  const calls = todo.length * cfg.repeats * 2;
  // A call count is not a number anyone can say yes or no to. Estimate from the
  // workloads themselves — chars/4, rough, and deliberately rough UPWARDS by
  // assuming no saving at all. Better to over-quote than to surprise someone.
  const estInputTokens = todo.reduce((a, w) => a + Math.round(JSON.stringify(w.body).length / 4), 0);
  const est = costOf(
    rates,
    cfg.model,
    {
      uncachedInput: estInputTokens * cfg.repeats * 2,
      cacheWrite: 0,
      cacheRead: 0,
      output: todo.length * cfg.repeats * 2 * cfg.maxTokens,
    },
    { includeOutput: true }
  );
  console.log(
    `${todo.length} workload(s) x ${cfg.repeats} run(s) x 2 arms = ${calls} calls to ${cfg.gatewayUrl} as ${cfg.model}.\n` +
      (est != null
        ? `Rough ceiling at list price: ${fmtUSD(est)} — assumes no saving and every answer running to PROOF_MAX_TOKENS, so the real bill should come in under it. Billed to you, not to us.\n`
        : `No published rate for ${cfg.model}, so this cannot estimate the spend. Billed to you, not to us.\n`)
  );

  const showProgress = Boolean(process.stdout.isTTY) && workloads.length > 1;
  let index = 0;
  for (const rawWl of workloads) {
    index++;
    if (done.has(rawWl.id)) continue;
    // A ten-workload run is minutes of silence between rows otherwise.
    // TTY only: a carriage return does not overwrite anything when stdout is a
    // pipe or a file, so in CI logs and captured output it would leave the
    // progress line sitting in front of the result row instead of clearing it.
    if (showProgress) {
      process.stdout.write(`  … ${rawWl.id} (${index}/${workloads.length})\r`);
    }
    const wl = args.noCacheIsolation ? rawWl : stampRunId(rawWl, runId);
    const bypassedRuns = [];
    const optimizedRuns = [];
    const directRuns = [];
    for (let i = 0; i < cfg.repeats; i++) {
      // Alternate which arm goes first. Whichever runs first pays to warm the
      // provider's prompt cache; alternating keeps that cost from landing on the
      // same arm every time and biasing the comparison.
      const order = i % 2 === 0 ? ['off', 'on'] : ['on', 'off'];
      // The direct arm, when configured, runs alongside — not instead of — the
      // bypassed one. Its whole job is to be COMPARED to the bypassed arm, so
      // dropping either would defeat the point.
      if (cfg.direct) order.push('direct');
      for (const arm of order) {
        const run = await runOnce(cfg, wl, arm);
        // If the very first call fails, the config is wrong, not the workload.
        // Stop here rather than spending the customer's money discovering the
        // same failure another fifty times.
        if (firstCall && run.error) {
          throw new Error(
            `first call failed, so nothing was measured:\n  ${run.error}\n\n${firstCallHint(run.error, cfg)}`
          );
        }
        firstCall = false;
        if (arm === 'direct') directRuns.push(run);
        else (arm === 'off' ? bypassedRuns : optimizedRuns).push(run);
        if (run.error) console.error(`  ${wl.id} [anyray ${arm}] failed: ${run.error}`);
      }
    }
    // `body` rides along so judge.mjs can quote the question back to the judge
    // without re-reading workloads/ (which the customer may have moved on from).
    const res = { id: wl.id, title: wl.title, mustInclude: wl.mustInclude, body: wl.body, bypassedRuns, optimizedRuns, directRuns };
    results.push(res);
    const summary = summarize({ results: [res], model: cfg.model, rates, repeats: cfg.repeats });
    if (showProgress) process.stdout.write('\r' + ' '.repeat(72) + '\r');
    console.log(renderRow(summary.rows[0]));

    // Write after EVERY workload. These calls cost real money, and a crash on
    // workload 9 of 10 used to throw away the eight already paid for.
    writeResults(args.out, cfg, runId, args, results, rates);
  }

  const summary = summarize({ results, model: cfg.model, rates, repeats: cfg.repeats });
  console.log(renderVerdicts(summary));
  writeResults(args.out, cfg, runId, args, results, rates);
  // Write the readable report too. It was a separate command nobody was told
  // to run until after the fact, which meant the artifact most worth looking at
  // was the one most likely never generated.
  if (!args.noReport) {
    // Sit the report beside the results file it came from, whatever that was
    // named — not in the working directory, which is where a --out somewhere
    // else used to strand it.
    const finalPath =
      args.out === 'results.json' ? 'report.html' : args.out.replace(/\.json$/i, '') + '.report.html';
    writeFileSync(finalPath, renderReport(JSON.parse(readFileSync(args.out, 'utf8'))));
    console.log(`\nWrote ${args.out} and ${finalPath} — open that one.`);
    console.log(
      `For a copy you can send on, with the prompts and answers stripped out: node report.mjs --redact`
    );
  } else {
    console.log(`\nWrote ${args.out}.`);
  }

  // A lost fact is a failing proof, and CI should be able to see that.
  if (summary.quality.regressions.length) process.exit(2);
}

// Only run when invoked directly. judge.mjs and report.mjs already guard this;
// prove.mjs did not, so importing it to unit-test a helper started a real proof
// run against whatever .env happened to be present — 18 billed calls from a
// test file. Found when a test imported firstCallHint.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
