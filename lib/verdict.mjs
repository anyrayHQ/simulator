// Turn the raw runs into the two verdicts, and into the lines printed for them.

import { savedPct, sumUsage } from './usage.mjs';
import { compareArms } from './facts.mjs';
import { costOf, fmtUSD } from './rates.mjs';

const n = (v) => Number(v).toLocaleString('en-US');

/**
 * Per-arm totals for the FIRST repeat only — both arms cold.
 *
 * This exists because the repeats warm the provider's prompt cache, and the two
 * arms do not warm it equally. Anyray's cache_optimizer injects cache_control
 * breakpoints, so the optimized body becomes cacheable and the bypassed one
 * does not. Measured live on gateway.anyray.ai, one workload, three repeats:
 *
 *   bypassed   3231 uncached, 3231 uncached, 3231 uncached
 *   optimized  2857 cache WRITE, then 2857 cache READ, then 2857 cache READ
 *
 * Averaged, the optimized arm looks 62% cheaper — but two of those three cheap
 * runs are hits WE created by sending the same prompt three times. A customer
 * issuing that request once pays for the write (1.25x), not the reads (0.1x).
 * Quoting the average as the headline would over-state the saving, which is the
 * unsafe direction and precisely what this tool exists not to do.
 *
 * So the headline is first-request-vs-first-request, and the repeat figure sits
 * beside it. Real traffic lands between the two.
 *
 * AND THE FIRST REQUEST IS NOT NECESSARILY COLD. The provider's cache outlives
 * a simulator run: running this four times inside the cache TTL, every optimized
 * call — including the first — came back a cache READ. So this is "the first
 * request of this run", not "an unwarmed request", and the report has to say
 * which, or it quietly credits us for a cache someone else's earlier run
 * created. `cacheState` below reports what actually happened rather than what
 * the label assumes.
 */
