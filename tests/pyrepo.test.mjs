import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pyrepoScenario, defaultPyrepoRepo } from '../lib/pyrepo.mjs';

// A tiny stand-in for the Python repository: one commit, a few files in and out of scope.
function fakePyrepo(files) {
  const repo = mkdtempSync(join(tmpdir(), 'pyrepo-fake-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'fixture');
  return { repo, commit: git('rev-parse', 'HEAD') };
}

test('pyrepo-docs: loads only in-scope Python source from the pinned commit', () => {
  const { repo, commit } = fakePyrepo({
    'salt/client/__init__.py': 'class LocalClient: pass\n',
    'salt/minion.py': 'def handle_payload(): pass\n',
    'salt/client/README.md': 'not python\n',
    'salt/modules/pkg.py': 'out of scope\n',
  });
  const s = pyrepoScenario({ repo, commit });
  assert.deepEqual(Object.keys(s.files), ['salt/client/__init__.py', 'salt/minion.py']);
  assert.equal(s.name, 'pyrepo-docs');
  assert.ok(s.required.includes('LocalClient'));
  assert.ok(s.maxTokens >= 16000, 'the whole document rides in one finish call');
  assert.match(s.runner()('read', { path: 'salt/minion.py' }), /handle_payload/);
});

test('pyrepo-docs: a commit with no in-scope source is an error, not an empty task', () => {
  const { repo, commit } = fakePyrepo({ 'README.md': 'x\n' });
  assert.throws(() => pyrepoScenario({ repo, commit }), /no Python source/);
});

test('pyrepo-docs: the default checkout is found without a machine-specific path', () => {
  assert.equal(defaultPyrepoRepo({ PYREPO_REPO: '/opt/pyrepo' }), '/opt/pyrepo');
  const saved = process.env.TMPDIR;
  try {
    process.env.TMPDIR = '/tmp/elsewhere';
    assert.equal(defaultPyrepoRepo({}), '/tmp/elsewhere/anyray-bench-repos/https_github_com_saltstack_salt_git');
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
});
