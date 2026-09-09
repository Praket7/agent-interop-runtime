import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

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
  stdout: string;
  stderr: string;
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
}

export interface VerificationOptions {
  cwd?: string;
  commands?: VerificationCommands;
  maxOutputBytes?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  git?: boolean;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_NAMES: readonly VerificationCommandName[] = ['test', 'lint', 'typecheck', 'build'];

function boundedCollector(maxBytes: number) {
  let value = '';
  let size = 0;
  let truncated = false;
  return {
    append(chunk: Buffer | string) {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const remaining = maxBytes - size;
      if (Buffer.byteLength(text, 'utf8') > remaining) {
        value += Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
        size = maxBytes;
        truncated = true;
      } else {
        value += text;
        size += Buffer.byteLength(text, 'utf8');
      }
    },
    value: () => value,
    truncated: () => truncated,
    bytes: () => size,
  };
}

function runProcess(executable: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const stdout = boundedCollector(options.maxOutputBytes);
    const stderr = boundedCollector(options.maxOutputBytes);
    let settled = false;
    let exited = false;
    let timedOut = false;
    const child = spawn(executable, [...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, shell: false, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 250);
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.append(chunk));
    child.on('error', (error) => {
      if (settled) return;
      exited = true;
      settled = true;
      clearTimeout(timer);
      resolveResult({ stdout: stdout.value(), stderr: stderr.value(), stdoutTruncated: stdout.truncated(), stderrTruncated: stderr.truncated(), exitCode: null, signal: null, timedOut, error: error.message });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      exited = true;
      settled = true;
      clearTimeout(timer);
      resolveResult({ stdout: stdout.value(), stderr: stderr.value(), stdoutTruncated: stdout.truncated(), stderrTruncated: stderr.truncated(), exitCode, signal, timedOut });
    });
  });
}

function displayCommand(command: VerificationCommand): string {
  return [command.executable, ...(command.args ?? [])].join(' ');
}

async function runCommand(name: VerificationCommandName, command: VerificationCommand, options: Required<Pick<VerificationOptions, 'cwd' | 'maxOutputBytes' | 'timeoutMs'>> & Pick<VerificationOptions, 'env'>): Promise<CommandEvidence> {
  const cwd = resolve(options.cwd, command.cwd ?? '.');
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const result = await runProcess(command.executable, command.args ?? [], { cwd, env: options.env, timeoutMs: command.timeoutMs ?? options.timeoutMs, maxOutputBytes: options.maxOutputBytes });
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
    stdout: result.stdout,
    stderr: result.stderr,
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
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new RangeError('maxOutputBytes must be a positive integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer');
  const commands = options.commands ?? {};
  const results: CommandEvidence[] = [];
  for (const name of Object.keys(commands) as VerificationCommandName[]) {
    const command = commands[name];
    if (command) results.push(await runCommand(name, command, { cwd, maxOutputBytes, timeoutMs, env: options.env }));
  }
  return { commands: results, git: options.git === false ? null : await collectGitEvidence(cwd) };
}

export interface RepositoryDiffResult { cwd: string; diff: string; status: string; trust: 'repository_verified'; untracked: string[]; commit: string; repoRoot: string; /** Declared truncation metadata (section 4): reviewers must know what they have not seen. */ diffTruncated: boolean; diffTotalBytes: number; statusTruncated: boolean; statusTotalBytes: number; }
export async function repositoryDiff(cwd: string): Promise<RepositoryDiffResult> {
  const root = resolve(cwd);
  const rootResult = await runGit(['rev-parse', '--show-toplevel'], root);
  if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) throw new Error(`No Git repository found for ${root}`);
  const repoRoot = resolve(rootResult.stdout.trim());
  const [diff, status, commit, untracked] = await Promise.all([runGit(['diff', 'HEAD', '--no-ext-diff', '--binary'], repoRoot), runGit(['status', '--short'], repoRoot), runGit(['rev-parse', 'HEAD'], repoRoot), runGit(['ls-files', '--others', '--exclude-standard'], repoRoot)]);
  if (diff.exitCode !== 0 || status.exitCode !== 0 || commit.exitCode !== 0) throw new Error(`Git evidence collection failed: ${diff.stderr || status.stderr || commit.stderr}`);
  return { cwd: root, repoRoot, commit: commit.stdout.trim(), diff: diff.stdout.slice(0, DEFAULT_MAX_OUTPUT_BYTES), status: status.stdout.slice(0, DEFAULT_MAX_OUTPUT_BYTES), untracked: untracked.stdout.split(/\r?\n/).filter(Boolean), trust: 'repository_verified', diffTruncated: diff.stdout.length > DEFAULT_MAX_OUTPUT_BYTES, diffTotalBytes: diff.stdout.length, statusTruncated: status.stdout.length > DEFAULT_MAX_OUTPUT_BYTES, statusTotalBytes: status.stdout.length };
}

function parseLegacyCommand(command: string): VerificationCommand {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  const executable = tokens.shift();
  if (!executable || /[;&|<>`$]/.test(command)) throw new Error(`Unsafe verification command: ${command}`);
  return { executable, args: tokens };
}

export async function runVerification(cwd: string, commands: readonly string[]): Promise<CommandEvidence[]>;
export async function runVerification(options?: VerificationOptions): Promise<VerificationResult>;
export async function runVerification(first?: string | VerificationOptions, legacyCommands?: readonly string[]): Promise<CommandEvidence[] | VerificationResult> {
  if (typeof first === 'string') {
    const commandNames: readonly VerificationCommandName[] = ['test', 'lint', 'typecheck', 'build', 'check1', 'check2', 'check3', 'check4'];
    const results: CommandEvidence[] = [];
    for (const [index, command] of (legacyCommands ?? []).entries()) {
      results.push(await runCommand(commandNames[index % commandNames.length]!, parseLegacyCommand(command), { cwd: resolve(first), maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, timeoutMs: DEFAULT_TIMEOUT_MS, env: undefined }));
    }
    return results;
  }
  return verify(first);
}
