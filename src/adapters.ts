import fs from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import type { Json } from './types.js';
import type { AgentAdapter, AgentCapabilities, AgentEvent, AgentSession, OperationReceipt, ProviderId } from './interop.js';

const now = () => new Date().toISOString();
const text = (v: unknown) => typeof v === 'string' ? v : undefined;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;
const cap = (supported: boolean, transport: string, protocol: string, reason?: string) => ({ supported, state: supported ? 'available' as const : 'unavailable' as const, transport, protocol, reason });

export class OpenCodeAdapter implements AgentAdapter {
  readonly id: ProviderId = 'opencode';
  private base: URL;
  private available = false;
  constructor(base = process.env.OPENCODE_SERVER_URL ?? 'http://127.0.0.1:4096') { this.base = new URL(base); }
  private async request<T>(method: string, route: string, body?: unknown): Promise<T> { const response = await fetch(new URL(route, this.base), { method, headers: { accept: 'application/json', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(1500) }); if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}`); return await response.json() as T; }
  async capabilities(): Promise<AgentCapabilities> { try { await this.request('GET', '/global/health'); this.available = true; } catch { try { await this.request('GET', '/session'); this.available = true; } catch { this.available = false; } } return { provider: this.id, adapterVersion: '0.1.0', authorization: this.available ? 'authorized' : 'unknown', discovery: cap(this.available, 'http', 'OpenCode server API', 'Start opencode serve or set OPENCODE_SERVER_URL'), sessions: cap(this.available, 'http', 'OpenCode session API'), sendMessage: cap(this.available, 'http', 'POST /session/:id/message'), steer: cap(this.available, 'http', 'POST /session/:id/prompt_async'), cancel: cap(this.available, 'http', 'POST /session/:id/abort'), events: cap(this.available, 'http', 'GET /event'), diff: cap(this.available, 'http', 'GET /session/:id/diff'), permissions: cap(this.available, 'http', 'POST /session/:id/permissions/:permissionID'), model: cap(this.available, 'http', 'session message model field'), reasoning: cap(false, 'http', 'provider dependent', 'OpenCode exposes model variants rather than a universal reasoning field'), limitations: ['Existing session attachment requires a reachable OpenCode server'] }; }
  async listSessions(): Promise<AgentSession[]> { const values = await this.request<unknown[]>('GET', '/session'); return values.map((v) => { const s = record(v); const id = text(s.id) ?? ''; return { id: `opencode:${id}`, nativeId: id, provider: this.id, projectId: text(s.projectID), title: text(s.title), state: text(s.status), model: text(record(s.model).id), cwd: text(record(s.location).directory), transport: 'http', provenance: { discoveredAt: now(), source: 'OpenCode /session', native: true as const } }; }).filter((s) => s.nativeId); }
  async getSession(nativeId: string): Promise<AgentSession | null> { try { const s = record(await this.request('GET', `/session/${encodeURIComponent(nativeId)}`)); return { id: `opencode:${nativeId}`, nativeId, provider: this.id, projectId: text(s.projectID), title: text(s.title), state: text(s.status), model: text(record(s.model).id), cwd: text(record(s.location).directory), transport: 'http', provenance: { discoveredAt: now(), source: 'OpenCode /session/:id', native: true as const } }; } catch { return null; } }
  async createSession(options: { cwd?: string; title?: string }): Promise<AgentSession> { const s = record(await this.request('POST', '/session', { title: options.title, directory: options.cwd })); return (await this.getSession(text(s.id) ?? ''))!; }
  async resumeSession(nativeId: string): Promise<AgentSession> { const session = await this.getSession(nativeId); if (!session) throw new Error(`OpenCode session ${nativeId} was not found`); return session; }
  async send(nativeId: string, value: string): Promise<OperationReceipt> { await this.request('POST', `/session/${encodeURIComponent(nativeId)}/prompt_async`, { parts: [{ type: 'text', text: value }] }); return { provider: this.id, nativeId, operation: 'send', accepted: true }; }
  async steer(nativeId: string, value: string): Promise<OperationReceipt> { return this.send(nativeId, value); }
  async cancel(nativeId: string): Promise<OperationReceipt> { const result = await this.request('POST', `/session/${encodeURIComponent(nativeId)}/abort`); return { provider: this.id, nativeId, operation: 'cancel', accepted: Boolean(result), detail: json(result) }; }
  async getDiff(nativeId: string): Promise<Json | null> { return json(await this.request('GET', `/session/${encodeURIComponent(nativeId)}/diff`)); }
  async respondPermission(nativeId: string, requestId: string, decision: string): Promise<OperationReceipt> { const result = await this.request('POST', `/session/${encodeURIComponent(nativeId)}/permissions/${encodeURIComponent(requestId)}`, { response: decision }); return { provider: this.id, nativeId, operation: 'permission', accepted: true, detail: json(result) }; }
  async setModel(nativeId: string, model: string): Promise<OperationReceipt> { await this.request('POST', `/session/${encodeURIComponent(nativeId)}/message`, { noReply: true, model, parts: [] }); return { provider: this.id, nativeId, operation: 'set_model', accepted: true }; }
  async *events(nativeId: string): AsyncIterable<AgentEvent> { const response = await fetch(new URL('/event', this.base), { headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(30_000) }); if (!response.ok || !response.body) throw new Error(`OpenCode event stream HTTP ${response.status}`); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let sequence = 0; try { while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const records = buffer.split(/\r?\n\r?\n/); buffer = records.pop() ?? ''; for (const recordValue of records) { const data = recordValue.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join(''); if (!data) continue; try { const parsed = JSON.parse(data) as unknown; const raw = record(parsed); const sessionId = text(raw.sessionID) ?? text(record(raw.properties).sessionID) ?? text(record(raw.info).sessionID); if (sessionId && sessionId !== nativeId) continue; yield { provider: this.id, nativeId, sequence: ++sequence, timestamp: now(), type: text(raw.type) ?? 'opencode.event', data: json(parsed) }; } catch { continue; } } } } finally { await reader.cancel(); } }
}

type RpcMessage = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
export type RpcRequest = (method: string, params?: unknown) => Promise<unknown>;

class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private sequence = 0;
  private closed = false;
  private notifications: RpcMessage[] = [];
  private notificationWaiters: Array<(message: RpcMessage | undefined) => void> = [];
  constructor(command: string, args: string[], cwd?: string) {
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => { try { this.receive(JSON.parse(line) as RpcMessage); } catch { /* Ignore provider diagnostics on stdout. */ } });
    const fail = (error: Error) => { this.closed = true; for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear(); };
    this.child.once('error', fail);
    this.child.once('exit', (code, signal) => fail(new Error(`native protocol exited (${code ?? signal ?? 'unknown'})`)));
  }
  private receive(message: RpcMessage) { if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) { const waiter = this.pending.get(message.id); if (!waiter) return; this.pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message ?? `JSON RPC error ${message.error.code ?? 'unknown'}`)); else waiter.resolve(message.result); return; } if (message.method) { const waiter = this.notificationWaiters.shift(); if (waiter) waiter(message); else { this.notifications.push(message); if (this.notifications.length > 500) this.notifications.shift(); } } }
  async nextNotification(timeoutMs = 30_000): Promise<RpcMessage | undefined> { const existing = this.notifications.shift(); if (existing) return existing; if (this.closed) return undefined; return new Promise((resolve) => { const timer = setTimeout(() => { const index = this.notificationWaiters.indexOf(resolve); if (index >= 0) this.notificationWaiters.splice(index, 1); resolve(undefined); }, timeoutMs); this.notificationWaiters.push((message) => { clearTimeout(timer); resolve(message); }); }); }
  async request(method: string, params?: unknown): Promise<unknown> { if (this.closed) throw new Error('native protocol is not connected'); const id = ++this.sequence; const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n'; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`JSON RPC request timed out: ${method}`)); }, 2500); this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); this.child.stdin.write(payload, (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } }); }); }
  close() { if (!this.closed) { this.closed = true; this.child.kill(); for (const waiter of this.notificationWaiters.splice(0)) waiter(undefined); } }
}

export interface NativeAdapterOptions { command?: string; args?: string[]; cwd?: string; rpc?: RpcRequest; }

abstract class NativeProtocolAdapter implements AgentAdapter {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  abstract readonly protocol: string;
  protected abstract readonly defaultCommand: string;
  protected abstract readonly defaultArgs: string[];
  private readonly options: NativeAdapterOptions;
  private rpc?: RpcRequest;
  private process?: JsonRpcProcess;
  private initialized = false;
  private failure?: string;
  private readonly sessions = new Map<string, AgentSession>();
  constructor(options: NativeAdapterOptions = {}) { this.options = options; this.rpc = options.rpc; }
  protected abstract initialize(): Promise<unknown>;
  protected abstract discover(): Promise<unknown[]>;
  protected abstract startSession(options: { cwd?: string; title?: string }): Promise<unknown>;
  protected abstract resume(nativeId: string): Promise<unknown>;
  protected abstract prompt(nativeId: string, value: string): Promise<unknown>;
  protected abstract interrupt(nativeId: string): Promise<unknown>;
  protected abstract sessionFrom(value: unknown, source: string): AgentSession | null;
  private async connect(): Promise<boolean> { if (this.initialized) return true; if (this.failure) return false; try { if (!this.rpc) { const command = this.options.command ?? this.defaultCommand; const args = this.options.args ?? this.defaultArgs; if (!this.options.command && !(await which(command))) throw new Error(`${this.label} executable was not found`); this.process = new JsonRpcProcess(command, args, this.options.cwd); this.rpc = this.process.request.bind(this.process); } await this.initialize(); this.initialized = true; return true; } catch (error) { this.failure = error instanceof Error ? error.message : String(error); this.process?.close(); return false; } }
  protected call(method: string, params?: unknown) { if (!this.rpc) throw new Error(`${this.label} native transport is unavailable`); return this.rpc(method, params); }
  async capabilities(): Promise<AgentCapabilities> { const ready = await this.connect(); const reason = ready ? undefined : this.failure ?? `${this.label} native transport is unavailable`; return { provider: this.id, adapterVersion: '0.2.0', authorization: ready ? 'unknown' : 'unauthorized', discovery: cap(ready, 'JSON RPC over stdio', this.protocol, reason), sessions: cap(ready, 'JSON RPC over stdio', this.protocol, reason), sendMessage: cap(ready, 'JSON RPC over stdio', this.protocol, reason), steer: cap(false, 'JSON RPC over stdio', this.protocol, 'Provider protocol has no distinct steer operation'), cancel: cap(ready, 'JSON RPC over stdio', this.protocol, reason), events: cap(ready, 'JSON RPC notifications', this.protocol, ready ? 'Events are live and not replayable after process restart' : reason), diff: cap(false, 'provider native protocol', this.protocol, 'Provider does not expose a stable native diff method'), permissions: cap(false, 'JSON RPC notifications', this.protocol, 'Permission handling is provider and request dependent'), model: cap(false, 'provider native protocol', this.protocol, 'Model selection is not standardized by this transport'), reasoning: cap(false, 'provider native protocol', this.protocol, 'Reasoning selection is not standardized by this transport'), limitations: ['Only documented JSON RPC methods are used', ...(ready ? [] : ['Native control is unavailable until the provider process starts and initializes successfully'])] }; }
  async listSessions(): Promise<AgentSession[]> { if (!await this.connect()) return []; try { const result = await this.discover(); return result.map((v) => this.sessionFrom(v, `${this.protocol} session discovery`)).filter((v): v is AgentSession => Boolean(v)); } catch { return [...this.sessions.values()]; } }
  async getSession(nativeId: string): Promise<AgentSession | null> { return this.sessions.get(nativeId) ?? null; }
  async createSession(options: { cwd?: string; title?: string }): Promise<AgentSession> { if (!await this.connect()) throw new Error(this.failure ?? `${this.label} native transport is unavailable`); const session = this.sessionFrom(await this.startSession(options), `${this.protocol} session/new`); if (!session) throw new Error(`${this.label} returned an invalid session`); this.sessions.set(session.nativeId, session); return session; }
  async resumeSession(nativeId: string): Promise<AgentSession> { if (!await this.connect()) throw new Error(this.failure ?? `${this.label} native transport is unavailable`); const session = this.sessionFrom(await this.resume(nativeId), `${this.protocol} session resume`); if (!session) throw new Error(`${this.label} returned an invalid session`); this.sessions.set(session.nativeId, session); return session; }
  async send(nativeId: string, value: string): Promise<OperationReceipt> { if (!await this.connect()) return { provider: this.id, nativeId, operation: 'send', accepted: false, detail: json({ reason: this.failure }) }; await this.prompt(nativeId, value); return { provider: this.id, nativeId, operation: 'send', accepted: true }; }
  async cancel(nativeId: string): Promise<OperationReceipt> { if (!await this.connect()) return { provider: this.id, nativeId, operation: 'cancel', accepted: false, detail: json({ reason: this.failure }) }; await this.interrupt(nativeId); return { provider: this.id, nativeId, operation: 'cancel', accepted: true }; }
  async *events(nativeId: string): AsyncIterable<AgentEvent> { if (!await this.connect()) return; let sequence = 0; while (this.process) { const message = await this.process.nextNotification(); if (!message) return; const raw = record(message.params); const candidate = text(raw.threadId) ?? text(raw.sessionId) ?? text(record(raw.thread).id); if (candidate && candidate !== nativeId) continue; yield { provider: this.id, nativeId, sequence: ++sequence, timestamp: now(), type: message.method ?? 'notification', data: json(raw) }; } }
  dispose() { this.process?.close(); this.process = undefined; this.rpc = undefined; this.initialized = false; }
}

export class CodexAdapter extends NativeProtocolAdapter {
  readonly id: ProviderId = 'codex'; readonly label = 'Codex'; readonly protocol = 'Codex App Server JSON RPC'; protected readonly defaultCommand = 'codex'; protected readonly defaultArgs = ['app-server', '--stdio'];
  constructor(options: NativeAdapterOptions = {}) { super({ ...options, command: options.command ?? process.env.CODEX_APP_SERVER_COMMAND }); }
  protected initialize() { return this.call('initialize', { clientInfo: { name: 'agent-interop-runtime', version: '0.2.0' }, capabilities: {} }); }
  protected async discover() { const result = record(await this.call('thread/list', {})); const threads = result.data ?? result.threads ?? result; return Array.isArray(threads) ? threads : []; }
  protected startSession(options: { cwd?: string; title?: string }) { return this.call('thread/start', { ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.title ? { name: options.title } : {}) }); }
  protected resume(nativeId: string) { return this.call('thread/resume', { threadId: nativeId }); }
  protected prompt(nativeId: string, value: string) { return this.call('turn/start', { threadId: nativeId, input: [{ type: 'text', text: value }] }); }
  protected interrupt(nativeId: string) { return this.call('turn/interrupt', { threadId: nativeId }); }
  protected sessionFrom(value: unknown, source: string): AgentSession | null { const s = record(record(value).thread ?? value); const id = text(s.id) ?? text(s.threadId); if (!id) return null; return { id: `codex:${id}`, nativeId: id, provider: this.id, title: text(s.name) ?? text(s.title), state: text(s.status), model: text(s.model), cwd: text(s.cwd), transport: 'stdio', provenance: { discoveredAt: now(), source, native: true } }; }
}

export class ClaudeCodeAdapter extends NativeProtocolAdapter {
  readonly id: ProviderId = 'claude-code'; readonly label = 'Claude Code'; readonly protocol = 'Agent Client Protocol'; protected readonly defaultCommand = process.env.CLAUDE_ACP_COMMAND ?? 'claude-code-acp'; protected readonly defaultArgs: string[] = [];
  protected initialize() { return this.call('initialize', { protocolVersion: 1, clientInfo: { name: 'agent-interop-runtime', version: '0.2.0' }, clientCapabilities: {} }); }
  protected async discover() { return []; }
  protected startSession(options: { cwd?: string; title?: string }) { return this.call('session/new', { ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.title ? { title: options.title } : {}) }); }
  protected resume(nativeId: string) { return this.call('session/load', { sessionId: nativeId }); }
  protected prompt(nativeId: string, value: string) { return this.call('session/prompt', { sessionId: nativeId, prompt: [{ type: 'text', text: value }] }); }
  protected interrupt(nativeId: string) { return this.call('session/cancel', { sessionId: nativeId }); }
  protected sessionFrom(value: unknown, source: string): AgentSession | null { const s = record(record(value).session ?? value); const id = text(s.sessionId) ?? text(s.id); if (!id) return null; return { id: `claude-code:${id}`, nativeId: id, provider: this.id, title: text(s.title), state: text(s.status), cwd: text(s.cwd), transport: 'stdio', provenance: { discoveredAt: now(), source, native: true } }; }
}

export class AcpSessionAdapter extends ClaudeCodeAdapter {}

async function which(command: string): Promise<string | undefined> { const dirs = (process.env.Path ?? process.env.PATH ?? '').split(path.delimiter); for (const dir of dirs) for (const name of process.platform === 'win32' ? [command, `${command}.cmd`, `${command}.exe`] : [command]) { const file = path.join(dir, name); try { await fs.access(file); return file; } catch {} } return undefined; }
