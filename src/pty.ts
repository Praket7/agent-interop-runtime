import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { assertSafeId } from './security.js';
import type { ThreadProgressEvent, ThreadProgressSnapshot } from './types.js';

export interface CliSessionSnapshot { id: string; conversationId?: string; pid: number; output: string; exited: boolean; exitCode?: number; progress: ThreadProgressSnapshot; }
export interface PtyDiagnostics { ok: boolean; node: string; platform: string; nodePty: string; error?: string; }

export async function probePty(): Promise<PtyDiagnostics> {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/echo';
  const args = process.platform === 'win32' ? ['/d', '/c', 'echo pty-probe'] : ['pty-probe'];
  try {
    const term = pty.spawn(command, args, { name: 'xterm-256color', cols: 80, rows: 24, ...(process.platform === 'win32' ? { useConpty: true } : {}), env: { ...process.env, TERM: 'xterm-256color' } });
    const result = await new Promise<PtyDiagnostics>((resolve) => { let output = ''; const timer = setTimeout(() => { try { term.kill(); } catch {} resolve({ ok: false, node: process.version, platform: process.platform, nodePty: '1.2.0-beta.14', error: 'PTY probe timed out' }); }, 1500); term.onData((data) => { output += data; }); term.onExit(({ exitCode }) => { clearTimeout(timer); resolve(exitCode === 0 ? { ok: true, node: process.version, platform: process.platform, nodePty: '1.2.0-beta.14' } : { ok: false, node: process.version, platform: process.platform, nodePty: '1.2.0-beta.14', error: `probe exited with code ${exitCode}; output ${output.slice(-200)}` }); }); });
    return result;
  } catch (error) { return { ok: false, node: process.version, platform: process.platform, nodePty: '1.2.0-beta.14', error: error instanceof Error ? error.message : String(error) }; }
}

function cliCandidates(): string[] {
  const home = os.homedir();
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap((entry) => [path.join(entry, process.platform === 'win32' ? 'freebuff.exe' : 'freebuff'), path.join(entry, 'freebuff')]);
  return [process.env.FREEBUFF_CLI_PATH ?? '', path.join(home, '.config', 'manicode', 'freebuff.exe'), path.join(home, '.config', 'manicode', 'freebuff'), ...pathEntries].filter(Boolean);
}

export async function findFreebuffCli(): Promise<string | null> {
  for (const candidate of cliCandidates()) { try { const stat = await fs.stat(candidate); if (stat.isFile()) { if (process.platform !== 'win32') await fs.access(candidate, fs.constants.X_OK); return candidate; } } catch { /* try next */ } }
  return null;
}

export async function findLatestCliConversationId(cwd: string, minimumMtimeMs = 0): Promise<string | null> {
  const key = process.env.FREEBUFF_PROJECT_KEY ?? `${path.basename(cwd)}--${(await import('node:crypto')).createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12)}`;
  const roots = [path.join(os.homedir(), '.config', 'manicode', 'projects', key, 'chats'), path.join(os.homedir(), '.config', 'manicode', 'projects', path.basename(cwd), 'chats')];
  const candidates: Array<{ id: string; mtimeMs: number }> = [];
  for (const chats of roots) try {
    const entries = await fs.readdir(chats, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9._:-]{1,200}$/.test(entry.name)) continue;
      const dir = path.join(chats, entry.name);
      const [meta, state, log] = await Promise.all([fs.stat(path.join(dir, 'chat-meta.json')).catch(() => null), fs.stat(path.join(dir, 'run-state.json')).catch(() => null), fs.stat(path.join(dir, 'log.jsonl')).catch(() => null)]);
      const mtimeMs = Math.max(meta?.mtimeMs ?? 0, state?.mtimeMs ?? 0, log?.mtimeMs ?? 0);
      if (log && mtimeMs >= minimumMtimeMs) candidates.push({ id: entry.name, mtimeMs });
    }
  } catch { /* try the legacy project key */ }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.id ?? null;
}
function visibleTerminalText(value: string): string { return value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); }
function cliReady(output: string): boolean {
  const visible = visibleTerminalText(output);
  const configured = process.env.FREEBUFF_CLI_READY_PATTERN;
  if (configured) { try { return new RegExp(configured, 'i').test(visible); } catch { /* fall back to safe built in markers */ } }
  return /Enter a coding task|coding task|Freebuff|manicode|press .* to (send|submit)|[❯>]\s*$/im.test(visible);
}

