// The world a session agent investigates: a small repository with logs, config
// and a deploy history, generated from a seed so every arm of every round sees
// byte-identical files.
//
// It is shaped to be realistic rather than flattering. The logs are large, so
// reading them is expensive and an agent re-reads and greps; the answer sits in
// one of four pods; and the loudest error in the data is a harmless red herring,
// so an agent that grabs the first ERROR it sees gets graded wrong rather than
// rewarded for speed. Solving it takes connecting the failing pod to a canary
// deploy and diffing a config against its previous version.

/** Deterministic PRNG, so a seed fixes the world. */
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

export const TASK =
  'Checkout has been failing for some orders since about 14:00 UTC today. Investigate the repository: ' +
  'find which upstream service the failing orders hit, the exact error, and the change that caused it ' +
  '(the config key and the PR number). When you are confident, call `finish` with your answer.';

/** Facts a correct answer has to carry. Matched case-insensitively. */
export const REQUIRED = ['payments-api', 'ECONNRESET', 'keepalive_idle_ms', '4411'];

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ts = (min, sec, ms) => `2026-09-21T${pad(12 + Math.floor(min / 60))}:${pad(min % 60)}:${pad(sec)}.${pad(ms, 3)}Z`;

function podLog(rand, pod, { fromMin = 0, perMin = 4 } = {}) {
  const lines = [];
  // 12:00 to 15:00, one routine line every ~15s, plus the pod's own trouble.
  // The small world starts at 13:45 with two lines a minute: ~5x fewer tokens,
  // the same incident at the same time, so a session costs cents.
  for (let min = fromMin; min < 180; min++) {
    for (let k = 0; k < perMin; k++) {
      const sec = k * Math.floor(60 / perMin) + Math.floor(rand() * 14);
      const ms = Math.floor(rand() * 1000);
      const order = `ord_${70000 + Math.floor(rand() * 9000)}`;
      const worker = Math.floor(rand() * 8);
      const lat = 90 + Math.floor(rand() * 180);
      // Pod 2 took the canary at 13:58. From then on, every ~5th payment call
      // reuses a connection payments-api already closed.
      if (pod === 2 && min >= 120 && rand() < 0.22) {
        const bad = `ord_${88400 + Math.floor(rand() * 90)}`;
        lines.push(`${ts(min, sec, ms)} WARN  checkout worker=${worker} order=${bad} upstream=payments-api attempt=1 reused_conn=true idle_ms=${61000 + Math.floor(rand() * 50000)}`);
        lines.push(`${ts(min, sec, ms + 1 > 999 ? 999 : ms + 1)} ERROR checkout worker=${worker} order=${bad} upstream=payments-api attempt=1 error=ECONNRESET socket hang up pod=checkout-2`);
        continue;
      }
      lines.push(`${ts(min, sec, ms)} INFO  checkout worker=${worker} order=${order} state=pending->authorized upstream=payments-api latency_ms=${lat} pod=checkout-${pod}`);
      // The red herring: pod 0's cache warmer logs a loud, harmless redis
      // MOVED all day long, before the incident as much as during it.
      if (pod === 0 && rand() < 0.18) {
        lines.push(`${ts(min, sec, ms)} ERROR cache-warmer slot=${Math.floor(rand() * 16384)} redis MOVED 10.0.4.${2 + Math.floor(rand() * 6)}:6379 retrying pod=checkout-0`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function goFile(rand, name, fns) {
  const out = [`package checkout`, ``, `// ${name}: generated fixture, shaped like a real service file.`, ``];
  for (const fn of fns) {
    out.push(`func ${fn}(ctx context.Context, req *Request) (*Response, error) {`);
    const n = 6 + Math.floor(rand() * 10);
    for (let i = 0; i < n; i++) {
      out.push(`\tif err := validate${fn}Step${i}(ctx, req); err != nil {`);
      out.push(`\t\treturn nil, fmt.Errorf("${fn} step ${i}: %w", err)`);
      out.push(`\t}`);
    }
    out.push(`\treturn &Response{OK: true}, nil`, `}`, ``);
  }
  return out.join('\n');
}

/** Path -> file contents. Same seed, same bytes. */
export function buildWorld(seed = 7, { small = false } = {}) {
  const rand = mulberry32(seed);
  const files = {};
  const shape = small ? { fromMin: 105, perMin: 2 } : {};
  for (let pod = 0; pod < 4; pod++) files[`logs/checkout-${pod}.log`] = podLog(rand, pod, shape);

  files['config/payments-client.yaml'] = [
    'upstream: payments-api',
    'base_url: http://payments-api.internal:8080',
    'max_idle_conns: 64',
    'keepalive_idle_ms: 120000',
    'request_timeout_ms: 9000',
    'retries: 0',
    '',
  ].join('\n');
  files['deploy/history/payments-client.yaml@4410'] = files['config/payments-client.yaml']
    .replace('keepalive_idle_ms: 120000', 'keepalive_idle_ms: 30000')
    .replace('max_idle_conns: 64', 'max_idle_conns: 32');
  files['deploy/CHANGELOG.md'] = [
    '# Deploys (newest first)',
    '',
    '- 2026-09-21 13:58  #4411  checkout: tune payments client connection pool for peak (canary: checkout-2)',
    '- 2026-09-21 11:20  #4408  cache-warmer: log MOVED redirects at ERROR while we chase slot churn',
    '- 2026-09-20 17:05  #4402  checkout: bump go to 1.24.3',
    '- 2026-09-20 10:41  #4399  payments-api: raise pod count to 12',
    '- 2026-09-19 15:12  #4391  checkout: structured order logging',
    '- 2026-09-18 09:30  #4385  deps: renovate batch',
    '',
    'Previous config snapshots live in deploy/history/<file>@<PR before the change>.',
    '',
  ].join('\n');
  files['docs/payments-api.md'] = [
    '# payments-api',
    '',
    'Owner: payments team. Serves authorizations for checkout over HTTP/1.1.',
    '',
    '- Server closes idle keep-alive connections after 60s (60000 ms).',
    '- Clients must keep their idle-connection timeout BELOW that, or they will reuse sockets the server already closed.',
    '- p99 latency ~250 ms; 9 s client timeout is plenty.',
    '',
  ].join('\n');
  files['runbooks/redis-moved.md'] = [
    '# cache-warmer: redis MOVED',
    '',
    'MOVED redirects are expected during slot rebalancing and are retried automatically.',
    'Since #4408 they are logged at ERROR level while we investigate churn. They do not affect checkout.',
    '',
  ].join('\n');
  files['src/checkout/authorize.go'] = goFile(rand, 'authorize.go', ['Authorize', 'Capture', 'Void', 'Refund']);
  files['src/checkout/payments_client.go'] =
    goFile(rand, 'payments_client.go', ['NewPaymentsClient', 'Do']) +
    '\n// The transport reads keepalive_idle_ms from config/payments-client.yaml as IdleConnTimeout.\n';
  files['src/checkout/orders.go'] = goFile(rand, 'orders.go', ['CreateOrder', 'GetOrder', 'ListOrders', 'CancelOrder', 'UpdateOrder']);
  files['README.md'] = '# checkout\n\nCheckout service. Logs per pod under logs/, config under config/, deploy notes under deploy/.\n';
  return files;
}

/** Which required facts an answer carries. */
export function grade(answer) {
  return gradeAgainst(REQUIRED, answer);
}

/** Which of `required` an answer carries, case-insensitively. */
export function gradeAgainst(required, answer) {
  const a = String(answer ?? '').toLowerCase();
  const found = required.filter((f) => a.includes(f.toLowerCase()));
  return { solved: found.length === required.length, found, missing: required.filter((f) => !found.includes(f)) };
}

// ---------- tools, shaped like a coding agent's ----------

export const TOOLS = [
  {
    name: 'glob',
    description: 'List files whose path matches a glob pattern (supports * and **).',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'read',
    description: 'Read a file. Returns numbered lines. Optional offset (1-based line) and limit (lines, default 2000).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns path:line:text for matches (max 400). Optional path glob to restrict files.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'finish',
    description: 'Submit your final answer and end the investigation.',
    input_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
  },
];

function globToRegex(g) {
  const re = g
    .replace(/^\.?\//, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`);
}

/** Run one tool call against the world. Always returns a string, never throws. */
export function runTool(files, name, input = {}) {
  const paths = Object.keys(files).sort();
  const norm = (p) => String(p ?? '').replace(/^\.?\//, '');
  if (name === 'glob') {
    const re = globToRegex(input.pattern || '**');
    const hits = paths.filter((p) => re.test(p));
    return hits.length ? hits.join('\n') : 'No files matched.';
  }
  if (name === 'read') {
    const f = files[norm(input.path)];
    if (f == null) return `Error: no such file ${input.path}`;
    const all = f.split('\n');
    const start = Math.max(1, Number(input.offset) || 1);
    const limit = Math.max(1, Number(input.limit) || 2000);
    return all
      .slice(start - 1, start - 1 + limit)
      .map((l, i) => `${String(start + i).padStart(6)}\t${l}`)
      .join('\n');
  }
  if (name === 'grep') {
    let re;
    try {
      re = new RegExp(input.pattern);
    } catch (e) {
      return `Error: bad pattern: ${e.message}`;
    }
    const scope = input.path ? globToRegex(input.path) : null;
    const out = [];
    for (const p of paths) {
      if (scope && !scope.test(p) && norm(input.path) !== p) continue;
      const lines = files[p].split('\n');
      for (let i = 0; i < lines.length && out.length < 400; i++) if (re.test(lines[i])) out.push(`${p}:${i + 1}:${lines[i]}`);
    }
    return out.length ? out.join('\n') + (out.length === 400 ? '\n[results capped at 400]' : '') : 'No matches.';
  }
  return `Error: unknown tool ${name}`;
}
