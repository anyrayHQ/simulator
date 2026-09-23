// fetch with retry/backoff for 429 + 5xx + transient network errors. A proof run
// makes 2 x repeats calls per workload against a live provider, so a rate limit
// partway through should cost a wait, not the run.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      if (attempt === retries) throw e;
      await sleep(Math.min(baseMs * 2 ** attempt, maxMs));
    }
  }
  throw last;
}
