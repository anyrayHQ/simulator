#!/usr/bin/env node
// Session mode: whole agent sessions, not single requests.
//
// prove.mjs answers "does one request get cheaper?". A real harness asks a
// different question — "does my session get cheaper, and does it still solve
// the task?" — and the two can disagree: a trim that saves tokens on one call
// can break the prompt cache or send the agent back for what was removed, and
// the session ends up costing more. This runs the same task, in the same world,
// through each arm, several rounds, and compares what each session was billed.
//
// Arms (default when a direct arm is configured):
//   direct   straight to your provider, nothing of ours in the path
//   control  the same as direct, run again — the NOISE FLOOR. Two identical
//            arms still differ, because the agent takes a different path each
//            time; any Anyray result inside that spread is not a result.
//   anyray   through the gateway, optimizing, with Anyray's retrieval tools
//            registered the way an enrolled client has them
// Without a direct arm, `off` (gateway, optimization bypassed) is the baseline
// and `off2` the control.
//
//   node session.mjs                  # 3 rounds
//   node session.mjs --rounds 6
//   node session.mjs --arms direct,off,anyray
//   node session.mjs --no-cache       # a harness that sets no cache markers (plain SDK loop)
//   node session.mjs --no-retrieval   # anyray arm without the /mcp tools
//   node session.mjs --small          # ~5x smaller repository: fast, cheap screening runs
//   node session.mjs --task watch     # re-run the same log command until a fix lands:
//                                     # repeated, overlapping observations
//   node session.mjs --thinking 2048 # extended thinking; each turn's thinking is
//                                     # resent with the transcript, which is what
//                                     # thinking_replay_trim acts on
//   node session.mjs --thinking adaptive:high
//                                     # adaptive thinking (Sonnet 5 and newer accept
//                                     # only this), with an optional effort
//   node session.mjs --followups 3    # after each answer, ask another question on the
//                                     # same transcript: a multi-prompt session, so
//                                     # earlier turns (and their thinking) become past
//   node session.mjs --followups 3 --pause 330
//                                     # a pause between prompts; past the provider's
//                                     # 5-minute cache TTL the transcript is billed
//                                     # again in full, as for a person who stepped away
//   node session.mjs --arms direct,control,anyray:cache_optimizer,anyray:none
//                                     # one arm per experiment; what each runs is
//                                     # set by an optimizer rule matching
//                                     # metadata.experiment (see README)

import { writeFileSync } from 'node:fs';
import { loadEnv, resolveConfig } from './lib/env.mjs';
import { loadRates, costOf, fmtUSD, rateFor } from './lib/rates.mjs';
import { buildWorld, REQUIRED } from './lib/world.mjs';
import { watchScenario } from './lib/watch.mjs';
import { runSession, gatewaySender, directSender, retrievalTools } from './lib/agent.mjs';
import { newRunId } from './lib/workloads.mjs';

/** `2048` (a budget), `adaptive`, or `adaptive:<effort>`. */
export function parseThinking(v) {
  const m = /^adaptive(?::(low|medium|high|max))?$/.exec(String(v));
  if (m) return { effort: m[1] ?? null };
  const n = Number(v);
  if (!(Number.isInteger(n) && n >= 1024)) throw new Error('--thinking takes a token budget of at least 1024, adaptive, or adaptive:<low|medium|high|max>');
  return n;
}

function parseArgs(argv) {
  const a = { rounds: 3, cache: true, retrieval: true, out: 'session-results.json', seed: 7 };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--rounds') a.rounds = Number(argv[++i]);
    else if (f === '--arms') a.arms = argv[++i].split(',').map((s) => s.trim());
    else if (f === '--max-turns') a.maxTurns = Number(argv[++i]);
    else if (f === '--seed') a.seed = Number(argv[++i]);
    else if (f === '--out') a.out = argv[++i];
    else if (f === '--no-cache') a.cache = false;
    else if (f === '--no-retrieval') a.retrieval = false;
    else if (f === '--small') a.small = true;
    else if (f === '--task') a.task = argv[++i];
    else if (f === '--thinking') a.thinking = parseThinking(argv[++i]);
    else if (f === '--followups') a.followups = Number(argv[++i]);
    else if (f === '--pause') a.pause = Number(argv[++i]);
    else throw new Error(`unknown flag ${f}`);
  }
  if (!Number.isInteger(a.rounds) || a.rounds < 1) throw new Error('--rounds must be a positive integer');
  if (a.pause != null && !(a.pause >= 0)) throw new Error('--pause takes seconds');
  if (a.followups != null && !(Number.isInteger(a.followups) && a.followups >= 0)) throw new Error('--followups must be a whole number');
  return a;
}

const quantile = (xs, q) => {
  const s = [...xs].sort((x, y) => x - y);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.ceil(pos)] - s[lo]) * (pos - lo);
};

