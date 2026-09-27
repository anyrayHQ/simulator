// The quality side: did the answer still carry the facts the customer said a
// correct answer has to carry?
//
// Matching is deliberately forgiving about presentation and strict about
// substance: case and runs of whitespace are normalized, nothing else is. A
// fact is a short verbatim marker — an error code, a service name, an order id
// — so "ECONNRESET" matching "econnreset" is the same fact, while a fact the
// model paraphrased away is a miss, and should be.

const normalize = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ');

/** Which of this workload's required facts appear in one answer. */
export function checkFacts(answer, mustInclude = []) {
  const hay = normalize(answer);
  const present = [];
  const missing = [];
  for (const fact of mustInclude) {
    (hay.includes(normalize(fact)) ? present : missing).push(fact);
  }
  return { present, missing, kept: present.length, total: mustInclude.length };
}

/**
 * A fact "survived" an arm only if it was present in EVERY run of that arm. One
 * good run out of three is not survival; it is a coin landing our way.
 */
export function survivingFacts(runs, mustInclude = []) {
  const survived = new Set(mustInclude);
  for (const run of runs) {
    const present = new Set(checkFacts(run.answer, mustInclude).present);
    for (const fact of [...survived]) if (!present.has(fact)) survived.delete(fact);
  }
  return survived;
}

/**
 * THE ASYMMETRY. A workload is a regression only when a fact survived WITHOUT
 * Anyray and stopped surviving WITH it. A fact both arms miss means the model
 * could not answer the question from this prompt in the first place, or the
 * fact was written wrong — either way it is not damage we caused, and counting
 * it would turn a badly written check into a report of harm.
 */
/**
 * A provider stops for two very different reasons and only one of them is the
 * model's doing. `length` / `max_tokens` means WE cut the answer off at
 * PROOF_MAX_TOKENS, so any fact it had not reached yet is missing because of
 * our own ceiling.
 *
 * Measured: with PROOF_MAX_TOKENS=12 a real answer came back "The failing order
 * is ord_88412, which failed in" and the run reported two facts missing from
 * both answers. The asymmetry rule happened to save us there — both arms were
 * cut, so it read as inconclusive rather than as damage. But the arms do not
 * have to truncate symmetrically: Anyray reshapes the prompt, the answer can be
 * ordered differently, and one arm reaching the ceiling while the other does
 * not is a FALSE "LOST FACTS" — the single most expensive wrong answer this
 * tool can give.
 */
export const TRUNCATED = new Set(['length', 'max_tokens']);

/**
 * A turn that ended in a TOOL CALL is not an answer either.
 *
 * If the optimizer elides a span behind a `ctx_` handle, a retrieval-capable
 * model does the correct thing and calls `anyray_retrieve` to fetch it back —
 * `finish_reason: "tool_calls"`, and the visible text is something like "I need
 * to retrieve the omitted lines". Scoring that as the final answer marks every
 * required fact missing and reports a LOST FACTS regression against us, when
 * what actually happened is that the model asked a question this harness never
 * answered. Observed live: example-01 lost all three facts this way while the
 * bypassed arm named them.
 *
 * So an unanswered tool call disqualifies the workload's quality verdict, the
 * same as a truncated answer does. Both mean "we do not have an answer to
 * judge", and inventing a verdict from a non-answer is worse than declining.
 */
export const UNFINISHED = new Set(['tool_calls', 'tool_use', 'function_call']);

export const wasTruncated = (run) =>
  TRUNCATED.has(run?.finishReason) || UNFINISHED.has(run?.finishReason);

export const wantedATool = (run) => UNFINISHED.has(run?.finishReason);

export function compareArms({ bypassedRuns, optimizedRuns, mustInclude = [] }) {
  const bypassed = survivingFacts(bypassedRuns, mustInclude);
  const optimized = survivingFacts(optimizedRuns, mustInclude);
  const lost = [...bypassed].filter((f) => !optimized.has(f));
  const missingBoth = mustInclude.filter((f) => !bypassed.has(f) && !optimized.has(f));
  const recovered = [...optimized].filter((f) => !bypassed.has(f));
  // A truncated run cannot be trusted either way, so it disqualifies the
  // workload's quality verdict rather than quietly producing one.
  const truncated = [...bypassedRuns, ...optimizedRuns].some(wasTruncated);
  return {
    total: mustInclude.length,
    bypassedKept: bypassed.size,
    optimizedKept: optimized.size,
    lost,
    missingBoth,
    recovered,
    truncated,
    regression: lost.length > 0 && !truncated,
    // A workload where the baseline itself could not carry every fact tells us
    // nothing either way, so it is reported but not counted as a pass.
    inconclusive: truncated || bypassed.size < mustInclude.length,
  };
}
