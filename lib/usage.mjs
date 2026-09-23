// Normalize the provider's `usage` field across both dialects, and define what
// "input tokens" means here.
//
// The naive reading — `prompt_tokens` alone — is wrong the moment prompt caching
// is involved, and it is wrong in OUR favour, which is the worst direction for a
// proof to be wrong in. Providers report cached input separately: on Anthropic,
// `input_tokens` EXCLUDES `cache_read_input_tokens`. Run the bypassed arm first
// and it warms the cache; the optimized arm then reports a tiny `input_tokens`
// and we would book a saving that is really just a cache hit.
//
// So the headline count is every input-side token the provider reported:
//
//     billedInput = input + cacheWrite + cacheRead
//
// Cache activity cannot inflate it. `prove.mjs` also alternates which arm goes
// first across repeats, so neither arm gets the warm side every time, and the
// report says plainly when cache reads were non-zero.

/** Pull the input-side token fields out of either dialect's usage object. */
export function normalizeUsage(usage = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  // Anthropic-native names first, then OpenAI-compatible ones.
  const input = usage.input_tokens != null ? num(usage.input_tokens) : num(usage.prompt_tokens);
  const output =
    usage.output_tokens != null ? num(usage.output_tokens) : num(usage.completion_tokens);
  const cacheWrite = num(
    usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0
  );
  // OpenAI-compatible gateways nest the cached count under prompt_tokens_details.
  const cacheRead = num(
    usage.cache_read_input_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.cached_tokens ??
      0
  );

  // The two dialects mean OPPOSITE things by their input field, and getting it
  // backwards moves the headline number by the size of the cache.
  //
  // Anthropic-native: `input_tokens` EXCLUDES both cached reads and cache
  // writes, so the total is the sum of all three.
  //
  // OpenAI-compatible: `prompt_tokens` is already the TOTAL — it contains the
  // cached reads AND the tokens written to cache. Observed live on a Bedrock-
  // backed gateway, same prompt, two consecutive runs:
  //
  //   prompt_tokens 3231, cache_creation_input_tokens 2857, cached_tokens 0
  //   prompt_tokens 3231, cache_read_input_tokens  2857, cached_tokens 2857
  //
  // Identical prompt, identical total — the 2857 is a SUBSET of the 3231 in
  // both, once as a write and once as a read. Adding it on top reported 6088
  // for the first run and 3231 for the second, which surfaced as a 19% token
  // INCREASE and tripped the repeats-disagree guard. Same bytes must give the
  // same count, and here they do: `prompt_tokens` is the count.
  if (usage.input_tokens != null) {
    return {
      uncachedInput: input,
      cacheWrite,
      cacheRead,
      billedInput: input + cacheWrite + cacheRead,
      output,
    };
  }
  return {
    uncachedInput: Math.max(0, input - cacheRead - cacheWrite),
    cacheWrite,
    cacheRead,
    billedInput: input,
    output,
  };
}

/** Percent saved from before/after. 0 when there was nothing to save. */
export function savedPct(before, after) {
  return before > 0 ? Math.round((1 - after / before) * 100) : 0;
}

/** Sum normalized usages into one total. */
export function sumUsage(rows) {
  return rows.reduce(
    (a, u) => ({
      uncachedInput: a.uncachedInput + u.uncachedInput,
      cacheWrite: a.cacheWrite + u.cacheWrite,
      cacheRead: a.cacheRead + u.cacheRead,
      billedInput: a.billedInput + u.billedInput,
      output: a.output + u.output,
    }),
    { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, billedInput: 0, output: 0 }
  );
}
