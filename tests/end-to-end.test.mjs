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

function proveAgainst(url, { expectFailure = false } = {}) {
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
    stdout = execFileSync('node', ['prove.mjs', '--out', out], { cwd: root, env, encoding: 'utf8' });
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
  assert.ok(stdout.includes('only missing with Anyray on'));

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
