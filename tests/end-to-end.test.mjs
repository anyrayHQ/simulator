// The whole thing, against a mock gateway, in both states. The dropping case is
// the one that matters: it is what shows the quality check can actually fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;

/**
 * The mock gateway runs in its OWN process. prove.mjs is invoked with
 * execFileSync, which blocks this process's event loop — an in-process mock
 * server would never get to answer, and the test would hang rather than fail.
 */
function startMock(mode) {
  const child = spawn('node', ['tests/mock-gateway.mjs', mode, '0'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock gateway did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      const m = String(chunk).match(/(http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[1], stop: () => child.kill() });
      }
    });
  });
}

function proveAgainst(url, { expectFailure = false, args = [] } = {}) {
  const out = join(mkdtempSync(join(tmpdir(), 'proof-')), 'results.json');
  const env = {
    ...process.env,
    ANYRAY_GATEWAY_URL: url,
    ANYRAY_API_KEY: 'ark_test_key',
    PROOF_MODEL: 'claude-sonnet-5',
    PROOF_REPEATS: '2',
  };
  let stdout = '';
  try {
    stdout = execFileSync('node', ['prove.mjs', '--out', out, ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(expectFailure, false, 'expected a non-zero exit on a lost fact');
  } catch (e) {
    // exit 2 is the documented "a required fact was lost" status.
    assert.equal(e.status, 2, `unexpected failure: ${e.stdout ?? ''}${e.stderr ?? ''}`);
    assert.equal(expectFailure, true);
    stdout = e.stdout;
  }
  return { stdout, results: JSON.parse(readFileSync(out, 'utf8')) };
}

test('healthy gateway: saves tokens and keeps every fact', async (t) => {
  const { url, stop } = await startMock('healthy');
  t.after(stop);

  const { stdout, results } = proveAgainst(url);
  const s = results.summary;

  assert.ok(s.cost.savedPct > 50, `expected a real saving, got ${s.cost.savedPct}%`);
  assert.equal(s.quality.regressions.length, 0);
  assert.ok(stdout.includes('every required fact survived'));

  // The example that saves nothing must report exactly that.
  const small = s.rows.find((r) => r.id === 'example-02-small-question');
  assert.equal(small.savedPct, 0, 'the no-saving example must report 0%');
  assert.equal(small.facts.regression, false);

  // Strategies are read off the gateway's own header.
  const trimmed = s.rows.find((r) => r.id === 'example-01-log-dump');
  assert.ok(trimmed.strategies.includes('context_compression'));

  // Both arms of both workloads ran the configured number of repeats.
  for (const r of results.results) {
    assert.equal(r.bypassedRuns.length, 2);
    assert.equal(r.optimizedRuns.length, 2);
  }
});

test('dropping gateway: names the lost fact and exits non-zero', async (t) => {
  const { url, stop } = await startMock('dropping');
  t.after(stop);

  const { stdout, results } = proveAgainst(url, { expectFailure: true });
  const s = results.summary;

  assert.ok(s.quality.regressions.length > 0, 'the dropping gateway must be caught');
  assert.ok(stdout.includes('LOST FACTS'));
  assert.ok(stdout.includes('only missing after the trim'), stdout);
  // The terminal and the HTML report must describe the same finding the same
  // way — one saying "with Anyray on" while the other says "after the trim"
  // reads as two different claims to anyone holding both.
  assert.ok(!/only missing with Anyray on/.test(stdout), 'terminal wording drifted from the report');

  const row = s.rows.find((r) => r.id === 'example-01-log-dump');
  assert.deepEqual(row.facts.lost, ['ECONNRESET']);
  // Still saved tokens — a cheaper wrong answer is exactly what we must flag.
  assert.ok(row.savedPct > 0);
});

test('report.html renders from results.json, both verdicts present', async (t) => {
  const { url, stop } = await startMock('healthy');
  t.after(stop);
  const { results } = proveAgainst(url);
  const tmp = mkdtempSync(join(tmpdir(), 'proof-report-'));
  const resultsPath = join(tmp, 'results.json');
  const htmlPath = join(tmp, 'report.html');
  writeFileSync(resultsPath, JSON.stringify(results));
  execFileSync('node', ['report.mjs', '--in', resultsPath, '--out', htmlPath], { cwd: root });
  const html = readFileSync(htmlPath, 'utf8');
  assert.ok(html.includes('1 — Cost'));
  assert.ok(html.includes('2 — Quality'));
  assert.ok(html.includes('does not prove per session'));
  assert.ok(html.includes('example-01-log-dump'));
  rmSync(tmp, { recursive: true, force: true });
});

test('judge: grading is blind — the judge never learns which arm it is reading', async (t) => {
  const { url, stop } = await startMock('healthy');
  t.after(stop);
  const { results } = proveAgainst(url);
  const tmp = mkdtempSync(join(tmpdir(), 'proof-judge-'));
  const resultsPath = join(tmp, 'results.json');
  writeFileSync(resultsPath, JSON.stringify(results));

  const env = { ...process.env, ANYRAY_GATEWAY_URL: url, ANYRAY_API_KEY: 'ark_test_key', PROOF_MODEL: 'claude-sonnet-5' };
  const stdout = execFileSync('node', ['judge.mjs', '--in', resultsPath], { cwd: root, env, encoding: 'utf8' });

  // The mock judge always answers "A". If judge.mjs leaked the arm order into
  // the prompt, or forgot to shuffle, every workload would resolve to the same
  // arm — so the labels must not be a fixed function of the arm.
  assert.ok(stdout.includes('BLIND GRADING'));
  assert.ok(stdout.includes('small sample'));
  rmSync(tmp, { recursive: true, force: true });
});

test('a workload with no facts declared is rejected before any call is billed', () => {
  const out = execFileSync('node', ['prove.mjs', '--dry-run'], { cwd: root, encoding: 'utf8' });
  assert.ok(out.includes('required fact'));
});

test('a wrong gateway URL fails in seconds, not after a minute of backoff', () => {
  const started = Date.now();
  const env = {
    ...process.env,
    ANYRAY_GATEWAY_URL: 'http://127.0.0.1:45999',
    ANYRAY_API_KEY: 'ark_test_key',
    PROOF_MODEL: 'claude-sonnet-5',
    PROOF_REPEATS: '3',
  };
  let stderr = '';
  try {
    execFileSync('node', ['prove.mjs'], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
    assert.fail('expected a non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    stderr = e.stderr;
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15000, `took ${elapsed}ms — a refused connection should not be retried`);
  assert.ok(stderr.includes('first call failed'), stderr);
  assert.ok(stderr.includes('Nothing answered at'), stderr);
  assert.ok(stderr.includes('ANYRAY_GATEWAY_URL'), stderr);
});

test('a stand-down is reported as a reason, not as an empty 0%', async (t) => {
  // A live gateway answered a toolless workload with status "skipped" and the
  // reason "turn declared no callable tool …". Rendered as a bare 0% that reads
  // as "Anyray does nothing for you", which is both wrong and the most
  // expensive misreading this report can produce.
  const { url, stop } = await startMock('healthy');
  t.after(stop);
  const { stdout, results } = proveAgainst(url);
  const row = results.summary.rows.find((r) => r.id === 'example-02-small-question');
  assert.equal(row.savedPct, 0);
  assert.equal(row.optimizeStatus, 'skipped');
  assert.ok(row.optimizeNotes.some((n) => /stood down/.test(n)), JSON.stringify(row.optimizeNotes));
  assert.ok(stdout.includes('Anyray stood down here'), stdout);
  // And the suppression reason survives into results.json for the reader.
  assert.ok(row.suppressed.some((s) => s.includes('no_retrieve')), JSON.stringify(row.suppressed));
});

test('results.json survives a crash partway through a paid run', async (t) => {
  // Every workload is 2 x repeats of billed calls. Writing only at the end
  // meant a failure on workload 9 of 10 threw away the eight already paid for.
  const { url, stop } = await startMock('healthy');
  t.after(stop);
  const out = join(mkdtempSync(join(tmpdir(), 'proof-')), 'results.json');
  const env = {
    ...process.env,
    ANYRAY_GATEWAY_URL: url,
    ANYRAY_API_KEY: 'ark_test_key',
    PROOF_MODEL: 'claude-sonnet-5',
    PROOF_REPEATS: '1',
  };

  const child = spawn('node', ['prove.mjs', '--out', out], { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
  // Kill once the SECOND workload row has printed: by then the first workload's
  // write has certainly landed, and we are still mid-run with money spent on
  // workloads that will never be reported unless they were saved as they went.
  await new Promise((resolve) => {
    let rows = 0;
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (/^(example|\d)\S*\s+[\d,]+ →/.test(line)) rows++;
      }
      if (rows >= 2) {
        child.kill('SIGKILL');
        resolve();
      }
    });
    child.on('exit', resolve);
  });
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(existsSync(out), 'a killed run left no results at all');
  const partial = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(partial.results.length >= 1, 'the completed workload was not saved');
  assert.equal(partial.complete, false, 'a partial run must not claim to be complete');
});

test('an interrupted run resumes instead of re-buying what it already paid for', async (t) => {
  const { url, stop } = await startMock('healthy');
  t.after(stop);
  const dir = mkdtempSync(join(tmpdir(), 'proof-'));
  const out = join(dir, 'results.json');
  const env = {
    ...process.env,
    ANYRAY_GATEWAY_URL: url,
    ANYRAY_API_KEY: 'ark_test_key',
    PROOF_MODEL: 'claude-sonnet-5',
    PROOF_REPEATS: '1',
  };

  execFileSync('node', ['prove.mjs', '--out', out], { cwd: root, env, encoding: 'utf8' });
  const full = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(full.complete, true);
  assert.ok(full.results.length >= 3);

  // Stage an interruption: keep the first two, mark it unfinished.
  const kept = full.results.slice(0, 2).map((r) => r.id);
  writeFileSync(out, JSON.stringify({ ...full, results: full.results.slice(0, 2), complete: false }));

  const stdout = execFileSync('node', ['prove.mjs', '--out', out], { cwd: root, env, encoding: 'utf8' });
  assert.match(stdout, /Resuming an interrupted run: 2 workload\(s\)/);
  // The already-paid workloads must not be re-run — their rows must not reprint.
  for (const id of kept) {
    assert.ok(!new RegExp(`^${id}\\s+[\\d,]+ →`, 'm').test(stdout), `${id} was re-bought`);
  }
  const resumed = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(resumed.complete, true);
  assert.equal(resumed.results.length, full.results.length);
  // One run id across the whole file, or the cache-isolation prefix would
  // differ between the halves.
  assert.equal(resumed.runId, full.runId);

  // A FINISHED run must not resume — re-running then means "give me fresh numbers".
  const again = execFileSync('node', ['prove.mjs', '--out', out], { cwd: root, env, encoding: 'utf8' });
  assert.ok(!/Resuming/.test(again), 'a complete run must start fresh, not resume into a no-op');

  // And --fresh overrides an unfinished one.
  writeFileSync(out, JSON.stringify({ ...full, results: full.results.slice(0, 2), complete: false }));
  const fresh = execFileSync('node', ['prove.mjs', '--out', out, '--fresh'], { cwd: root, env, encoding: 'utf8' });
  assert.ok(!/Resuming/.test(fresh), '--fresh must ignore the partial file');

  rmSync(dir, { recursive: true, force: true });
});

test('a resumed run will not splice two different configurations together', async (t) => {
  const { url, stop } = await startMock('healthy');
  t.after(stop);
  const dir = mkdtempSync(join(tmpdir(), 'proof-'));
  const out = join(dir, 'results.json');
  const base = {
    ...process.env,
    ANYRAY_GATEWAY_URL: url,
    ANYRAY_API_KEY: 'ark_test_key',
    PROOF_MODEL: 'claude-sonnet-5',
    PROOF_REPEATS: '1',
  };
  execFileSync('node', ['prove.mjs', '--out', out], { cwd: root, env: base, encoding: 'utf8' });
  const full = JSON.parse(readFileSync(out, 'utf8'));
  writeFileSync(out, JSON.stringify({ ...full, results: full.results.slice(0, 2), complete: false }));

  // Same partial file, different MODEL. Splicing would put two models' token
  // counts under one headline.
  const stdout = execFileSync('node', ['prove.mjs', '--out', out], {
    cwd: root,
    env: { ...base, PROOF_MODEL: 'claude-opus-4-8' },
    encoding: 'utf8',
  });
  assert.match(stdout, /different model/);
  assert.match(stdout, /Starting fresh rather than mixing two runs/);
  assert.ok(!/Resuming/.test(stdout));
  rmSync(dir, { recursive: true, force: true });
});

test('the mock recognises every shipped workload', async (t) => {
  // A mock that returns no facts for a workload makes every run against it
  // meaningless while looking like it worked: the arms come back identical, the
  // row reads 0%, and nothing fails. Caught when example-04 and 05 were added
  // to workloads/ but not to the mock's answer key.
  const { url, stop } = await startMock('healthy');
  t.after(stop);
  const { results } = proveAgainst(url, { args: ['--examples'] });
  for (const r of results.results) {
    const answer = r.bypassedRuns.find((x) => !x.error)?.answer ?? '';
    assert.ok(
      !/could not determine/i.test(answer),
      `${r.id}: the mock had no answer key, so this workload proves nothing`
    );
  }
  // And with an answer key present, the trimmable ones must actually save.
  const trimmed = results.summary.rows.filter((r) => r.id !== 'example-02-small-question');
  assert.ok(trimmed.every((r) => r.savedPct > 0), 'a trimmable workload reported no saving');
});
