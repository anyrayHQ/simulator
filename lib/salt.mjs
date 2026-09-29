// A documentation task over real Salt source, read from a pinned Git commit.
// The checkout stays untouched; every arm receives the same in-memory files.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, runTool } from './world.mjs';

export const SALT_COMMIT = 'f37cdcd1c93f778a84f83b3cc9933cac92d0456b';
const SALT_GIT = 'https://github.com/saltstack/salt.git';

/** $SALT_REPO, else a clone cache in the temp dir (shared with anyrayHQ/benchmarks). */
export function defaultSaltRepo(env = process.env) {
  return env.SALT_REPO || join(tmpdir(), 'anyray-bench-repos', 'https_github_com_saltstack_salt_git');
}

function ensureClone(repo, commit) {
  if (!existsSync(repo)) execFileSync('git', ['clone', '-q', SALT_GIT, repo], { stdio: 'inherit' });
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' });
  } catch {
    execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin'], { stdio: 'inherit' });
  }
}
const MAX_BYTES = 3_000_000;
const PATHS = [
  'salt/client/', 'salt/loader/', 'salt/transport/',
  'salt/master.py', 'salt/minion.py', 'salt/modules/test.py',
  'salt/utils/event.py', 'salt/cli/salt.py', 'salt/scripts.py', 'salt/payload.py',
];

export function saltScenario({ repo, commit = SALT_COMMIT } = {}) {
  if (!repo) {
    repo = defaultSaltRepo();
    ensureClone(repo, commit);
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: MAX_BYTES });
  // ls-tree naturally skips requested paths that do not exist at this commit.
  const paths = git('ls-tree', '-r', '--name-only', '-z', commit, '--', ...PATHS)
    .split('\0').filter((p) => p.endsWith('.py')).sort();
  const files = {};
  let bytes = 0;
  for (const path of paths) {
    const content = git('show', `${commit}:${path}`);
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_BYTES) throw new Error(`salt-docs source exceeds ${MAX_BYTES} bytes`);
    files[path] = content;
  }
  if (!paths.length) throw new Error(`salt-docs found no Python source at ${commit}`);

  return {
    name: 'salt-docs',
    task:
      "Write developer documentation for an engineer joining the team: how `salt '*' test.ping` travels from the CLI through the master to a minion, " +
      'how the loader discovers and loads execution modules (what __virtual__ and dunder globals like __salt__ and __opts__ do), ' +
      'and how the return gets back to the CLI. Output Markdown with a section per stage and cite path:line for every claim. When done, call `finish` with the full Markdown as your answer.',
    // The whole document rides in one finish call; the 4096 default truncated it to an empty answer.
    maxTokens: 16000,
    required: ['LocalClient', '__virtual__', '__salt__', 'LazyLoader', 'minion.py'],
    followups: [],
    files,
    tools: TOOLS,
    runner: () => (name, input) => runTool(files, name, input),
  };
}
