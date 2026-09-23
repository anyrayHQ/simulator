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
export function compareArms({ bypassedRuns, optimizedRuns, mustInclude = [] }) {
  const bypassed = survivingFacts(bypassedRuns, mustInclude);
  const optimized = survivingFacts(optimizedRuns, mustInclude);
  const lost = [...bypassed].filter((f) => !optimized.has(f));
  const missingBoth = mustInclude.filter((f) => !bypassed.has(f) && !optimized.has(f));
  const recovered = [...optimized].filter((f) => !bypassed.has(f));
  return {
    total: mustInclude.length,
    bypassedKept: bypassed.size,
    optimizedKept: optimized.size,
    lost,
    missingBoth,
    recovered,
    regression: lost.length > 0,
    // A workload where the baseline itself could not carry every fact tells us
    // nothing either way, so it is reported but not counted as a pass.
    inconclusive: bypassed.size < mustInclude.length,
  };
}
