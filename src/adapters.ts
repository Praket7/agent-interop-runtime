import fs from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import type { Json } from './types.js';
import type { AgentAdapter, AgentCapabilities, AgentEvent, AgentSession, OperationReceipt, ProviderId, AgentSendOptions, ModelSelection } from './interop.js';
import { VERSION } from './version.js';
import { safeProjectPath } from './security.js';

const now = () => new Date().toISOString();
const text = (v: unknown) => typeof v === 'string' ? v : undefined;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;
const cap = (supported: boolean, transport: string, protocol: string, reason?: string) => ({ supported, state: supported ? 'available' as const : 'unavailable' as const, transport, protocol, reason });

export class OpenCodeAdapter implements AgentAdapter {
  readonly id: ProviderId = 'opencode';
  private base: URL;
  private available = false;
  private lastError?: string;
  private readonly eventSequences = new Map<string, number>();
  constructor(base = process.env.OPENCODE_SERVER_URL ?? 'http://127.0.0.1:4096') { this.base = new URL(base); }
  private get remoteWithoutAuth(): boolean { return !['127.0.0.1', 'localhost', '::1'].includes(this.base.hostname) && !(process.env.OPENCODE_SERVER_USERNAME && process.env.OPENCODE_SERVER_PASSWORD); }
  private async request<T>(method: string, route: string, body?: unknown): Promise<T> { if (this.remoteWithoutAuth) throw new Error('OpenCode remote endpoint requires OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD'); const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' }; const username = process.env.OPENCODE_SERVER_USERNAME; const password = process.env.OPENCODE_SERVER_PASSWORD; if (username && password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`; const response = await fetch(new URL(route, this.base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(1500) }); if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}`); const raw = await response.text(); return (raw ? JSON.parse(raw) : undefined) as T; }
  async capabilities(): Promise<AgentCapabilities> { this.lastError = undefined; try { await this.request('GET', '/global/health'); this.available = true; } catch (first) { try { const sessions = await this.request<unknown>('GET', '/session'); if (!Array.isArray(sessions)) throw new Error('OpenCode /session returned malformed response'); this.available = true; } catch (error) { this.available = false; this.lastError = error instanceof Error ? error.message : String(error); } } const reason = this.available ? undefined : this.lastError ?? 'Start opencode serve --hostname 127.0.0.1 --port 4096 or set OPENCODE_SERVER_URL'; return { provider: this.id, adapterVersion: VERSION, authorization: this.available ? 'authorized' : 'unknown', discovery: cap(this.available, 'http', 'OpenCode server API', reason), sessions: cap(this.available, 'http', 'OpenCode session API', reason), sendMessage: cap(this.available, 'http', 'POST /session/:id/prompt_async; transport acceptance only', reason), steer: cap(this.available, 'http', 'POST /session/:id/prompt_async; transport acceptance only', reason), cancel: cap(this.available, 'http', 'POST /session/:id/abort', reason), events: cap(this.available, 'http', 'GET /event with reconnect', reason), diff: cap(this.available, 'http', 'GET /session/:id/diff', reason), permissions: cap(this.available, 'http', 'POST /session/:id/permissions/:permissionID', reason), model: cap(this.available, 'http', 'POST /session/:id/model', this.available ? undefined : reason), reasoning: cap(false, 'http', 'provider API', 'OpenCode reasoning is provider specific. Use the model variant field when supported.'), limitations: ['Existing session attachment requires a reachable OpenCode server', 'Accepted means the OpenCode HTTP endpoint accepted the prompt; it does not mean the agent completed it'] }; }
  async listSessions(): Promise<AgentSession[]> { const values = await this.request<unknown>('GET', '/session'); if (!Array.isArray(values)) throw new Error('OpenCode /session returned malformed response'); return values.map((v) => { const s = record(v); const id = text(s.id) ?? ''; return { id: `opencode:${id}`, nativeId: id, provider: this.id, projectId: text(s.projectID), title: text(s.title), state: text(s.status), model: text(record(s.model).id), cwd: text(record(s.location).directory), transport: 'http', provenance: { discoveredAt: now(), source: 'OpenCode /session', native: true as const } }; }).filter((s) => s.nativeId); }
  async getSession(nativeId: string): Promise<AgentSession | null> { try { const s = record(await this.request('GET', `/session/${encodeURIComponent(nativeId)}`)); return { id: `opencode:${nativeId}`, nativeId, provider: this.id, projectId: text(s.projectID), title: text(s.title), state: text(s.status), model: text(record(s.model).id), cwd: text(record(s.location).directory), transport: 'http', provenance: { discoveredAt: now(), source: 'OpenCode /session/:id', native: true as const } }; } catch (error) { if (error instanceof Error && /HTTP 404/.test(error.message)) return null; throw error; } }
  async createSession(options: { cwd?: string; title?: string }): Promise<AgentSession> { const s = record(await this.request('POST', '/session', { title: options.title, directory: options.cwd })); return (await this.getSession(text(s.id) ?? ''))!; }
  async resumeSession(nativeId: string): Promise<AgentSession> { const session = await this.getSession(nativeId); if (!session) throw new Error(`OpenCode session ${nativeId} was not found`); return session; }
  async send(nativeId: string, value: string, options?: AgentSendOptions): Promise<OperationReceipt> { if (options?.reasoning) throw new Error('OpenCode reasoning control is not supported by this adapter; use an OpenCode agent or model explicitly'); const model = options?.model ? { providerID: options.model.providerID, id: options.model.modelID, ...(options.model.variant ? { variant: options.model.variant } : {}) } : undefined; await this.request('POST', `/session/${encodeURIComponent(nativeId)}/prompt_async`, { ...(model ? { model } : {}), ...(options?.agent ? { agent: options.agent } : {}), parts: [{ type: 'text', text: value }] }); return { provider: this.id, nativeId, operation: 'send', accepted: true, status: 'queued', providerState: 'transport_accepted', detail: json({ delivery: 'transport_accepted', completion: 'not_observed' }) }; }
  async steer(nativeId: string, value: string, options?: AgentSendOptions): Promise<OperationReceipt> { return this.send(nativeId, value, options); }
  async cancel(nativeId: string): Promise<OperationReceipt> { const result = await this.request('POST', `/session/${encodeURIComponent(nativeId)}/abort`); return { provider: this.id, nativeId, operation: 'cancel', accepted: Boolean(result), detail: json(result) }; }
  async getDiff(nativeId: string): Promise<Json | null> { return json(await this.request('GET', `/session/${encodeURIComponent(nativeId)}/diff`)); }
  async respondPermission(nativeId: string, requestId: string, decision: string): Promise<OperationReceipt> { const result = await this.request('POST', `/session/${encodeURIComponent(nativeId)}/permissions/${encodeURIComponent(requestId)}`, { response: decision }); return { provider: this.id, nativeId, operation: 'permission', accepted: true, detail: json(result) }; }
  async setModel(nativeId: string, selection: ModelSelection): Promise<OperationReceipt> { const model = typeof selection === 'string' ? { providerID: selection.split('/')[0] ?? 'opencode', id: selection.split('/').slice(1).join('/') || selection } : { providerID: selection.providerID, id: selection.modelID, ...(selection.variant ? { variant: selection.variant } : {}) }; await this.request('POST', `/session/${encodeURIComponent(nativeId)}/model`, { model }); return { provider: this.id, nativeId, operation: 'set_model', accepted: true, status: 'completed', providerState: 'configuration_applied', detail: json({ model }) }; }
  async *events(nativeId: string): AsyncIterable<AgentEvent> { let failures = 0; while (true) { try { if (this.remoteWithoutAuth) throw new Error('OpenCode remote endpoint requires credentials'); const headers: Record<string, string> = { accept: 'text/event-stream' }; const username = process.env.OPENCODE_SERVER_USERNAME; const password = process.env.OPENCODE_SERVER_PASSWORD; if (username && password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`; const response = await fetch(new URL('/event', this.base), { headers, signal: AbortSignal.timeout(30_000) }); if (!response.ok || !response.body) throw new Error(`OpenCode event stream HTTP ${response.status}`); failures = 0; const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; try { while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const records = buffer.split(/\r?\n\r?\n/); buffer = records.pop() ?? ''; for (const recordValue of records) { const data = recordValue.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join(''); if (!data) continue; try { const parsed = JSON.parse(data) as unknown; const raw = record(parsed); const sessionId = text(raw.sessionID) ?? text(record(raw.properties).sessionID) ?? text(record(raw.info).sessionID); if (sessionId && sessionId !== nativeId) continue; const sequence = (this.eventSequences.get(nativeId) ?? 0) + 1; this.eventSequences.set(nativeId, sequence); yield { provider: this.id, nativeId, sequence, timestamp: now(), type: text(raw.type) ?? 'opencode.event', data: json(parsed) }; } catch { continue; } } } } finally { await reader.cancel(); } } catch (error) { if (++failures >= 3) throw error; await new Promise((resolve) => setTimeout(resolve, failures * 250)); } } }
}

type RpcMessage = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
export type RpcRequest = (method: string, params?: unknown) => Promise<unknown>;
type RpcServerRequestHandler = (message: RpcMessage) => Promise<unknown>;

class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private sequence = 0;
  private closed = false;
  private notifications: RpcMessage[] = [];
  private diagnostics = '';
  private notificationWaiters: Array<(message: RpcMessage | undefined) => void> = [];
  constructor(command: string, args: string[], cwd?: string, private readonly serverRequest?: RpcServerRequestHandler) {
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => { try { this.receive(JSON.parse(line) as RpcMessage); } catch { /* Ignore provider diagnostics on stdout. */ } });
    this.child.stderr.on('data', (chunk) => { this.diagnostics = `${this.diagnostics}${String(chunk)}`.slice(-2000); });
    const fail = (error: Error) => { this.closed = true; const detail = this.diagnostics.trim().replace(/(?:token|key|password|secret)\s*[=:]\s*[^\s]+/gi, '$1=[redacted]'); const enriched = detail ? new Error(`${error.message}; provider diagnostics: ${detail}`) : error; for (const waiter of this.pending.values()) waiter.reject(enriched); this.pending.clear(); };
    this.child.once('error', fail);
    this.child.once('exit', (code, signal) => fail(new Error(`native protocol exited (${code ?? signal ?? 'unknown'})`)));
  }
  private receive(message: RpcMessage) { if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) { const waiter = this.pending.get(message.id); if (!waiter) return; this.pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message ?? `JSON RPC error ${message.error.code ?? 'unknown'}`)); else waiter.resolve(message.result); return; } if (message.method && typeof message.id === 'number') { void this.respond(message); return; } if (message.method) { const waiter = this.notificationWaiters.shift(); if (waiter) waiter(message); else { this.notifications.push(message); if (this.notifications.length > 500) this.notifications.shift(); } } }
  private async respond(message: RpcMessage): Promise<void> { const write = (payload: unknown) => this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload as object })}\n`); try { const result = this.serverRequest ? await this.serverRequest(message) : undefined; write({ result }); } catch (error) { write({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }); } }
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
  protected initializeResult: unknown;
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
  protected async connected(): Promise<boolean> { return this.connect(); }
  protected async handleServerRequest(message: RpcMessage): Promise<unknown> { if (message.method !== 'fs/read_text_file') throw new Error(`Unsupported provider request ${message.method ?? 'unknown'}`); const params = record(message.params); const requested = text(params.path); if (!requested) throw new Error('ACP file request did not include a path'); const sessionId = text(params.sessionId); const root = (sessionId ? this.sessions.get(sessionId)?.cwd : undefined) ?? this.options.cwd ?? process.cwd(); const file = await safeProjectPath(root, requested); const stat = await fs.stat(file); if (stat.size > 1_000_000) throw new Error('ACP file read exceeds the 1 MB safety limit'); return { content: await fs.readFile(file, 'utf8') }; }
  private async connect(): Promise<boolean> { if (this.initialized) return true; if (this.failure) return false; try { if (!this.rpc) { const command = this.options.command ?? this.defaultCommand; const args = this.options.args ?? this.defaultArgs; if (!this.options.command && !(await which(command))) throw new Error(`${this.label} executable was not found`); this.process = new JsonRpcProcess(command, args, this.options.cwd, (message) => this.handleServerRequest(message)); this.rpc = this.process.request.bind(this.process); } this.initializeResult = await this.initialize(); this.initialized = true; return true; } catch (error) { this.failure = error instanceof Error ? error.message : String(error); this.process?.close(); return false; } }
  protected call(method: string, params?: unknown) { if (!this.rpc) throw new Error(`${this.label} native transport is unavailable`); return this.rpc(method, params); }
  async capabilities(): Promise<AgentCapabilities> { const ready = await this.connect(); const reason = ready ? undefined : this.failure ?? `${this.label} native transport is unavailable`; return { provider: this.id, adapterVersion: VERSION, authorization: ready ? 'unknown' : 'unauthorized', discovery: cap(ready, 'JSON RPC over stdio', this.protocol, reason), sessions: cap(ready, 'JSON RPC over stdio', this.protocol, reason), sendMessage: cap(ready, 'JSON RPC over stdio', this.protocol, reason), steer: cap(false, 'JSON RPC over stdio', this.protocol, 'Provider protocol has no distinct steer operation'), cancel: cap(ready, 'JSON RPC over stdio', this.protocol, reason), events: cap(ready, 'JSON RPC notifications', this.protocol, ready ? 'Events are live and not replayable after process restart' : reason), diff: cap(false, 'provider native protocol', this.protocol, 'Provider does not expose a stable native diff method'), permissions: cap(false, 'JSON RPC notifications', this.protocol, 'Permission handling is provider and request dependent'), model: cap(false, 'provider native protocol', this.protocol, 'Model selection is not standardized by this transport'), reasoning: cap(false, 'provider native protocol', this.protocol, 'Reasoning selection is not standardized by this transport'), limitations: ['Only documented JSON RPC methods are used', ...(ready ? [] : ['Native control is unavailable until the provider process starts and initializes successfully'])] }; }
  protected session(nativeId: string): AgentSession | undefined { return this.sessions.get(nativeId); }
  async listSessions(): Promise<AgentSession[]> { if (!await this.connect()) return []; try { const result = await this.discover(); const sessions = result.map((v) => this.sessionFrom(v, `${this.protocol} session discovery`)).filter((v): v is AgentSession => Boolean(v)); for (const value of sessions) this.sessions.set(value.nativeId, value); return sessions; } catch { return [...this.sessions.values()]; } }
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
  readonly id: ProviderId = 'claude-code'; readonly label: string = 'Claude Code'; readonly protocol: string = 'Agent Client Protocol'; protected readonly defaultCommand = process.env.CLAUDE_ACP_COMMAND ?? 'claude-code-acp'; protected readonly defaultArgs: string[] = [];
  private sessionOptions = new Map<string, Set<string>>();
  protected initialize() { return this.call('initialize', { protocolVersion: 1, clientInfo: { name: 'agent-interop-runtime', version: VERSION }, clientCapabilities: { fs: { readTextFile: true }, terminal: false } }); }
  async capabilities(): Promise<AgentCapabilities> { const base = await super.capabilities(); const ready = base.discovery.supported; const configReason = ready ? 'ACP model and reasoning controls are negotiated per session. Create or resume a session before using them.' : base.discovery.reason; return { ...base, model: { supported: false, state: ready ? 'degraded' : 'unavailable', transport: 'ACP JSON RPC', protocol: this.protocol, reason: configReason }, reasoning: { supported: false, state: ready ? 'degraded' : 'unavailable', transport: 'ACP JSON RPC', protocol: this.protocol, reason: configReason }, limitations: [...base.limitations, 'Claude controls are exposed only when the ACP session advertises matching configuration options'] }; }
  private sessionCapability(name: string): boolean { return Boolean(record(record(this.initializeResult).agentCapabilities).sessionCapabilities && record(record(record(this.initializeResult).agentCapabilities).sessionCapabilities)[name]); }
  protected async discover() { if (!this.sessionCapability('list')) return []; try { const result = record(await this.call('session/list', {})); const sessions = result.sessions ?? result.data ?? result; return Array.isArray(sessions) ? sessions : []; } catch { return []; } }
  protected async startSession(options: { cwd?: string; title?: string }) { const result = await this.call('session/new', { ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.title ? { title: options.title } : {}) }); this.cacheSessionOptions(result); return result; }
  protected async resume(nativeId: string) { if (!this.sessionCapability('loadSession') && !this.sessionCapability('resume')) throw new Error('ACP does not advertise session loading or resume support'); const result = await this.call(this.sessionCapability('loadSession') ? 'session/load' : 'session/resume', { sessionId: nativeId, cwd: this.session(nativeId)?.cwd ?? process.cwd(), mcpServers: [] }); this.cacheSessionOptions(result); return result; }
  protected prompt(nativeId: string, value: string) { return this.call('session/prompt', { sessionId: nativeId, prompt: [{ type: 'text', text: value }] }); }
  protected interrupt(nativeId: string) { return this.call('session/cancel', { sessionId: nativeId }); }
  async send(nativeId: string, value: string, options?: AgentSendOptions): Promise<OperationReceipt> { if (options?.model) await this.setModel(nativeId, options.model); if (options?.reasoning) await this.setReasoning(nativeId, options.reasoning); if (options?.agent) await this.setConfig(nativeId, 'agent', options.agent); return super.send(nativeId, value); }
  private cacheSessionOptions(value: unknown): void { const s = record(record(value).session ?? value); const id = text(s.sessionId) ?? text(s.id); const options = Array.isArray(s.configOptions) ? s.configOptions : []; if (id) this.sessionOptions.set(id, new Set(options.map((option) => text(record(option).id) ?? text(record(option).configId)).filter((v): v is string => Boolean(v)))); }
  private async setConfig(nativeId: string, configId: string, value: string): Promise<void> { const options = this.sessionOptions.get(nativeId); if (options && options.size && !options.has(configId)) throw new Error(`ACP session does not advertise configuration option ${configId}`); await this.call('session/set_config_option', { sessionId: nativeId, configId, type: 'id', value }); }
  async setModel(nativeId: string, selection: ModelSelection): Promise<OperationReceipt> { const model = typeof selection === 'string' ? selection : selection.modelID; try { await this.setConfig(nativeId, 'model', model); } catch (error) { if (error instanceof Error && /does not advertise/.test(error.message)) throw error; await this.call('session/set_model', { sessionId: nativeId, modelId: model }); } return { provider: this.id, nativeId, operation: 'set_model', accepted: true, status: 'completed', providerState: 'configuration_applied' }; }
  async setReasoning(nativeId: string, effort: string): Promise<OperationReceipt> { await this.setConfig(nativeId, 'thought_level', effort); return { provider: this.id, nativeId, operation: 'set_reasoning', accepted: true, status: 'completed', providerState: 'configuration_applied' }; }
  protected sessionFrom(value: unknown, source: string): AgentSession | null { const s = record(record(value).session ?? value); const id = text(s.sessionId) ?? text(s.id); if (!id) return null; this.cacheSessionOptions(value); return { id: `${this.id}:${id}`, nativeId: id, provider: this.id, title: text(s.title), state: text(s.status), cwd: text(s.cwd), transport: 'stdio', provenance: { discoveredAt: now(), source, native: true } }; }
}

export class AcpSessionAdapter extends ClaudeCodeAdapter {}

export class CursorAdapter extends ClaudeCodeAdapter {
  readonly id: ProviderId = 'cursor';
  readonly label = 'Cursor';
  readonly protocol = 'Cursor Agent Client Protocol';
  protected readonly defaultCommand = process.env.CURSOR_AGENT_COMMAND ?? 'agent';
  protected readonly defaultArgs: string[] = ['acp'];
  protected async initialize() {
    const result = await this.call('initialize', { protocolVersion: 1, clientInfo: { name: 'agent-interop-runtime', version: VERSION }, clientCapabilities: { fs: { readTextFile: true }, terminal: false } });
    const authMethods = Array.isArray(record(result).authMethods) ? record(result).authMethods as unknown[] : [];
    if (authMethods.some((method) => text(record(method).id) === 'cursor_login' || text(record(method).methodId) === 'cursor_login')) await this.call('authenticate', { methodId: 'cursor_login' });
    return result;
  }
  async send(nativeId: string, value: string, options?: AgentSendOptions): Promise<OperationReceipt> { if (options?.agent) await this.setCursorMode(nativeId, options.agent); return super.send(nativeId, value, { ...options, agent: undefined }); }
  private async setCursorMode(nativeId: string, mode: string): Promise<void> { await this.call('session/set_config_option', { sessionId: nativeId, configId: 'mode', type: 'id', value: mode }); }
}

async function which(command: string): Promise<string | undefined> { const dirs = [...(process.env.Path ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean), path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local', 'bin')]; for (const dir of dirs) for (const name of process.platform === 'win32' ? [command, `${command}.cmd`, `${command}.exe`] : [command]) { const file = path.join(dir, name); try { await fs.access(file); return file; } catch {} } return undefined; }
