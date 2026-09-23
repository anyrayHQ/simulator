// Turn the raw runs into the two verdicts, and into the lines printed for them.

import { savedPct, sumUsage } from './usage.mjs';
import { compareArms } from './facts.mjs';
import { costOf, fmtUSD } from './rates.mjs';

const n = (v) => Number(v).toLocaleString('en-US');

/** Per-arm token totals for one workload, averaged over that arm's repeats. */
function armTotals(runs) {
  const ok = runs.filter((r) => !r.error);
  if (!ok.length) return null;
  const total = sumUsage(ok.map((r) => r.usage));
  const div = (x) => Math.round(x / ok.length);
  return {
    runs: ok.length,
    uncachedInput: div(total.uncachedInput),
    cacheWrite: div(total.cacheWrite),
    cacheRead: div(total.cacheRead),
    billedInput: div(total.billedInput),
    output: div(total.output),
  };
}

/**
 * Identical bytes give an identical input-token count, so two repeats of one arm
 * disagreeing means something varied that should not have: a moving system
 * prompt, a gateway that is not deterministic, someone else's traffic sharing
 * the cache. Worth saying out loud rather than averaging away.
 */
function inconsistentInput(runs) {
  const counts = [...new Set(runs.filter((r) => !r.error).map((r) => r.usage.billedInput))];
  return counts.length > 1 ? counts : null;
}

export function summarize({ results, model, rates, repeats }) {
  const rows = results.map((res) => {
    const bypassed = armTotals(res.bypassedRuns);
    const optimized = armTotals(res.optimizedRuns);
    const facts = compareArms({
      bypassedRuns: res.bypassedRuns.filter((r) => !r.error),
      optimizedRuns: res.optimizedRuns.filter((r) => !r.error),
      mustInclude: res.mustInclude,
    });
    const errors = [...res.bypassedRuns, ...res.optimizedRuns].filter((r) => r.error);
    return {
      id: res.id,
      title: res.title ?? null,
      bypassed,
      optimized,
      savedPct: bypassed && optimized ? savedPct(bypassed.billedInput, optimized.billedInput) : null,
      facts,
      strategies: [...new Set(res.optimizedRuns.flatMap((r) => r.strategies ?? []))],
      inconsistent: {
        bypassed: inconsistentInput(res.bypassedRuns),
        optimized: inconsistentInput(res.optimizedRuns),
      },
      errors: errors.map((e) => e.error),
      answers: {
        bypassed: res.bypassedRuns.find((r) => !r.error)?.answer ?? null,
        optimized: res.optimizedRuns.find((r) => !r.error)?.answer ?? null,
      },
    };
  });

  const measured = rows.filter((r) => r.bypassed && r.optimized);
  const totalBefore = measured.reduce((a, r) => a + r.bypassed.billedInput, 0);
  const totalAfter = measured.reduce((a, r) => a + r.optimized.billedInput, 0);
  const usageOf = (arm) =>
    measured.reduce(
      (a, r) => ({
        uncachedInput: a.uncachedInput + r[arm].uncachedInput,
        cacheWrite: a.cacheWrite + r[arm].cacheWrite,
        cacheRead: a.cacheRead + r[arm].cacheRead,
        billedInput: a.billedInput + r[arm].billedInput,
        output: a.output + r[arm].output,
      }),
      { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, billedInput: 0, output: 0 }
    );

  const checked = rows.filter((r) => r.facts.total > 0 && !r.facts.inconclusive && r.bypassed && r.optimized);
  const regressions = rows.filter((r) => r.facts.regression);
  const inconclusive = rows.filter((r) => r.facts.inconclusive && r.bypassed && r.optimized);
  const cacheSeen = measured.some((r) => r.bypassed.cacheRead > 0 || r.optimized.cacheRead > 0);

  return {
    model,
    repeats,
    rows,
    cost: {
      before: totalBefore,
      after: totalAfter,
      savedPct: savedPct(totalBefore, totalAfter),
      beforeUSD: costOf(rates, model, usageOf('bypassed')),
      afterUSD: costOf(rates, model, usageOf('optimized')),
      priced: costOf(rates, model, usageOf('bypassed')) != null,
      cacheSeen,
    },
    quality: {
      checked: checked.length,
      clean: checked.length - regressions.length,
      regressions,
      inconclusive,
    },
    errors: rows.filter((r) => r.errors.length),
  };
}

