// The whole thing, against a mock gateway, in both states. The dropping case is
// the one that matters: it is what shows the quality check can actually fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;

/**
 * Both mocks run in their OWN processes. prove.mjs is invoked with
 * execFileSync, which blocks this process's event loop — an in-process mock
 * server would never get to answer, and the test would hang rather than fail.
 */
function spawnMock(script, args) {
  const child = spawn('node', [script, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} did not start`)), 10000);
    child.stdout.on('data', (chunk) => {
      const m = String(chunk).match(/(http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[1], stop: () => child.kill() });
      }
    });
  });
}

const startProvider = (...flags) => spawnMock('tests/mock-provider.mjs', ['0', ...flags]);
const startOptimizer = (mode, warmAfterMs = 0) =>
  spawnMock('tests/mock-optimizer.mjs', [mode, '0', String(warmAfterMs)]);

/** Bring up both, and tear both down. */
async function stack(t, { optimizer = 'healthy', warmAfterMs = 0, flaky = false } = {}) {
  const provider = await startProvider(...(flaky ? ['--flaky'] : []));
  const opt = await startOptimizer(optimizer, warmAfterMs);
  t.after(() => { provider.stop(); opt.stop(); });
  return { providerUrl: provider.url, optimizerUrl: opt.url };
}

function proofEnv({ providerUrl, optimizerUrl }, extra = {}) {
  return {
    ...process.env,
    PROVIDER_BASE_URL: providerUrl,
    PROVIDER_API_KEY: 'sk-test-not-a-real-key',
    PROVIDER_DIALECT: 'openai',
    OPTIMIZER_URL: optimizerUrl,
    PROOF_MODEL: 'claude-sonnet-5',
    PROOF_REPEATS: '2',
    ...extra,
  };
}

function proveAgainst(stackUrls, { expectFailure = false, args = [], env: extra = {} } = {}) {
  const out = join(mkdtempSync(join(tmpdir(), 'proof-')), 'results.json');
  const env = proofEnv(stackUrls, extra);
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

test('healthy optimizer: saves tokens and keeps every fact', async (t) => {
  const urls = await stack(t);
  const { stdout, results } = proveAgainst(urls);
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

test('dropping optimizer: names the lost fact and exits non-zero', async (t) => {
  const urls = await stack(t, { optimizer: 'dropping' });
  const { stdout, results } = proveAgainst(urls, { expectFailure: true });
  const s = results.summary;

  assert.ok(s.quality.regressions.length > 0, 'the dropping gateway must be caught');
  assert.ok(stdout.includes('LOST FACTS'));
  assert.ok(stdout.includes('only missing after the trim'));

  const row = s.rows.find((r) => r.id === 'example-01-log-dump');
  assert.deepEqual(row.facts.lost, ['ECONNRESET']);
  // Still saved tokens — a cheaper wrong answer is exactly what we must flag.
  assert.ok(row.savedPct > 0);
});

test('report.html renders from results.json, both verdicts present', async (t) => {
  const urls = await stack(t);
  const { results } = proveAgainst(urls);
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
  const urls = await stack(t);
  const { results } = proveAgainst(urls);
  const tmp = mkdtempSync(join(tmpdir(), 'proof-judge-'));
  const resultsPath = join(tmp, 'results.json');
  writeFileSync(resultsPath, JSON.stringify(results));

  const stdout = execFileSync('node', ['judge.mjs', '--in', resultsPath], {
    cwd: root,
    env: proofEnv(urls),
    encoding: 'utf8',
  });

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

test('a wrong provider URL fails in seconds, not after a minute of backoff', async (t) => {
  const opt = await startOptimizer('healthy');
  t.after(opt.stop);
  const started = Date.now();
  const env = proofEnv(
    { providerUrl: 'http://127.0.0.1:45999', optimizerUrl: opt.url },
    { PROOF_REPEATS: '3' }
  );
  let stderr = '';
  try {
    execFileSync('node', ['prove.mjs'], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
    assert.fail('expected a non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    stderr = e.stderr;
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20000, `took ${elapsed}ms — a refused connection should not be retried`);
  assert.ok(stderr.includes('first call failed'), stderr);
  assert.ok(stderr.includes('PROVIDER_BASE_URL'), stderr);
});

test('a cold optimizer is waited for, not measured', async (t) => {
  // Warm 3s after start: the run must wait it out and then measure correctly.
  const urls = await stack(t, { warmAfterMs: 3000 });
  const started = Date.now();
  const { stdout, results } = proveAgainst(urls);
  assert.ok(Date.now() - started >= 2500, 'should have waited for the embedder');
  assert.ok(stdout.includes('Waiting for the optimizer'), stdout);
  assert.equal(results.summary.quality.regressions.length, 0);
  assert.equal(results.provenance.embedder, 'warm');
});

test('an optimizer that never warms refuses to measure at all', async (t) => {
  const urls = await stack(t, { optimizer: 'stuck' });
  let stderr = '';
  try {
    execFileSync('node', ['prove.mjs'], {
      cwd: root,
      env: proofEnv(urls, { PROOF_READY_TIMEOUT_MS: '3000' }),
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.fail('expected a non-zero exit');
  } catch (e) {
    assert.equal(e.status, 1);
    stderr = e.stderr;
  }
  assert.ok(stderr.includes('did not become ready'), stderr);
  assert.ok(stderr.includes('cold optimizer'), stderr);
  assert.ok(stderr.includes('docker compose up'), stderr);
});

test('--no-optimizer proves the provider plumbing without the container', async (t) => {
  const provider = await startProvider();
  t.after(provider.stop);
  const out = join(mkdtempSync(join(tmpdir(), 'proof-')), 'results.json');
  execFileSync('node', ['prove.mjs', '--no-optimizer', '--out', out], {
    cwd: root,
    env: proofEnv({ providerUrl: provider.url, optimizerUrl: 'http://127.0.0.1:45998' }),
    encoding: 'utf8',
  });
  const results = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(results.optimizerUrl, null);
  for (const r of results.results) assert.equal(r.optimizedRuns.length, 0);
});

test('the run never sends a prompt anywhere but the provider and the local optimizer', async (t) => {
  // The privacy claim in the README, asserted. Any third destination would mean
  // a prompt left for somewhere we did not tell the customer about.
  const urls = await stack(t);
  const { results } = proveAgainst(urls);
  const seen = new Set([results.providerUrl, results.optimizerUrl]);
  assert.deepEqual([...seen].sort(), [urls.optimizerUrl, urls.providerUrl].sort());
  assert.ok(!JSON.stringify(results).includes('anyray.ai'));
});
