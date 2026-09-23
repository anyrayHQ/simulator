// Turn a token count into dollars at published list price. The percentage is the
// real headline; this exists so the percentage has a number next to it.

import { readFileSync } from 'node:fs';

export function loadRates(path = 'rates.json') {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Look up a model's rate. Exact id first, then the id with a `[1m]`-style alias
 * and a trailing date snapshot stripped (`claude-sonnet-5-20260514`).
 *
 * NO PREFIX FALLBACK, and that is the important part.
 *
 * An earlier version matched the longest configured prefix so a deployment
 * alias like `claude-sonnet-5-prod` would still price. That is exactly how a
 * NEW model silently inherits an OLD model's rate: `claude-opus-5-5` shipped at
 * $4/$20 and delimiter-extends `claude-opus-5` at $5/$25, so a prefix match
 * prices it 25% high while looking perfectly priced. The monorepo's pricing
 * table hit this and documents it — over-pricing is the unsafe direction here,
 * because it over-states the saving, which is the number this whole repo exists
 * to be trusted on.
 *
 * So an unknown id returns null and the report says "tokens only". A documented
 * gap beats a confident wrong number, and a customer checking our arithmetic
 * against their own invoice is precisely who runs this tool.
 */
export function rateFor(rates, model) {
  const models = rates.models || {};
  if (models[model]) return models[model];
  const bare = String(model)
    .replace(/\[[^\]]*\]$/, '') // context-window alias: claude-opus-5[1m]
    .replace(/-\d{8}$/, ''); // dated snapshot: claude-sonnet-5-20260514
  return models[bare] ?? null;
}

/** USD for one normalized usage total at this model's rate. Null if unpriced. */
export function costOf(rates, model, usage, { includeOutput = false } = {}) {
  const rate = rateFor(rates, model);
  if (!rate) return null;
  const perToken = rate.input / 1_000_000;
  const writeRate = perToken * (rates.cache?.writeMultiplier ?? 1.25);
  // A model may read cached input below the house tier (Fable 5.1 at 0.025x,
  // Opus 5.5 at 0.05x). Inheriting the house 0.1x would charge cached tokens at
  // up to 4x their real cost — and on warm agent traffic cached reads are most
  // of the input, so that lands squarely on the number being proved.
  const readRate = perToken * (rate.cacheReadMultiplier ?? rates.cache?.readMultiplier ?? 0.1);
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
