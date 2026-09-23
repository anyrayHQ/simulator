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

test('a workload with no facts declared is rejected before any call is billed', () => {
  const out = execFileSync('node', ['prove.mjs', '--dry-run'], { cwd: root, encoding: 'utf8' });
  assert.ok(out.includes('required fact'));
});
