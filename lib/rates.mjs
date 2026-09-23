// Turn a token count into dollars at published list price. The percentage is the
// real headline; this exists so the percentage has a number next to it.

import { readFileSync } from 'node:fs';

export function loadRates(path = 'rates.json') {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Look up a model's rate. Exact id first, then the id with a trailing date
 * snapshot stripped (`claude-sonnet-5-20260514`), then the longest configured
 * prefix — so a deployment alias like `claude-sonnet-5-prod` still prices.
 * Returns null when nothing matches: no rate means no dollar figure, never a
 * guessed one.
 */
export function rateFor(rates, model) {
  const models = rates.models || {};
  if (models[model]) return models[model];
  const undated = String(model).replace(/-\d{8}$/, '');
  if (models[undated]) return models[undated];
  const prefix = Object.keys(models)
    .filter((id) => undated.startsWith(id))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? models[prefix] : null;
}

/** USD for one normalized usage total at this model's rate. Null if unpriced. */
export function costOf(rates, model, usage, { includeOutput = false } = {}) {
  const rate = rateFor(rates, model);
  if (!rate) return null;
  const perToken = rate.input / 1_000_000;
  const writeRate = perToken * (rates.cache?.writeMultiplier ?? 1.25);
  const readRate =
    rate.cacheRead != null
      ? rate.cacheRead / 1_000_000
      : perToken * (rates.cache?.readMultiplier ?? 0.1);
  const input =
    usage.uncachedInput * perToken + usage.cacheWrite * writeRate + usage.cacheRead * readRate;
  if (!includeOutput) return input;
  return input + usage.output * (rate.output / 1_000_000);
}

/** $0.0483 -> "$0.05"; small figures keep enough digits to be non-zero. */
export function fmtUSD(n) {
  if (n == null) return null;
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
