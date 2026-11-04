import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type VerificationCommandName = 'test' | 'lint' | 'typecheck' | 'build' | `check${number}`;

export interface VerificationCommand {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export type VerificationCommands = Partial<Record<VerificationCommandName, VerificationCommand>>;

export interface CommandEvidence {
  id: string;
  name: VerificationCommandName;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled?: boolean;
  stdout: string;
  stderr: string;
  stdoutTotalBytes: number;
  stderrTotalBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export interface GitEvidence {
  repoRoot: string;
  commit: string | null;
  branch: string | null;
  worktree: string;
  changedFiles: string[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface VerificationResult {
  commands: CommandEvidence[];
  git: GitEvidence | null;
  cancelled?: boolean;
}

export interface VerificationOptions {
  cwd?: string;
  commands?: VerificationCommands;
  maxOutputBytes?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  git?: boolean;
  signal?: AbortSignal;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  stdoutTotalBytes: number;
  stderrTotalBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled?: boolean;
  error?: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_NAMES: readonly VerificationCommandName[] = ['test', 'lint', 'typecheck', 'build'];

function boundedCollector(maxBytes: number) {
  let value = '';
  let storedBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  let ended = false;
  const decoder = new StringDecoder('utf8');
  return {
    append(chunk: Buffer | string) {
      if (ended) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      totalBytes += bytes.length;
      if (storedBytes >= maxBytes) {
        truncated = true;
        return;
      }
      const accepted = bytes.subarray(0, maxBytes - storedBytes);
      value += decoder.write(accepted);
      storedBytes += accepted.length;
      if (accepted.length < bytes.length) truncated = true;
    },
    value: () => {
      if (!ended) {
        value += decoder.end();
        ended = true;
      }
      return value;
    },
    truncated: () => truncated,
    bytes: () => totalBytes,
  };
}

function terminateProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => child.kill(signal));
    killer.once('exit', (code) => {
      if (code !== 0) child.kill(signal);
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const stdout = boundedCollector(options.maxOutputBytes);
    const stderr = boundedCollector(options.maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const emptyResult = (): ProcessResult => ({
      stdout: stdout.value(),
      stderr: stderr.value(),
      stdoutTotalBytes: stdout.bytes(),
      stderrTotalBytes: stderr.bytes(),
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
      exitCode: null,
      signal: null,
      timedOut,
      cancelled,
    });
    if (options.signal?.aborted) {
      cancelled = true;
      resolveResult(emptyResult());
      return;
    }
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: verificationEnv(options.env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const stopChild = () => {
      terminateProcessTree(child, 'SIGTERM');
      if (process.platform !== 'win32') {
        if (forceTimer) clearTimeout(forceTimer);
        forceTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 250);
        forceTimer.unref?.();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cancelled = true;
      stopChild();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.append(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult({
        stdout: stdout.value(),
        stderr: stderr.value(),
        stdoutTotalBytes: stdout.bytes(),
        stderrTotalBytes: stderr.bytes(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        exitCode: null,
        signal: null,
        timedOut,
        ...(cancelled ? { cancelled: true } : {}),
        error: error.message,
      });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult({
        stdout: stdout.value(),
        stderr: stderr.value(),
        stdoutTotalBytes: stdout.bytes(),
        stderrTotalBytes: stderr.bytes(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        exitCode,
        signal,
        timedOut,
        ...(cancelled ? { cancelled: true } : {}),
      });
    });
  });
}

function displayCommand(command: VerificationCommand): string {
  return [command.executable, ...(command.args ?? [])].join(' ');
}

async function containedCwd(root: string, requested?: string): Promise<string> {
  const base = await fs.realpath(root);
  const cwd = await fs.realpath(resolve(base, requested ?? '.'));
  const rel = relative(base, cwd);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`Verification cwd escapes the declared workspace: ${requested ?? cwd}`);
  }
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Verification cwd must be a directory');
  return cwd;
}

function verificationEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sensitive = /token|secret|password|cookie|authorization|api[-_]?key|private[-_]?key|credential/i;
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!sensitive.test(key) && value !== undefined) safe[key] = value;
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (sensitive.test(key)) throw new Error(`Verification environment refuses sensitive key ${key}`);
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

async function runCommand(
  name: VerificationCommandName,
  command: VerificationCommand,
  options: Required<Pick<VerificationOptions, 'cwd' | 'maxOutputBytes' | 'timeoutMs'>> &
    Pick<VerificationOptions, 'env' | 'signal'>,
): Promise<CommandEvidence> {
  const cwd = await containedCwd(options.cwd, command.cwd);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const result = await runProcess(command.executable, command.args ?? [], {
    cwd,
    env: options.env,
    timeoutMs: command.timeoutMs ?? options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    signal: options.signal,
  });
  const finished = Date.now();
  return {
    id: `verification_${randomUUID()}`,
    name,
    command: displayCommand(command),
    cwd,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    ...(result.cancelled ? { cancelled: true } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTotalBytes: result.stdoutTotalBytes,
    stderrTotalBytes: result.stderrTotalBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function runGit(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return runProcess('git', args, { cwd, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
}

function nulList(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

async function collectGitEvidence(cwd: string): Promise<GitEvidence | null> {
  const rootResult = await runGit(['rev-parse', '--show-toplevel'], cwd);
  if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) return null;
  const repoRoot = resolve(rootResult.stdout.trim());
  const [commit, branch, status, staged, unstaged] = await Promise.all([
    runGit(['rev-parse', 'HEAD'], repoRoot),
    runGit(['branch', '--show-current'], repoRoot),
    runGit(['status', '--porcelain=v1', '-z'], repoRoot),
    runGit(['diff', '--cached', '--name-only', '-z'], repoRoot),
    runGit(['diff', '--name-only', '-z'], repoRoot),
  ]);
  const statusEntries = nulList(status.stdout);
  const stagedFiles = nulList(staged.stdout);
  const unstagedFiles = nulList(unstaged.stdout);
  const untracked = statusEntries.filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3));
  const changedFiles = [...new Set([...stagedFiles, ...unstagedFiles, ...untracked])];
  return {
    repoRoot,
    commit: commit.exitCode === 0 ? commit.stdout.trim() || null : null,
    branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
    worktree: repoRoot,
    changedFiles,
    staged: stagedFiles,
    unstaged: [...new Set([...unstagedFiles, ...untracked])],
    untracked,
  };
}

export async function verify(options: VerificationOptions = {}): Promise<VerificationResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1)
    throw new RangeError('maxOutputBytes must be a positive integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError('timeoutMs must be a positive integer');
  const commands = options.commands ?? {};
  const results: CommandEvidence[] = [];
  for (const name of Object.keys(commands) as VerificationCommandName[]) {
    const command = commands[name];
    if (command && !options.signal?.aborted) {
      try {
        results.push(
          await runCommand(name, command, {
            cwd,
            maxOutputBytes,
            timeoutMs,
            env: options.env,
            signal: options.signal,
          }),
        );
      } catch (error) {
        if (!options.signal?.aborted) throw error;
      }
    }
  }
  const cancelled = options.signal?.aborted === true;
  return {
    commands: results,
    git: options.git === false || cancelled ? null : await collectGitEvidence(cwd),
    ...(cancelled ? { cancelled: true } : {}),
  };
}

export interface RepositoryDiffResult {
  cwd: string;
  diff: string;
  status: string;
  trust: 'repository_verified';
  untracked: string[];
  commit: string;
  repoRoot: string /** Declared truncation metadata (section 4): reviewers must know what they have not seen. */;
  diffTruncated: boolean;
  diffTotalBytes: number;
  statusTruncated: boolean;
  statusTotalBytes: number;
  untrackedTruncated: boolean;
  untrackedTotalBytes: number;
}
function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  let end = Math.min(bytes.length, maxBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end >= 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}
export async function repositoryDiff(cwd: string): Promise<RepositoryDiffResult> {
  const root = resolve(cwd);
  const rootResult = await runGit(['rev-parse', '--show-toplevel'], root);
  if (rootResult.exitCode !== 0 || !rootResult.stdout.trim())
    throw new Error(`No Git repository found for ${root}`);
  const repoRoot = resolve(rootResult.stdout.trim());
  const [diff, status, commit, untracked] = await Promise.all([
    runGit(['diff', 'HEAD', '--no-ext-diff', '--binary'], repoRoot),
    runGit(['status', '--short'], repoRoot),
    runGit(['rev-parse', 'HEAD'], repoRoot),
    runGit(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot),
  ]);
  if (diff.exitCode !== 0 || status.exitCode !== 0 || commit.exitCode !== 0)
    throw new Error(`Git evidence collection failed: ${diff.stderr || status.stderr || commit.stderr}`);
  return {
    cwd: root,
    repoRoot,
    commit: commit.stdout.trim(),
    diff: utf8Prefix(diff.stdout, DEFAULT_MAX_OUTPUT_BYTES),
    status: utf8Prefix(status.stdout, DEFAULT_MAX_OUTPUT_BYTES),
    untracked: nulList(untracked.stdout),
    trust: 'repository_verified',
    diffTruncated: diff.stdoutTruncated || diff.stdoutTotalBytes > DEFAULT_MAX_OUTPUT_BYTES,
    diffTotalBytes: diff.stdoutTotalBytes,
    statusTruncated: status.stdoutTruncated || status.stdoutTotalBytes > DEFAULT_MAX_OUTPUT_BYTES,
    statusTotalBytes: status.stdoutTotalBytes,
    untrackedTruncated: untracked.stdoutTruncated,
    untrackedTotalBytes: untracked.stdoutTotalBytes,
  };
}

function parseLegacyCommand(command: string): VerificationCommand {
  const tokens =
    command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ??
    [];
  const executable = tokens.shift();
  if (!executable || /[;&|<>`$]/.test(command)) throw new Error(`Unsafe verification command: ${command}`);
  return { executable, args: tokens };
}

export async function runVerification(cwd: string, commands: readonly string[]): Promise<CommandEvidence[]>;
export async function runVerification(options?: VerificationOptions): Promise<VerificationResult>;
export async function runVerification(
  first?: string | VerificationOptions,
  legacyCommands?: readonly string[],
): Promise<CommandEvidence[] | VerificationResult> {
  if (typeof first === 'string') {
    const commandNames: readonly VerificationCommandName[] = [
      'test',
      'lint',
      'typecheck',
      'build',
      'check1',
      'check2',
      'check3',
      'check4',
    ];
    const results: CommandEvidence[] = [];
    for (const [index, command] of (legacyCommands ?? []).entries()) {
      results.push(
        await runCommand(commandNames[index % commandNames.length]!, parseLegacyCommand(command), {
          cwd: resolve(first),
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          env: undefined,
        }),
      );
    }
    return results;
  }
  return verify(first);
}