export class CliPtyManager {
  private sessions = new Map<string, { term: pty.IPty; cwd: string; startedAt: number; conversationId?: string; output: string; exited: boolean; exitCode?: number; events: ThreadProgressEvent[]; sequence: number; state: ThreadProgressEvent['state'] }>();
  private progress(id: string, state: ThreadProgressEvent['state'], text?: string, error?: string): ThreadProgressSnapshot { const session = this.sessions.get(id); if (!session) throw new Error('FREEBUFF_CLI_SESSION_NOT_FOUND'); const event: ThreadProgressEvent = { sequence: ++session.sequence, threadId: id, timestamp: new Date().toISOString(), kind: error ? 'failed' : state === 'completed' ? 'completed' : state === 'running' ? 'turn_state' : 'unknown', state, text, error }; session.events.push(event); if (session.events.length > 200) session.events.shift(); return { threadId: id, currentState: state, events: [...session.events], nextSequence: session.sequence + 1, connected: !session.exited, stale: false, latestEventAt: event.timestamp, phase: state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : state === 'running' ? 'unknown' : 'unknown', lastMeaningfulUpdate: event.timestamp, lastError: error }; }
  private snapshotState(id: string) { const session = this.sessions.get(id); if (!session) throw new Error('FREEBUFF_CLI_SESSION_NOT_FOUND'); return { id, conversationId: session.conversationId, pid: session.term.pid, output: session.output, exited: session.exited, exitCode: session.exitCode, progress: { threadId: id, currentState: session.state, events: [...session.events], nextSequence: session.sequence + 1, connected: !session.exited, stale: false } }; }
  async start(id: string, cwd: string, continueId?: string): Promise<CliSessionSnapshot> {
    const safeId = assertSafeId(id);
    const existing = this.sessions.get(safeId);
    if (existing && !existing.exited) return this.snapshotState(safeId);
    if (existing?.exited) this.sessions.delete(safeId);
    const file = await findFreebuffCli();
    if (!file) throw new Error('FREEBUFF_CLI_NOT_INSTALLED');
    const args = ['--cwd', cwd];
    if (continueId) args.push('--continue', assertSafeId(continueId));
    const startedAt = Date.now();
    let term: pty.IPty;
    try { term = pty.spawn(file, args, { name: 'xterm-256color', cols: 160, rows: 48, cwd, ...(process.platform === 'win32' ? { useConpty: true } : {}), env: { ...process.env, TERM: 'xterm-256color' } }); } catch (error) { throw new Error(`FREEBUFF_PTY_START_FAILED: ${error instanceof Error ? error.message : String(error)}. Verify node-pty was rebuilt for ${process.version} with 'pnpm rebuild node-pty' and that the CLI is executable.`); }
    const state = { term, cwd, startedAt, conversationId: continueId, output: '', exited: false, exitCode: undefined as number | undefined, events: [] as ThreadProgressEvent[], sequence: 0, state: 'queued' as ThreadProgressEvent['state'] };
    this.sessions.set(safeId, state);
    term.onData((data) => { state.output = (state.output + data).slice(-2_000_000); if (/error|failed|not authenticated/i.test(data)) { state.state = 'failed'; this.progress(safeId, 'failed', data.slice(-500), data.slice(-500)); } else if (/completed|finished|done/i.test(data)) { state.state = 'completed'; this.progress(safeId, 'completed', data.slice(-500)); } });
    term.onExit(({ exitCode }) => { state.exited = true; state.exitCode = exitCode; if (exitCode !== 0) { state.state = 'failed'; this.progress(safeId, 'failed', undefined, `Freebuff CLI exited with code ${exitCode}`); } });
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !cliReady(state.output) && !/Not authenticated|Press ENTER to login/i.test(visibleTerminalText(state.output))) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    if (/Freebuff is already running/i.test(state.output) && process.env.FREEBUFF_CLI_TAKEOVER === '1') {
      term.write('\r');
      const takeoverDeadline = Date.now() + 8_000;
      while (Date.now() < takeoverDeadline && !cliReady(state.output)) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (/Freebuff is already running/i.test(visibleTerminalText(state.output)) && !cliReady(state.output)) { term.kill(); this.sessions.delete(safeId); throw new Error('FREEBUFF_CLI_ALREADY_RUNNING'); }
    if (/Not authenticated|Press ENTER to login/i.test(visibleTerminalText(state.output))) { term.kill(); this.sessions.delete(safeId); throw new Error('FREEBUFF_CLI_NOT_AUTHENTICATED'); }
    if (state.exited) { this.sessions.delete(safeId); throw new Error(`FREEBUFF_CLI_EXITED: exit code ${state.exitCode ?? 'unknown'}`); }
    if (!cliReady(state.output)) { term.kill(); this.sessions.delete(safeId); throw new Error(`FREEBUFF_CLI_STARTUP_TIMEOUT: no machine readable readiness marker was detected. Set FREEBUFF_CLI_READY_PATTERN if this CLI exposes a custom marker. Output: ${visibleTerminalText(state.output).slice(-500)}`); }
    state.conversationId ??= (await findLatestCliConversationId(cwd, startedAt - 1000)) ?? undefined;
    return this.snapshotState(safeId);
  }
  async send(id: string, text: string, cwd = process.cwd(), continueId?: string): Promise<CliSessionSnapshot> {
    if (!text || text.length > 100_000) throw new Error('Message must be 1 to 100000 characters');
    const session = await this.start(id, cwd, continueId);
    const state = this.sessions.get(assertSafeId(id));
    if (!state || state.exited) throw new Error('FREEBUFF_CLI_SESSION_EXITED');
    state.state = 'queued'; this.progress(assertSafeId(id), 'queued');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const clean = text.replace(/[\r\n]+/g, ' ');
    state.term.write('\x15');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    state.term.write(`\x1b[200~${clean}\x1b[201~`);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    state.term.write('\r');
    state.state = 'running'; this.progress(assertSafeId(id), 'running');
    state.conversationId ??= (await findLatestCliConversationId(cwd, state.startedAt - 1000)) ?? undefined;
    return this.snapshotState(assertSafeId(id));
  }
  async sendToLatest(id: string, text: string, cwd = process.cwd()): Promise<CliSessionSnapshot> { return this.send(id, text, cwd, (await findLatestCliConversationId(cwd)) ?? undefined); }
  async resumeLatest(id: string, cwd = process.cwd()): Promise<CliSessionSnapshot> { return this.send(id, '/resume', cwd, (await findLatestCliConversationId(cwd)) ?? undefined); }
  stop(id: string): CliSessionSnapshot {
    const state = this.sessions.get(assertSafeId(id));
    if (!state) throw new Error('FREEBUFF_CLI_SESSION_NOT_FOUND');
    state.term.write('\x1b');
    return this.snapshotState(assertSafeId(id));
  }
  snapshot(id: string): CliSessionSnapshot { return this.snapshotState(assertSafeId(id)); }
  dispose(): void { for (const state of this.sessions.values()) { if (!state.exited) state.term.kill(); } this.sessions.clear(); }
}
