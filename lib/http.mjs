// fetch with retry/backoff for 429 + 5xx + transient network errors. A proof run
// makes 2 x repeats calls per workload against a live provider, so a rate limit
// partway through should cost a wait, not the run.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry only what a retry can actually fix. A wrong host, a closed port or a
 * malformed URL is the likeliest thing to be wrong with a fresh .env, and
 * backing off five times over a minute to rediscover that leaves the customer
 * watching a silent terminal — so anything not on this list fails immediately.
 * Listing the transient cases rather than the fatal ones means an unfamiliar
 * error fails fast and visibly, instead of silently costing a minute each.
 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',   // connection dropped mid-flight
  'ETIMEDOUT',    // no response in time
  'EPIPE',        // socket closed as we wrote
  'ECONNABORTED',
  'EAI_AGAIN',    // temporary DNS failure
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const isRetryable = (e) =>
  e?.name === 'AbortError' || // our own timeout fired
  RETRYABLE_CODES.has(e?.code) ||
  RETRYABLE_CODES.has(e?.cause?.code);

export async function fetchRetry(
  url,
  makeInit,
  { retries = 5, baseMs = 2000, maxMs = 30000, timeoutMs = 120000, fetchImpl = fetch } = {}
) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...makeInit(), signal: ctrl.signal });
      clearTimeout(timer);
      const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (retryable && attempt < retries) {
        const ra = Number(res.headers?.get?.('retry-after'));
        const waitMs =
          Number.isFinite(ra) && ra > 0
            ? ra * 1000
            : Math.min(baseMs * 2 ** attempt, maxMs) + Math.floor(Math.random() * 500);
        await sleep(waitMs);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      last = e;
      if (!isRetryable(e)) throw e;
      if (attempt === retries) throw e;
      await sleep(Math.min(baseMs * 2 ** attempt, maxMs));
    }
  }
  throw last;
}