/** The per-workload line. */
export function renderRow(r) {
  if (!r.bypassed || !r.optimized) {
    return `${r.id.padEnd(30)} ERROR ${r.errors[0] ?? 'no successful runs'}`;
  }
  const tokens = `${n(r.bypassed.billedInput)} → ${n(r.optimized.billedInput)}`.padEnd(22);
  const pct = `${r.savedPct}%`.padStart(4);
  const quality = r.facts.regression
    ? `LOST FACTS (${r.facts.optimizedKept}/${r.facts.total} vs ${r.facts.bypassedKept}/${r.facts.total})`
    : r.facts.inconclusive
      ? `inconclusive ${r.facts.optimizedKept}/${r.facts.total} (baseline missed them too)`
      : `facts kept ${r.facts.optimizedKept}/${r.facts.total}`;
  const lines = [`${r.id.padEnd(30)} ${tokens} ${pct}  ${quality}`];
  if (r.facts.regression) {
    lines.push(`  ! only missing with Anyray on: ${r.facts.lost.join(', ')}`);
  }
  if (r.facts.inconclusive && !r.facts.regression && r.facts.missingBoth.length) {
    lines.push(`  · missing from BOTH answers, so not counted: ${r.facts.missingBoth.join(', ')}`);
  }
  for (const arm of ['bypassed', 'optimized']) {
    if (r.inconsistent[arm]) {
      lines.push(
        `  ! ${arm} repeats disagree on input tokens (${r.inconsistent[arm].join(', ')}) — identical bytes should give an identical count`
      );
    }
  }
  return lines.join('\n');
}

/** The two verdicts. */
export function renderVerdicts(s) {
  const out = [];
  out.push('');
  out.push('1 — COST');
  if (!s.rows.some((r) => r.bypassed && r.optimized)) {
    out.push('  no workload completed both arms — nothing measured');
  } else {
    out.push(
      `  input tokens   ${n(s.cost.before)} → ${n(s.cost.after)}   ${s.cost.savedPct}% lower`
    );
    if (s.cost.priced) {
      out.push(
        `  at list price  ${fmtUSD(s.cost.beforeUSD)} → ${fmtUSD(s.cost.afterUSD)}   (${s.model}, rates.json)`
      );
    } else {
      out.push(`  at list price  no published rate for ${s.model} in rates.json — tokens only`);
    }
    if (s.cost.cacheSeen) {
      out.push(
        '  note: the provider reported cached input. Cached tokens are counted in full above, so a cache hit cannot show up as a saving.'
      );
    }
  }
  out.push('');
  out.push('2 — QUALITY');
  if (s.quality.regressions.length) {
    out.push(
      `  ${s.quality.regressions.length} of ${s.quality.checked} checked workloads LOST a required fact with Anyray on:`
    );
    for (const r of s.quality.regressions) {
      out.push(`    ${r.id}: ${r.facts.lost.join(', ')}`);
    }
  } else if (s.quality.checked === 0) {
    out.push('  nothing conclusive to report — no workload kept all its facts without Anyray either');
  } else {
    out.push(
      `  every required fact survived, in all ${s.repeats} runs, on ${s.quality.clean} of ${s.quality.checked} checked workloads`
    );
  }
  if (s.quality.inconclusive.length) {
    out.push(
      `  ${s.quality.inconclusive.length} workload(s) not counted: the answer missed a required fact WITHOUT Anyray too, so this run cannot attribute it to us`
    );
  }
  if (s.errors.length) {
    out.push('');
    out.push(`${s.errors.length} workload(s) had failed calls — see results.json`);
  }
  out.push('');
  out.push('This proves per request, not per session. See the README.');
  return out.join('\n');
}
