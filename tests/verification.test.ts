import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verify } from '../src/verification.js';

const node = process.execPath;
const nodeCommand = (script: string) => ({ executable: node, args: ['-e', script] });

test('runs configured commands safely and captures bounded evidence', async () => {
  const result = await verify({
    commands: {
      test: nodeCommand("process.stdout.write('0123456789'); process.stderr.write('failure detail'); process.exit(3)"),
    },
    maxOutputBytes: 5,
    git: false,
  });
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]?.name, 'test');
  assert.equal(result.commands[0]?.exitCode, 3);
  assert.equal(result.commands[0]?.stdout, '01234');
  assert.equal(result.commands[0]?.stderr, 'failu');
  assert.equal(result.commands[0]?.stdoutTruncated, true);
  assert.equal(result.commands[0]?.stderrTruncated, true);
  assert.match(result.commands[0]?.command ?? '', /-e/);
});

test('records timeout and does not invoke a shell', async () => {
  const result = await verify({
    commands: { lint: nodeCommand('setTimeout(() => {}, 1000)') },
    timeoutMs: 30,
    git: false,
  });
  assert.equal(result.commands[0]?.timedOut, true);
  assert.equal(result.commands[0]?.exitCode, null);
});

test('collects commit branch worktree staged and unstaged git evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-interop-verification-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'verification-test'], { cwd: directory, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'verification@example.invalid'], { cwd: directory, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Verification Test'], { cwd: directory, windowsHide: true });
    await writeFile(join(directory, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: directory, windowsHide: true });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: directory, windowsHide: true });
    await writeFile(join(directory, 'tracked.txt'), 'changed\n');
    await writeFile(join(directory, 'staged.txt'), 'staged\n');
    execFileSync('git', ['add', 'staged.txt'], { cwd: directory, windowsHide: true });
    await writeFile(join(directory, 'untracked.txt'), 'new\n');
    const result = await verify({ cwd: directory, git: true });
    assert.ok(result.git);
    assert.equal(result.git.branch, 'verification-test');
    assert.match(result.git.commit ?? '', /^[0-9a-f]{40}$/);
    assert.deepEqual(result.git.staged, ['staged.txt']);
    assert.deepEqual(result.git.unstaged.sort(), ['tracked.txt', 'untracked.txt']);
    assert.deepEqual(result.git.untracked, ['untracked.txt']);
    assert.deepEqual(result.git.changedFiles.sort(), ['staged.txt', 'tracked.txt', 'untracked.txt']);
    assert.equal(await readFile(join(directory, 'tracked.txt'), 'utf8'), 'changed\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('returns no git evidence outside a repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-interop-no-git-'));
  try {
    const result = await verify({ cwd: directory });
    assert.equal(result.git, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