function firstRequestTotals(runs) {
  const first = runs.find((r) => !r.error);
  return first ? { ...first.usage, runs: 1 } : null;
}

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
      cold: {
        bypassed: firstRequestTotals(res.bypassedRuns),
        optimized: firstRequestTotals(res.optimizedRuns),
      },
      savedPct: bypassed && optimized ? savedPct(bypassed.billedInput, optimized.billedInput) : null,
      facts,
      strategies: [...new Set(res.optimizedRuns.flatMap((r) => r.strategies ?? []))],
      // "skipped" with a reason is a RESULT, not a blank. Keep it.
      optimizeStatus: res.optimizedRuns.find((r) => r.optimization)?.optimization?.status ?? null,
      optimizeNotes: [
        ...new Set(res.optimizedRuns.flatMap((r) => r.optimization?.notes ?? [])),
      ],
      suppressed: [...new Set(res.optimizedRuns.flatMap((r) => r.optimization?.suppressed ?? []))],
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
  const zero = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, billedInput: 0, output: 0 };
  const add = (a, u) => ({
    uncachedInput: a.uncachedInput + u.uncachedInput,
    cacheWrite: a.cacheWrite + u.cacheWrite,
    cacheRead: a.cacheRead + u.cacheRead,
    billedInput: a.billedInput + u.billedInput,
    output: a.output + u.output,
  });
  const usageOf = (arm) => measured.reduce((a, r) => add(a, r[arm]), zero);
  const coldUsageOf = (arm) =>
    measured.filter((r) => r.cold[arm]).reduce((a, r) => add(a, r.cold[arm]), zero);

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
      // Cold: one request each, neither arm helped by a cache the repeats made.
      beforeUSD: costOf(rates, model, coldUsageOf('bypassed')),
      afterUSD: costOf(rates, model, coldUsageOf('optimized')),
      // Warm: averaged across the repeats, which is what REPEAT traffic costs
      // once a prefix is cached — reported, never used as the headline.
      warmBeforeUSD: costOf(rates, model, usageOf('bypassed')),
      warmAfterUSD: costOf(rates, model, usageOf('optimized')),
      priced: costOf(rates, model, coldUsageOf('bypassed')) != null,
      usdSavedPct: (() => {
        const b = costOf(rates, model, coldUsageOf('bypassed'));
        const a = costOf(rates, model, coldUsageOf('optimized'));
        return b ? Math.round((1 - a / b) * 100) : 0;
      })(),
      notMeasured: rows.filter((r) => ['timeout', 'error'].includes(r.optimizeStatus)).length,
      cacheSeen,
      // What the cache was actually doing, rather than what "first request"
      // implies. `prewarmed` means even the first call of this run hit a cache
      // an EARLIER run left behind — the figure is then a warm one wearing a
      // cold label, and saying so is the difference between a measurement and
      // a flattering number.
      cacheState: (() => {
        const cold = coldUsageOf('optimized');
        const all = usageOf('optimized');
        if (all.cacheRead === 0 && all.cacheWrite === 0) return 'none';
        if (cold.cacheRead > 0) return 'prewarmed';
        if (all.cacheRead > 0) return 'warmed-by-repeats';
        return 'written-not-read';
      })(),
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
  const quality = r.facts.truncated
    ? `ANSWER TRUNCATED — quality not judged`
    : r.facts.regression
    ? `LOST FACTS (${r.facts.optimizedKept}/${r.facts.total} vs ${r.facts.bypassedKept}/${r.facts.total})`
    : r.facts.inconclusive
      ? `inconclusive ${r.facts.optimizedKept}/${r.facts.total} (baseline missed them too)`
      : `facts kept ${r.facts.optimizedKept}/${r.facts.total}`;
  const lines = [`${r.id.padEnd(30)} ${tokens} ${pct}  ${quality}`];
  if (r.facts.truncated) {
    lines.push(
      `  ! the answer hit PROOF_MAX_TOKENS, so a missing fact here is OUR ceiling, not the model. Raise it in .env and re-run this workload.`
    );
  }
  if (r.facts.regression) {
    lines.push(`  ! only missing with Anyray on: ${r.facts.lost.join(', ')}`);
  }
  if (r.facts.inconclusive && !r.facts.regression && r.facts.missingBoth.length) {
    lines.push(`  · missing from BOTH answers, so not counted: ${r.facts.missingBoth.join(', ')}`);
  }
  // A timeout means the optimizer never ran. The row is then a measurement of
  // an UNOPTIMIZED request wearing an "Anyray on" label — the one outcome that
  // must never be read as "Anyray saved nothing here".
  if (r.optimizeStatus === 'timeout' || r.optimizeStatus === 'error') {
    lines.push(
      `  ! NOT MEASURED: the optimizer reported "${r.optimizeStatus}", so this request went through unoptimized. Re-run this workload.`
    );
  }
  if (r.savedPct === 0 && r.optimizeStatus === 'skipped' && r.optimizeNotes.length) {
    // Without this the row reads "0%" and the reader concludes Anyray is
    // useless on their prompt. The gateway knows better and said so.
    lines.push(`  · Anyray stood down here: ${r.optimizeNotes[0]}`);
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
        `  at list price  ${fmtUSD(s.cost.beforeUSD)} → ${fmtUSD(s.cost.afterUSD)}   (${s.model}, rates.json, first request of each arm)`
      );
      // The headline is tokens, but tokens are only one of the two ways a
      // request gets cheaper. A deployment running cache_optimizer alone moves
      // the BILL without moving a single token — leading with "0% lower" there
      // reports the opposite of what happened.
      if (s.cost.priced && s.cost.usdSavedPct > s.cost.savedPct + 1) {
        out.push('');
        out.push(
          `  The saving here is cacheability, not fewer tokens: ${s.cost.usdSavedPct}% off the bill at an identical token count.`
        );
        out.push(
          `  Anyray restructured the prompt so the prefix caches — nothing was removed, so nothing could be lost.`
        );
      }
      if (s.cost.cacheState !== 'none') {
        out.push(
          `  repeat traffic ${fmtUSD(s.cost.warmBeforeUSD)} → ${fmtUSD(s.cost.warmAfterUSD)}   averaged over all ${s.repeats} runs`
        );
        out.push(
          `  Anyray made this prompt cacheable, so a RESENT prefix costs less without losing a single token.`
        );
        if (s.cost.cacheState === 'prewarmed') {
          out.push(
            `  ! Even the first request of this run hit a cache an EARLIER run left behind, so NEITHER figure above is a cold measurement.`
          );
          out.push(
            `    For a true cold number, wait out your provider's cache TTL (Anthropic: ~5 min) and run once with --repeats 1.`
          );
        } else if (s.cost.cacheState === 'warmed-by-repeats') {
          out.push(
            `  The first figure is the cold one; the repeats warmed the cache themselves, so the average would credit us for hits this run created.`
          );
        }
      }
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
      `  every required fact survived, in all ${s.repeats} run${s.repeats === 1 ? '' : 's'}, on ${s.quality.clean} of ${s.quality.checked} checked workloads`
    );
  }
  const truncated = s.rows.filter((r) => r.facts.truncated);
  if (truncated.length) {
    out.push(
      `  ! ${truncated.length} workload(s) had an answer cut off at PROOF_MAX_TOKENS and are NOT judged: a fact the answer never reached is our ceiling, not a loss we caused.`
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
