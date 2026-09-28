// The "watch" scenario: an agent re-runs the same log command until it is sure
// a fix worked. The shape that dominates real coding-agent traffic — the same
// observation pulled back turn after turn, each window mostly overlapping the
// last — and the one context_dedupe, repeat_factor and observation_mask exist
// for. The incident scenario (lib/world.mjs) barely re-reads anything, so it
// cannot tell those strategies apart from doing nothing.
//
// A fix rolls out at 14:37. The live clock starts at 14:30 and moves two
// minutes per log call, so the agent has to keep looking to see the errors
// stop, and the answer (the last error it saw) only exists after it has.

const pad = (n, w = 2) => String(n).padStart(w, '0');
const hhmm = (min) => `${pad(14 + Math.floor(min / 60))}:${pad(min % 60)}`;
const stamp = (min, sec, ms) => `2026-09-21T${hhmm(min)}:${pad(sec)}.${pad(ms, 3)}Z`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIX_MIN = 37; // 14:37: the revert lands and the resets stop
const START_MIN = 30; // the clock when the session begins
const STEP_MIN = 2; // clock advance per log call
const END_MIN = 90;

/** pod -> [{min, line}], minute offsets from 14:00. Deterministic from the seed. */
function buildLogs(seed) {
  const rand = mulberry32(seed);
  const logs = {};
  for (let pod = 0; pod < 4; pod++) {
    const lines = [];
    for (let min = 0; min < END_MIN; min++) {
      for (let k = 0; k < 6; k++) {
        const sec = k * 10 + Math.floor(rand() * 9);
        const ms = Math.floor(rand() * 1000);
        if (pod === 2 && min < FIX_MIN && rand() < 0.25) {
          const order = `ord_${88400 + Math.floor(rand() * 90)}`;
          lines.push({ min, line: `${stamp(min, sec, ms)} ERROR checkout order=${order} upstream=payments-api error=ECONNRESET socket hang up pod=checkout-2` });
          continue;
        }
        const order = `ord_${70000 + Math.floor(rand() * 9000)}`;
        lines.push({ min, line: `${stamp(min, sec, ms)} INFO  checkout order=${order} state=pending->authorized upstream=payments-api latency_ms=${90 + Math.floor(rand() * 180)} pod=checkout-${pod}` });
      }
    }
    logs[pod] = lines;
  }
  return logs;
}

export function watchScenario(seed = 7) {
  const logs = buildLogs(seed);
  const errors = logs[2].filter((l) => l.line.includes('ECONNRESET'));
  const lastError = errors[errors.length - 1].line.slice(11, 16); // HH:MM
  const changelog = [
    '# Deploys (newest first)',
    '',
    '- 2026-09-21 14:36  #4415  checkout: revert payments client pool tuning (#4411) on checkout-2',
    '- 2026-09-21 13:58  #4411  checkout: tune payments client connection pool for peak (canary: checkout-2)',
    '- 2026-09-21 11:20  #4408  cache-warmer: log MOVED redirects at ERROR while we chase slot churn',
    '',
  ].join('\n');

  return {
    name: 'watch',
    task:
      'Checkout pod checkout-2 has been throwing ECONNRESET errors against payments-api, and a fix is rolling out right now. ' +
      'Watch the live logs until you are confident whether the errors have stopped. The log tool only shows recent lines, ' +
      'so run it again to see new ones. Then call `finish` with: whether the errors stopped, the time (HH:MM) of the last ' +
      'ECONNRESET you saw, and the PR number of the fix (deploy/CHANGELOG.md).',
    required: [lastError, '4415'],
    followups: [
      { prompt: 'Thanks. Which PR did the fix revert, and which pod was its canary?', required: ['4411', 'checkout-2'] },
      { prompt: 'Is the cache-warmer part of this? Which PR made it log at ERROR?', required: ['4408'] },
    ],
    tools: [
      {
        name: 'kubectl_logs',
        description: 'Show the most recent log lines of a checkout pod (checkout-0 .. checkout-3), up to now. Optional tail (lines, default 120).',
        input_schema: { type: 'object', properties: { pod: { type: 'string' }, tail: { type: 'integer' } }, required: ['pod'] },
      },
      {
        name: 'read',
        description: 'Read a file.',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'finish',
        description: 'Submit your final answer and end the investigation.',
        input_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      },
    ],
    /** A fresh tool runner per session: each session has its own live clock. */
    runner() {
      let now = START_MIN;
      return (name, input = {}) => {
        if (name === 'kubectl_logs') {
          const pod = Number(String(input.pod ?? '').replace(/\D/g, ''));
          if (!(pod in logs)) return `Error: no such pod ${input.pod}`;
          const tail = Math.max(1, Math.min(500, Number(input.tail) || 120));
          const visible = logs[pod].filter((l) => l.min <= now).map((l) => l.line);
          const out = visible.slice(-tail).join('\n');
          now = Math.min(END_MIN - 1, now + STEP_MIN);
          return out;
        }
        if (name === 'read') {
          return /changelog/i.test(String(input.path)) ? changelog : `Error: no such file ${input.path}`;
        }
        return `Error: unknown tool ${name}`;
      };
    },
  };
}