/**
 * Paired comparison of arm `a` against arm `b`, round by round. `b` may be an
 * array of arms, compared against their per-round geometric mean: with one
 * direct arm as the baseline, a single cheap direct session makes EVERY other
 * arm look dear that round (observed: the control, identical to direct, came
 * out at a median 1.35x). Pooling direct and control halves that.
 */
export function compare(rounds, a, b) {
  const bs = [].concat(b);
  const baseOf = (r) => Math.exp(bs.reduce((acc, k) => acc + Math.log(r[k].cost), 0) / bs.length);
  const ratios = rounds
    .filter((r) => r[a]?.cost > 0 && bs.every((k) => r[k]?.cost > 0))
    .map((r) => r[a].cost / baseOf(r));
  const n = ratios.length;
  const wins = ratios.filter((x) => x < 1).length;
  return { a, b: bs.join('+'), n, wins, ratios, median: quantile(ratios, 0.5), q3: quantile(ratios, 0.75), min: Math.min(...ratios), max: Math.max(...ratios) };
}

/**
 * The bar a result has to clear. Cheaper in most rounds AND cheaper at the
 * upper quartile — a median alone can be one lucky round.
 */
export function verdict(c, noise, quality) {
  if (c.n < 3) return 'too few rounds to call';
  // Cheaper and worse is not a saving. An arm that solves fewer tasks than the
  // baseline is reported as broken whatever it cost: observed live, a strategy
  // that pruned every tool but `finish` came out 92% "cheaper" and 0/10 solved.
  if (quality && quality.solved < quality.baselineSolved) {
    return `WORSE: solved ${quality.solved}/${quality.n} vs ${quality.baselineSolved}/${quality.n} baseline`;
  }
  const rate = c.wins / c.n;
  if (rate > 0.7 && c.q3 < 1) return 'cheaper, beyond noise';
  if (c.median > 1.2 && rate < 0.4 && !(noise && c.median <= noise.max)) return 'costs more';
  if (noise && c.min >= noise.min && c.max <= noise.max) return 'inside the noise band';
  if (c.median > 1.2 && rate < 0.4) return 'dearer, but within the control\'s spread';
  return 'not separable from noise';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = resolveConfig(loadEnv());
  const rates = loadRates();
  const maxTurns = args.maxTurns ?? Number(process.env.SESSION_MAX_TURNS ?? 30);
  const arms = args.arms ?? (cfg.direct ? ['direct', 'control', 'anyray'] : ['off', 'off2', 'anyray']);
  const baseline = arms[0];

  let retrieval = null;
  if (args.retrieval && arms.some((a) => a.startsWith('anyray'))) {
    retrieval = await retrievalTools(cfg).catch((e) => {
      console.error(`  ! could not load Anyray's retrieval tools from ${cfg.gatewayUrl}/mcp (${e.message}); the anyray arm runs without them.`);
      return null;
    });
  }

  const senderFor = (arm) => {
    if (arm === 'direct' || arm === 'control') {
      if (!cfg.direct) throw new Error(`arm "${arm}" needs a direct arm: set DIRECT_BASE_URL in .env`);
      return directSender(cfg);
    }
    if (arm === 'off' || arm === 'off2') return gatewaySender(cfg, { optimize: 'off' });
    if (arm === 'anyray') return gatewaySender(cfg, { optimize: 'on' });
    // `anyray:<name>` tags the requests with experiment=<name>; an optimizer
    // rule on the gateway decides what that experiment runs.
    if (arm.startsWith('anyray:')) return gatewaySender(cfg, { optimize: 'on', experiment: arm.slice(7) });
    throw new Error(`unknown arm ${arm}`);
  };

  const files = buildWorld(args.seed, { small: args.small });
  if (args.task && args.task !== 'incident' && args.task !== 'watch') throw new Error(`unknown --task ${args.task} (incident | watch)`);
  const scenario = args.task === 'watch' ? watchScenario(args.seed) : null;
  const runId = newRunId();
  const rate = rateFor(rates, cfg.model);
  console.log(
    `Session mode: ${args.rounds} round(s) x ${arms.length} arms (${arms.join(', ')}) as ${cfg.model}, up to ${maxTurns} turns each.\n` +
      `Cache markers: ${args.cache ? 'on, placed like Claude Code' : 'off (plain SDK loop)'}. ` +
      `Thinking: ${!args.thinking ? 'off' : typeof args.thinking === 'number' ? `${args.thinking} token budget` : `adaptive${args.thinking.effort ? `, ${args.thinking.effort} effort` : ''}`}. ` +
      `Prompts per session: ${1 + (args.followups ?? 0)}${args.pause ? `, ${args.pause}s apart` : ''}. ` +
      `Retrieval tools on the anyray arm: ${retrieval ? retrieval.tools.map((t) => t.name).join(', ') : 'none'}.\n` +
      `${args.rounds * arms.length} sessions, billed to you${rate ? '' : ' (no published rate for this model, so tokens only)'}. ` +
      `Each round prints its cost and is saved as it finishes, so Ctrl-C loses nothing already paid for.\n`
  );

  const startedAt = new Date().toISOString();
  const rounds = [];
  for (let r = 1; r <= args.rounds; r++) {
    // All arms of a round run at once, so time-of-day and provider load hit
    // them alike.
    const results = await Promise.all(
      arms.map(async (arm) => {
        try {
          const s = await runSession({
            send: senderFor(arm),
            files,
            scenario,
            stamp: `${runId}-${r}-${arm}`,
            maxTurns,
            cache: args.cache,
            thinking: args.thinking ?? 0,
            followups: args.followups ?? 0,
            pauseMs: (args.pause ?? 0) * 1000,
            extraTools: arm.startsWith('anyray') && retrieval ? retrieval.tools : [],
            callExtra: retrieval?.call,
          });
          return [arm, { ...s, cost: costOf(rates, cfg.model, s.usage, { includeOutput: true }) }];
        } catch (e) {
          return [arm, { error: e.message }];
        }
      })
    );
    const round = { round: r, ...Object.fromEntries(results) };
    rounds.push(round);
    const cells = arms.map((arm) => {
      const s = round[arm];
      if (s.error) return `${arm}: FAILED (${s.error.slice(0, 120)})`;
      return `${arm}: ${s.cost != null ? fmtUSD(s.cost) : s.usage.billedInput.toLocaleString() + ' tok'} ${s.turns}t ${s.solved ? 'solved' : `NOT solved (missing ${s.missing.join(', ')})`}`;
    });
    console.log(`round ${r}  ${cells.join('   ')}`);
    writeFileSync(args.out, JSON.stringify({ runId, startedAt, model: cfg.model, arms, cache: args.cache, thinking: args.thinking ?? 0, followups: args.followups ?? 0, pause: args.pause ?? 0, retrieval: Boolean(retrieval), seed: args.seed, small: Boolean(args.small), maxTurns, task: scenario?.name ?? 'incident', required: scenario?.required ?? REQUIRED, rounds }, null, 2));
  }

  // ---------- summary ----------
  const done = (arm) => rounds.map((r) => r[arm]).filter((s) => s && !s.error);
  const med = (arm, f) => quantile(done(arm).map(f), 0.5);
  console.log('\nPER ARM (medians over rounds)');
  for (const arm of arms) {
    const d = done(arm);
    if (!d.length) {
      console.log(`  ${arm.padEnd(28)} no completed sessions`);
      continue;
    }
    const u = (f) => Math.round(med(arm, (s) => s.usage[f])).toLocaleString();
    console.log(
      `  ${arm.padEnd(28)} cost ${fmtUSD(med(arm, (s) => s.cost ?? 0)) ?? '—'}  turns ${med(arm, (s) => s.turns)}  ` +
        `input: uncached ${u('uncachedInput')} · cache write ${u('cacheWrite')} · cache read ${u('cacheRead')}  output ${u('output')}  ` +
        `solved ${d.filter((s) => s.solved).length}/${d.length}`
    );
  }

  const hasControl = arms.length > 1 && (arms[1] === 'control' || arms[1] === 'off2');
  const noise = hasControl ? compare(rounds, arms[1], baseline) : null;
  // Treatment arms are judged against direct AND control pooled, not direct alone.
  const pooled = hasControl ? [baseline, arms[1]] : baseline;
  console.log(`\nCOST RATIO (per round; below 1 = cheaper). Control vs ${baseline}; every other arm vs ${hasControl ? `${baseline}+${arms[1]} pooled` : baseline}`);
  const line = (c) =>
    `  ${c.a.padEnd(28)} ${c.ratios.map((x) => x.toFixed(2) + '×').join('  ')}   median ${c.median?.toFixed(2)}×  wins ${c.wins}/${c.n}  Q3 ${c.q3?.toFixed(2)}×`;
  if (noise?.n) console.log(line(noise) + '   ← identical arms: this spread is noise');
  for (const arm of arms.slice(1)) {
    if (arm === arms[1] && noise) continue;
    const c = compare(rounds, arm, pooled);
    if (!c.n) continue;
    const solvedIn = (a) => done(a).filter((s) => s.solved).length / Math.max(1, done(a).length);
    const n = done(arm).length;
    const quality = {
      n,
      solved: done(arm).filter((s) => s.solved).length,
      // Scaled to this arm's session count, from the baseline arms' solve rate.
      baselineSolved: Math.floor(n * Math.min(...[].concat(pooled).map(solvedIn))),
    };
    console.log(line(c) + `   → ${verdict(c, noise?.n ? noise : null, quality)}`);
  }
  if (rounds.length < 6) {
    console.log(`\nWith ${rounds.length} round(s) this is indicative only. Sessions vary a lot run to run; 6+ rounds before calling anything.`);
  }
  console.log(`\nWrote ${args.out}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
