import fs from 'node:fs/promises';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, execFile as nodeExecFile } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import type { Json } from './types.js';
import type { AgentAdapter, AgentCapabilities, AgentEvent, AgentSession, OperationReceipt, ProviderId, AgentSendOptions, ModelSelection } from './interop.js';
import { VERSION } from './version.js';
import { safeProjectPath } from './security.js';
import { promisify } from 'node:util';
import net from 'node:net';

const now = () => new Date().toISOString();
const text = (v: unknown) => typeof v === 'string' ? v : undefined;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;
const cap = (supported: boolean, transport: string, protocol: string, reason?: string) => ({ supported, state: supported ? 'available' as const : 'unavailable' as const, transport, protocol, reason });
const execFile = promisify(nodeExecFile);

async function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/** Discover a locally running OpenCode server instead of assuming port 4096. */
async function discoverOpenCodeUrl(): Promise<URL | undefined> {
  const candidates = new Set<string>();
  if (process.env.OPENCODE_SERVER_URL) candidates.add(process.env.OPENCODE_SERVER_URL);
  candidates.add('http://127.0.0.1:4096');
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 | Select-Object -ExpandProperty LocalPort"], { timeout: 2000 });
      for (const p of stdout.match(/\b\d{2,5}\b/g) ?? []) candidates.add(`http://127.0.0.1:${p}`);
    } else {
      const { stdout } = await execFile('sh', ['-c', "command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP -sTCP:LISTEN -a -4 -F n | sed -n 's/^n.*:\\([0-9][0-9]*\\)$/\\1/p'"], { timeout: 2000 });
      for (const p of stdout.match(/\b\d{2,5}\b/g) ?? []) candidates.add(`http://127.0.0.1:${p}`);
    }
  } catch { /* fallback to explicit/default endpoint */ }
  for (const value of candidates) {
    try {
      const url = new URL(value);
      if (!isLoopbackHost(url.hostname)) continue;
      const response = await fetch(new URL('/global/health', url), { signal: AbortSignal.timeout(1200), headers: opencodeAuthHeaders() });
      if (response.ok) return url;
      const sessions = await fetch(new URL('/session', url), { signal: AbortSignal.timeout(1200), headers: opencodeAuthHeaders() });
      if (sessions.ok && Array.isArray(await sessions.json())) return url;
    } catch { /* try the next local listener */ }
  }
  return undefined;
}
class OpenCodeHttpError extends Error { constructor(readonly status: number, readonly providerDetail: string) { super(`OpenCode HTTP ${status}: ${providerDetail}`); } }

/** Normalized loopback check shared by request and event paths (AI-07). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host === '[::1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/** One authentication/header policy for normal requests and SSE (AI-07). */
export function opencodeAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const username = process.env.OPENCODE_SERVER_USERNAME;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const effectiveUser = username ?? (password ? 'opencode' : undefined);
  if (effectiveUser && password) headers.authorization = `Basic ${Buffer.from(`${effectiveUser}:${password}`).toString('base64')}`;
  return headers;
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id: ProviderId = 'opencode';
  private base: URL;
  private available = false;
  private lastError?: string;
  private readonly eventSequences = new Map<string, number>();
  private managedServer?: ChildProcess;
  private managedServerStart?: Promise<URL | undefined>;
  constructor(base = process.env.OPENCODE_SERVER_URL ?? 'http://127.0.0.1:4096') { this.base = new URL(base); }
  private get remoteWithoutAuth(): boolean { return !isLoopbackHost(this.base.hostname) && !opencodeAuthHeaders().authorization; }
  private async startManagedServer(): Promise<URL | undefined> {
    if (process.env.OPENCODE_AUTO_START === 'false' || !isLoopbackHost(this.base.hostname)) return undefined;
    if (this.managedServerStart && this.managedServer?.exitCode === null) {
      const existing = await this.managedServerStart;
      if (existing) {
        try { const response = await fetch(new URL('/global/health', existing), { headers: opencodeAuthHeaders(), signal: AbortSignal.timeout(500) }); if (response.ok) return existing; } catch { /* restart below */ }
      }
      this.managedServer?.kill();
    }
    this.managedServerStart = undefined;
    this.managedServerStart = (async () => {
      try {
        const port = await freeTcpPort();
        const command = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
        this.managedServer = spawn(command, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' });
        this.managedServer.unref();
        const url = new URL(`http://127.0.0.1:${port}`);
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (this.managedServer.exitCode !== null) return undefined;
          try { const response = await fetch(new URL('/global/health', url), { headers: opencodeAuthHeaders(), signal: AbortSignal.timeout(500) }); if (response.ok) return url; } catch { /* wait for startup */ }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch { /* fall back to the normal unavailable-provider error */ }
      this.managedServer?.kill();
      this.managedServer = undefined;
      return undefined;
    })();
    return this.managedServerStart;
  }
  private async request<T>(method: string, route: string, body?: unknown): Promise<T> { if (this.remoteWithoutAuth) throw new Error('OpenCode remote endpoint requires OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD (a password alone uses the documented default username)'); const run = async () => { const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', ...opencodeAuthHeaders() }; const response = await fetch(new URL(route, this.base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); const raw = await response.text(); if (!response.ok) { let detail = raw; try { const parsed = record(JSON.parse(raw)); detail = text(parsed.message) ?? text(parsed.error) ?? raw; } catch {} detail = detail.replace(/(authorization|token|password|secret)\s*[=:]\s*[^\s,}]+/gi, '$1=[REDACTED]').slice(0, 1000); throw new OpenCodeHttpError(response.status, detail || response.statusText); } return (raw ? JSON.parse(raw) : undefined) as T; }; try { return await run(); } catch (error) { if (error instanceof OpenCodeHttpError) throw error; const discovered = await discoverOpenCodeUrl(); if (discovered && discovered.href !== this.base.href) { this.base = discovered; return run(); } const managed = await this.startManagedServer(); if (managed) { this.base = managed; return run(); } throw error; } }
  private modelBody(selection: NonNullable<AgentSendOptions['model']>, field: 'modelID' | 'id') { return { providerID: selection.providerID, [field]: selection.modelID }; }
  private async requestWithModelFallback<T>(method: string, route: string, selection: NonNullable<AgentSendOptions['model']>, body: (model: Record<string, unknown>) => unknown): Promise<T> { try { return await this.request<T>(method, route, body(this.modelBody(selection, 'modelID'))); } catch (error) { if (!(error instanceof OpenCodeHttpError) || error.status !== 400 || !/(modelID|model id|unknown field|invalid model|expected id)/i.test(error.providerDetail)) throw error; return this.request<T>(method, route, body(this.modelBody(selection, 'id'))); } }
  async capabilities(): Promise<AgentCapabilities> { this.lastError = undefined; try { await this.request('GET', '/global/health'); this.available = true; } catch (first) { try { const sessions = await this.request<unknown>('GET', '/session'); if (!Array.isArray(sessions)) throw new Error('OpenCode /session returned malformed response'); this.available = true; } catch (error) { this.available = false; this.lastError = error instanceof Error ? error.message : String(error); } } const reason = this.available ? undefined : this.lastError ?? 'Start opencode serve --hostname 127.0.0.1 --port 4096 or set OPENCODE_SERVER_URL'; return { provider: this.id, adapterVersion: VERSION, authorization: this.available ? 'authorized' : 'unknown', discovery: cap(this.available, 'http', 'OpenCode server API', reason), sessions: cap(this.available, 'http', 'OpenCode session API', reason), sendMessage: cap(this.available, 'http', 'POST /session/:id/prompt_async; transport acceptance only', reason), steer: cap(this.available, 'http', 'POST /session/:id/prompt_async; transport acceptance only', reason), cancel: cap(this.available, 'http', 'POST /session/:id/abort', reason), events: cap(this.available, 'http', 'GET /event with reconnect', reason), diff: cap(this.available, 'http', 'GET /session/:id/diff', reason), permissions: cap(this.available, 'http', 'POST /session/:id/permissions/:permissionID', reason), model: cap(false, 'OpenCode prompt request', 'OpenCode server API', this.available ? 'Native session model mutation is not exposed by the validated API. Pass model on agent_send.' : reason), reasoning: cap(this.available, 'OpenCode prompt request', 'OpenCode model variant', this.available ? 'Mapped to the selected OpenCode model variant on the next prompt.' : reason), limitations: ['Existing session attachment requires a reachable OpenCode server', 'Accepted means the OpenCode HTTP endpoint accepted the prompt; it does not mean the agent completed it', 'Model selection is an explicit next prompt override, not persistent session mutation'] }; }
  async listSessions(): Promise<AgentSession[]> { const values = await this.request<unknown>('GET', '/session'); if (!Array.isArray(values)) throw new Error('OpenCode /session returned malformed response'); return values.map((v) => { const s = record(v); const id = text(s.id) ?? ''; const model = record(s.model); return { id: `opencode:${id}`, nativeId: id, provider: this.id, projectId: text(s.projectID), title: text(s.title), state: text(s.status), model: text(model.providerID) && text(model.modelID) ? `${text(model.providerID)}/${text(model.modelID)}` : text(model.id), cwd: text(s.directory) ?? text(record(s.location).directory), transport: 'http', provenance: { discoveredAt: now(), source: 'OpenCode /session', native: true as const } }; }).filter((s) => s.nativeId); }
  async getSession(nativeId: string): Promise<AgentSession | null> { try { const s = record(await this.request('GET', `/session/${encodeURIComponent(nativeId)}`)); const model = record(s.model); return { id: `opencode:${nativeId}`, nativeId, provider: this.id, projectId: text(s.projectID), title: text(s.title), state: text(s.status), model: text(model.providerID) && text(model.modelID) ? `${text(model.providerID)}/${text(model.modelID)}` : text(model.id), cwd: text(s.directory) ?? text(record(s.location).directory), transport: 'http', provenance: { discoveredAt: now(), source: 'OpenCode /session/:id', native: true as const } }; } catch (error) { if (error instanceof Error && /HTTP 404/.test(error.message)) return null; throw error; } }
  async createSession(options: { cwd?: string; title?: string }): Promise<AgentSession> { const query = options.cwd ? `?directory=${encodeURIComponent(options.cwd)}` : ''; const s = record(await this.request('POST', `/session${query}`, { title: options.title })); return (await this.getSession(text(s.id) ?? ''))!; }
  async resumeSession(nativeId: string): Promise<AgentSession> { const session = await this.getSession(nativeId); if (!session) throw new Error(`OpenCode session ${nativeId} was not found`); return session; }
  async send(nativeId: string, value: string, options?: AgentSendOptions): Promise<OperationReceipt> { const route = `/session/${encodeURIComponent(nativeId)}/prompt_async`; let selection = options?.model; if (options?.reasoning && !selection) { const session = await this.getSession(nativeId); const current = session?.model; if (!current) throw new Error('OpenCode reasoning requires an active model or an explicit model selection'); const slash = current.indexOf('/'); selection = slash > 0 ? { providerID: current.slice(0, slash), modelID: current.slice(slash + 1), variant: options.reasoning } : { providerID: 'opencode', modelID: current, variant: options.reasoning }; } else if (selection && options?.reasoning) selection = { ...selection, variant: options.reasoning }; if (selection) await this.requestWithModelFallback('POST', route, selection, (model) => ({ model, ...(selection?.variant ? { variant: selection.variant } : {}), ...(options?.agent ? { agent: options.agent } : {}), parts: [{ type: 'text', text: value }] })); else await this.request('POST', route, { ...(options?.agent ? { agent: options.agent } : {}), parts: [{ type: 'text', text: value }] }); return { provider: this.id, nativeId, operation: 'send', accepted: true, status: 'queued', providerState: 'transport_accepted', detail: json({ delivery: 'transport_accepted', completion: 'not_observed' }) }; }
  async steer(nativeId: string, value: string, options?: AgentSendOptions): Promise<OperationReceipt> { return this.send(nativeId, value, options); }
  async cancel(nativeId: string): Promise<OperationReceipt> { const result = await this.request('POST', `/session/${encodeURIComponent(nativeId)}/abort`); return { provider: this.id, nativeId, operation: 'cancel', accepted: Boolean(result), detail: json(result) }; }
  async getDiff(nativeId: string): Promise<Json | null> { return json(await this.request('GET', `/session/${encodeURIComponent(nativeId)}/diff`)); }
  async respondPermission(nativeId: string, requestId: string, decision: string): Promise<OperationReceipt> { const result = await this.request('POST', `/session/${encodeURIComponent(nativeId)}/permissions/${encodeURIComponent(requestId)}`, { response: decision }); return { provider: this.id, nativeId, operation: 'permission', accepted: true, detail: json(result) }; }
  async setModel(_nativeId: string, _selection: ModelSelection): Promise<OperationReceipt> { throw new Error('OpenCode does not expose a validated native session model mutation; provide model in the next agent_send request'); }
  async *events(nativeId: string): AsyncIterable<AgentEvent> {
    let failures = 0;
    while (true) {
      try {
        if (this.remoteWithoutAuth) throw new Error('OpenCode remote endpoint requires credentials');
        // AI-07: same auth policy as normal requests, including the password-only default user.
        const headers: Record<string, string> = { accept: 'text/event-stream', ...opencodeAuthHeaders() };
        const response = await fetch(new URL('/event', this.base), { headers, signal: AbortSignal.timeout(30_000) });
        if (!response.ok || !response.body) throw new Error(`OpenCode event stream HTTP ${response.status}`);
        failures = 0;
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const records = buffer.split(/\r?\n\r?\n/); buffer = records.pop() ?? '';
            for (const recordValue of records) {
              const data = recordValue.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
              if (!data) continue;
              try {
                const parsed = JSON.parse(data) as unknown;
                const sessionId = this.attributedSession(parsed);
                // AI-06: events without a recognized session location are never stamped onto
                // the requested session; they are skipped as unattributable/global.
                if (!sessionId || sessionId !== nativeId) continue;
                const sequence = (this.eventSequences.get(nativeId) ?? 0) + 1;
                this.eventSequences.set(nativeId, sequence);
                yield { provider: this.id, nativeId, sequence, timestamp: now(), type: text(record(parsed).type) ?? 'opencode.event', data: json(parsed) };
              } catch { continue; }
            }
          }
        } finally { await reader.cancel(); }
      } catch (error) { if (++failures >= 3) throw error; await new Promise((resolve) => setTimeout(resolve, failures * 250)); }
    }
  }

  /**
   * AI-06: exact session attribution across supported OpenCode payload shapes, including
   * nested `properties.info.sessionID` and `properties.part.sessionID` from the generated
   * SDK types. Unknown shapes return undefined instead of being claimed by the caller.
   */
  private attributedSession(payload: unknown): string | undefined {
    const root = record(payload);
    const properties = record(root.properties);
    return text(root.sessionID)
      ?? text(properties.sessionID)
      ?? text(record(root.info).sessionID)
      ?? text(record(properties.info).sessionID)
      ?? text(record(properties.part).sessionID);
  }
}

type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
export type RpcRequest = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
type RpcServerRequestHandler = (message: RpcMessage) => Promise<unknown>;

class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private sequence = 0;
  private closed = false;
  private notifications = new Map<string, RpcMessage[]>();
  private globalNotifications: RpcMessage[] = [];
  private diagnostics = '';
  private notificationWaiters: Array<{ sessionId: string; resolve: (message: RpcMessage | undefined) => void; timer: NodeJS.Timeout }> = [];
  constructor(command: string, args: string[], cwd?: string, private readonly serverRequest?: RpcServerRequestHandler) {
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd') });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => { try { this.receive(JSON.parse(line) as RpcMessage); } catch { /* Ignore provider diagnostics on stdout. */ } });
    this.child.stderr.on('data', (chunk) => { this.diagnostics = `${this.diagnostics}${String(chunk)}`.slice(-2000); });
    const fail = (error: Error) => { this.closed = true; const detail = this.diagnostics.trim().replace(/(?:token|key|password|secret)\s*[=:]\s*[^\s]+/gi, '$1=[redacted]'); const enriched = detail ? new Error(`${error.message}; provider diagnostics: ${detail}`) : error; for (const waiter of this.pending.values()) waiter.reject(enriched); this.pending.clear(); };
    this.child.once('error', fail);
    this.child.once('exit', (code, signal) => fail(new Error(`native protocol exited (${code ?? signal ?? 'unknown'})`)));
  }
  private receive(message: RpcMessage) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) { const waiter = this.pending.get(message.id); if (!waiter) return; this.pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message ?? `JSON RPC error ${message.error.code ?? 'unknown'}`)); else waiter.resolve(message.result); return; }
    if (message.method && message.id !== undefined) { void this.respond(message); return; }
    if (message.method) {
      const params = record(message.params);
      const sessionId = text(params.sessionId) ?? text(params.session_id) ?? text(params.threadId) ?? text(params.thread_id) ?? text(record(params.session).id);
      if (sessionId) {
        const waiterIndex = this.notificationWaiters.findIndex((waiter) => waiter.sessionId === sessionId);
        if (waiterIndex >= 0) { const waiter = this.notificationWaiters.splice(waiterIndex, 1)[0]!; clearTimeout(waiter.timer); waiter.resolve(message); return; }
        const queue = this.notifications.get(sessionId) ?? []; queue.push(message); if (queue.length > 500) queue.shift(); this.notifications.set(sessionId, queue);
      } else { this.globalNotifications.push(message); if (this.globalNotifications.length > 500) this.globalNotifications.shift(); }
    }
  }
  private async respond(message: RpcMessage): Promise<void> { const write = (payload: unknown) => this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload as object })}\n`); try { const result = this.serverRequest ? await this.serverRequest(message) : undefined; write({ result }); } catch (error) { write({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }); } }
  async nextNotification(sessionId: string, timeoutMs = 30_000): Promise<RpcMessage | undefined> { const queue = this.notifications.get(sessionId); const existing = queue?.shift(); if (existing) return existing; if (this.closed) return undefined; return new Promise((resolve) => { const timer = setTimeout(() => { const index = this.notificationWaiters.findIndex((waiter) => waiter.resolve === resolve); if (index >= 0) this.notificationWaiters.splice(index, 1); resolve(undefined); }, timeoutMs); this.notificationWaiters.push({ sessionId, resolve, timer }); }); }
  get isClosed(): boolean { return this.closed; }
  async request(method: string, params?: unknown, timeoutMs = 2_500): Promise<unknown> { if (this.closed) throw new Error('native protocol is not connected'); const id = ++this.sequence; const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n'; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`JSON RPC request timed out: ${method}`)); }, timeoutMs); this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); this.child.stdin.write(payload, (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } }); }); }
  notify(method: string, params?: unknown): void { if (this.closed) throw new Error('native protocol is not connected'); this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`); }
  close() { if (!this.closed) { this.closed = true; this.child.kill(); for (const waiter of this.notificationWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(undefined); } } }
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
  private failedAt = 0;
  private connecting?: Promise<boolean>;
  private ownsProcess = false;
  private readonly sessions = new Map<string, AgentSession>();
  /** Pending provider permission requests surfaced through permission_pending (section 4 gap). */
  protected pendingPermissions = new Map<string, { nativeId: string; sessionId: string; method: string; options: Json; requestedAt: string; resolve: (value: unknown) => void }>();
  constructor(options: NativeAdapterOptions = {}) { this.options = options; this.rpc = options.rpc; }
  protected abstract initialize(): Promise<unknown>;
  protected abstract discover(): Promise<unknown[]>;
  protected abstract startSession(options: { cwd?: string; title?: string }): Promise<unknown>;
  protected abstract resume(nativeId: string): Promise<unknown>;
  protected abstract prompt(nativeId: string, value: string, options?: AgentSendOptions): Promise<unknown>;
  protected abstract interrupt(nativeId: string): Promise<unknown>;
  protected abstract sessionFrom(value: unknown, source: string): AgentSession | null;
  protected async connected(): Promise<boolean> { return this.connect(); }
  listPendingPermissions(): Array<{ requestId: string; nativeId: string; method: string; options: Json; requestedAt: string }> {
    return [...this.pendingPermissions.entries()].map(([requestId, pending]) => ({ requestId, nativeId: pending.nativeId, method: pending.method, options: pending.options, requestedAt: pending.requestedAt }));
  }
  protected async handleServerRequest(message: RpcMessage): Promise<unknown> {
    const params = record(message.params);
    const sessionId = text(params.sessionId) ?? text(params.threadId) ?? 'unknown';
    if (message.method && /request_permission|approval/i.test(message.method)) {
      // Explicit human authorization only: the request stays pending until permission_respond.
      return await new Promise((resolve) => {
        const key = `${sessionId}:${String(message.id)}`;
        this.pendingPermissions.set(key, { nativeId: sessionId, sessionId, method: message.method!, options: json(params), requestedAt: now(), resolve });
      });
    }
    if (message.method !== 'fs/read_text_file') throw new Error(`Unsupported provider request ${message.method ?? 'unknown'}`);
    const requested = text(params.path);
    if (!requested) throw new Error('ACP file request did not include a path');
    // AI-13: file reads use the session's locally recorded cwd; no silent process.cwd() guess.
    const root = this.sessions.get(sessionId)?.cwd ?? this.options.cwd;
    if (!root) throw new Error(`No verified workspace is recorded for session ${sessionId}; refusing to guess a cwd for file access`);
    const file = await safeProjectPath(root, requested);
    const stat = await fs.stat(file);
    if (stat.size > 1_000_000) throw new Error('ACP file read exceeds the 1 MB safety limit');
    const content = await fs.readFile(file, 'utf8');
    const line = typeof params.line === 'number' ? Math.max(1, Math.floor(params.line)) : 1;
    const limit = typeof params.limit === 'number' ? Math.min(10_000, Math.max(1, Math.floor(params.limit))) : undefined;
    const lines = content.split(/\r?\n/);
    return { content: lines.slice(line - 1, limit ? line - 1 + limit : undefined).join('\n') };
  }
  private async connect(): Promise<boolean> {
    if (this.initialized && (!this.ownsProcess || !this.process?.isClosed)) return true;
    if (this.connecting) return this.connecting;
    if (this.failure && Date.now() - this.failedAt < 1_500) return false;
    this.connecting = (async () => {
      try {
        this.failure = undefined;
        this.initialized = false;
        if (this.ownsProcess && this.process?.isClosed) { this.process = undefined; this.rpc = undefined; this.ownsProcess = false; }
        const shouldCreateProcess = !this.rpc;
        if (shouldCreateProcess) {
          const command = this.options.command ?? this.defaultCommand; const args = this.options.args ?? this.defaultArgs;
          const resolved = this.options.command ? await fs.access(command).then(() => command).catch(() => which(command)) : await which(command);
          if (!resolved) throw new Error(`${this.label} executable was not found`);
          this.process = new JsonRpcProcess(resolved, args, this.options.cwd, (message) => this.handleServerRequest(message));
          this.rpc = this.process.request.bind(this.process);
          this.ownsProcess = true;
        }
        this.initializeResult = await this.initialize();
        this.initialized = true;
        this.failedAt = 0;
        return true;
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error);
        this.failedAt = Date.now();
        if (this.ownsProcess) { this.process?.close(); this.process = undefined; this.rpc = undefined; this.ownsProcess = false; }
        return false;
      } finally { this.connecting = undefined; }
    })();
    return this.connecting;
  }
  protected call(method: string, params?: unknown, timeoutMs = 2_500) { if (!this.rpc) throw new Error(`${this.label} native transport is unavailable`); return this.rpc(method, params, timeoutMs); }
  protected notify(method: string, params?: unknown): void { this.process?.notify(method, params); }
  async capabilities(): Promise<AgentCapabilities> { const ready = await this.connect(); const reason = ready ? undefined : this.failure ?? `${this.label} native transport is unavailable`; return { provider: this.id, adapterVersion: VERSION, authorization: ready ? 'unknown' : 'unauthorized', discovery: cap(ready, 'JSON RPC over stdio', this.protocol, reason), sessions: cap(ready, 'JSON RPC over stdio', this.protocol, reason), sendMessage: cap(ready, 'JSON RPC over stdio', this.protocol, reason), steer: cap(false, 'JSON RPC over stdio', this.protocol, 'Provider protocol has no distinct steer operation'), cancel: cap(ready, 'JSON RPC over stdio', this.protocol, reason), events: cap(ready, 'JSON RPC notifications', this.protocol, ready ? 'Events are live and not replayable after process restart' : reason), diff: cap(false, 'provider native protocol', this.protocol, 'Provider does not expose a stable native diff method'), permissions: cap(ready, 'JSON RPC server requests', this.protocol, ready ? 'Permission requests remain pending until permission_respond is called' : reason), model: cap(false, 'provider native protocol', this.protocol, 'Model selection is not standardized by this transport'), reasoning: cap(false, 'provider native protocol', this.protocol, 'Reasoning selection is not standardized by this transport'), limitations: ['Only documented JSON RPC methods are used', ...(ready ? [] : ['Native control is unavailable until the provider process starts and initializes successfully'])] }; }
  protected session(nativeId: string): AgentSession | undefined { return this.sessions.get(nativeId); }
  protected rememberSession(session: AgentSession): void { this.sessions.set(session.nativeId, session); }
  async listSessions(): Promise<AgentSession[]> { if (!await this.connect()) throw new Error(this.failure ?? `${this.label} native transport is unavailable`); const result = await this.discover(); const sessions = result.map((v) => this.sessionFrom(v, `${this.protocol} session discovery`)).filter((v): v is AgentSession => Boolean(v)); for (const value of sessions) this.sessions.set(value.nativeId, value); return sessions; }
  async getSession(nativeId: string): Promise<AgentSession | null> { return this.sessions.get(nativeId) ?? null; }
  async createSession(options: { cwd?: string; title?: string }): Promise<AgentSession> {
    if (!await this.connect()) throw new Error(this.failure ?? `${this.label} native transport is unavailable`);
    const session = this.sessionFrom(await this.startSession(options), `${this.protocol} session/new`);
    if (!session) throw new Error(`${this.label} returned an invalid session`);
    // AI-13: preserve the locally requested and validated cwd even when the provider response
    // omits it. Minimal responses must not lose the workspace.
    const requestedCwd = options.cwd ? path.resolve(options.cwd) : undefined;
    const merged: AgentSession = { ...session, cwd: session.cwd ?? requestedCwd, provenance: { ...session.provenance, ...(requestedCwd && !session.cwd ? { source: `${session.provenance.source} (cwd from local request)` } : {}) } };
    this.sessions.set(merged.nativeId, merged);
    return merged;
  }
  async resumeSession(nativeId: string): Promise<AgentSession> {
    if (!await this.connect()) throw new Error(this.failure ?? `${this.label} native transport is unavailable`);
    const session = this.sessionFrom(await this.resume(nativeId), `${this.protocol} session resume`);
    if (!session) throw new Error(`${this.label} returned an invalid session`);
    const existing = this.sessions.get(nativeId);
    // AI-13: the previously recorded requested cwd wins over a fresh minimal response.
    const merged: AgentSession = { ...session, cwd: existing?.cwd ?? session.cwd };
    this.sessions.set(merged.nativeId, merged);
    return merged;
  }
  async send(nativeId: string, value: string, options?: AgentSendOptions): Promise<OperationReceipt> { if (!await this.connect()) return { provider: this.id, nativeId, operation: 'send', accepted: false, detail: json({ reason: this.failure }) }; await this.prompt(nativeId, value, options); return { provider: this.id, nativeId, operation: 'send', accepted: true }; }
  async cancel(nativeId: string): Promise<OperationReceipt> { if (!await this.connect()) return { provider: this.id, nativeId, operation: 'cancel', accepted: false, detail: json({ reason: this.failure }) }; await this.interrupt(nativeId); return { provider: this.id, nativeId, operation: 'cancel', accepted: true, status: 'completed', providerState: 'cancel_notification_sent' }; }
  async respondPermission(nativeId: string, requestId: string, decision: string): Promise<OperationReceipt> { const pending = this.pendingPermissions.get(`${nativeId}:${requestId}`); if (!pending) throw new Error(`No pending permission request ${requestId} for ${nativeId}`); this.pendingPermissions.delete(`${nativeId}:${requestId}`); pending.resolve({ outcome: { outcome: decision === 'deny' || decision === 'cancelled' ? decision : 'selected', ...(decision === 'deny' || decision === 'cancelled' ? {} : { optionId: decision }) } }); return { provider: this.id, nativeId, operation: 'permission', accepted: true, status: 'completed', providerState: 'decision_sent' }; }
  async *events(nativeId: string): AsyncIterable<AgentEvent> { if (!await this.connect()) return; let sequence = 0; while (this.process) { const message = await this.process.nextNotification(nativeId); if (!message) return; const raw = record(message.params); yield { provider: this.id, nativeId, sequence: ++sequence, timestamp: now(), type: message.method ?? 'notification', data: json(raw) }; } }
  dispose() { this.process?.close(); this.process = undefined; this.rpc = undefined; this.ownsProcess = false; this.initialized = false; this.failure = undefined; this.connecting = undefined; for (const pending of this.pendingPermissions.values()) pending.resolve(undefined); this.pendingPermissions.clear(); }
}

export class CodexAdapter extends NativeProtocolAdapter {
  readonly id: ProviderId = 'codex'; readonly label = 'Codex'; readonly protocol = 'Codex App Server JSON RPC'; protected readonly defaultCommand = 'codex'; protected readonly defaultArgs = ['app-server', '--stdio'];
  private activeTurns = new Map<string, string>();
  constructor(options: NativeAdapterOptions = {}) { super({ ...options, command: options.command ?? process.env.CODEX_APP_SERVER_COMMAND }); }
  protected async initialize() { const result = await this.call('initialize', { clientInfo: { name: 'agent-interop-runtime', version: VERSION }, capabilities: {} }); this.notify('initialized', {}); return result; }
  protected async discover() { const result = record(await this.call('thread/list', {})); const threads = result.data ?? result.threads ?? result; return Array.isArray(threads) ? threads : []; }
  protected startSession(options: { cwd?: string; title?: string }) { return this.call('thread/start', { ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.title ? { name: options.title } : {}) }); }
  protected resume(nativeId: string) { return this.call('thread/resume', { threadId: nativeId }); }
  protected async prompt(nativeId: string, value: string, options?: AgentSendOptions) { const result = await this.call('turn/start', { threadId: nativeId, input: [{ type: 'text', text: value }], ...(options?.model ? { model: options.model.modelID } : {}), ...(options?.reasoning ? { effort: options.reasoning } : {}) }, 600_000); const turnId = text(record(result).turnId) ?? text(record(record(result).turn).id) ?? text(record(result).id); if (turnId) this.activeTurns.set(nativeId, turnId); return result; }
  protected interrupt(nativeId: string) { const turnId = this.activeTurns.get(nativeId); if (!turnId) throw new Error(`Codex has no active turn ID for thread ${nativeId}`); return this.call('turn/interrupt', { threadId: nativeId, turnId }); }
  async capabilities(): Promise<AgentCapabilities> { const base = await super.capabilities(); const ready = base.discovery.supported; return { ...base, model: cap(ready, 'Codex App Server JSON RPC', this.protocol, ready ? 'Per turn model override through turn/start' : base.discovery.reason), reasoning: cap(ready, 'Codex App Server JSON RPC', this.protocol, ready ? 'Per turn effort override through turn/start' : base.discovery.reason), limitations: [...base.limitations, 'Codex model and reasoning overrides apply to the next sent turn; persistent session mutation is not exposed by this adapter'] }; }
  async send(nativeId: string, value: string, options?: AgentSendOptions): Promise<OperationReceipt> { if (options?.agent) throw new Error('Codex App Server does not expose a separate agent control'); return super.send(nativeId, value, options); }
  protected sessionFrom(value: unknown, source: string): AgentSession | null { const s = record(record(value).thread ?? value); const id = text(s.id) ?? text(s.threadId); if (!id) return null; return { id: `codex:${id}`, nativeId: id, provider: this.id, title: text(s.name) ?? text(s.title), state: text(s.status), model: text(s.model), cwd: text(s.cwd), transport: 'stdio', provenance: { discoveredAt: now(), source, native: true } }; }
}

export class ClaudeCodeAdapter extends NativeProtocolAdapter {
  readonly id: ProviderId = 'claude-code'; readonly label: string = 'Claude Code'; readonly protocol: string = 'Agent Client Protocol'; protected readonly defaultCommand = process.env.CLAUDE_ACP_COMMAND ?? 'claude-code-acp'; protected readonly defaultArgs: string[] = [];
  private sessionOptions = new Map<string, Set<string>>();
  protected initialize() { return this.call('initialize', { protocolVersion: 1, clientInfo: { name: 'agent-interop-runtime', version: VERSION }, clientCapabilities: { fs: { readTextFile: true }, terminal: false } }); }
  async capabilities(): Promise<AgentCapabilities> { const base = await super.capabilities(); const ready = base.discovery.supported; const configReason = ready ? 'ACP model and reasoning controls are negotiated per session. Create or resume a session before using them.' : base.discovery.reason; return { ...base, model: { supported: false, state: ready ? 'degraded' : 'unavailable', transport: 'ACP JSON RPC', protocol: this.protocol, reason: configReason }, reasoning: { supported: false, state: ready ? 'degraded' : 'unavailable', transport: 'ACP JSON RPC', protocol: this.protocol, reason: configReason }, limitations: [...base.limitations, 'ACP controls are exposed only when the provider session advertises matching configuration options'] }; }
  private agentCapability(name: string): boolean { return Boolean(record(record(this.initializeResult).agentCapabilities)[name]); }
  private sessionCapability(name: string): boolean { return Boolean(record(record(record(this.initializeResult).agentCapabilities).sessionCapabilities)[name]); }
  protected async discover() { if (!this.sessionCapability('list')) return []; const result = record(await this.call('session/list', {})); const sessions = result.sessions ?? result.data ?? result; if (!Array.isArray(sessions)) throw new Error('ACP session/list returned a malformed response'); return sessions; }
  protected async startSession(options: { cwd?: string; title?: string }) { const result = await this.call('session/new', { cwd: path.resolve(options.cwd ?? process.cwd()), mcpServers: [], ...(options.title ? { title: options.title } : {}) }); this.cacheSessionOptions(result); return result; }
  protected async resume(nativeId: string) {
    if (!this.agentCapability('loadSession') && !this.sessionCapability('resume')) throw new Error('ACP does not advertise session loading or resume support');
    // AI-13: resume uses the locally recorded requested cwd; when unknown, fail explicitly
    // instead of guessing the server process directory.
    const recorded = this.session(nativeId)?.cwd;
    const cwd = recorded ? path.resolve(recorded) : undefined;
    const method = this.agentCapability('loadSession') ? 'session/load' : 'session/resume';
    const result = await this.call(method, { sessionId: nativeId, ...(cwd ? { cwd } : {}), mcpServers: [] });
    const response = record(result);
    if (!text(response.sessionId) && !text(response.id)) (response as Record<string, unknown>).sessionId = nativeId;
    this.cacheSessionOptions(response);
    return response;
  }
  protected prompt(nativeId: string, value: string) { return this.call('session/prompt', { sessionId: nativeId, prompt: [{ type: 'text', text: value }] }, 600_000); }
  /**
   * AI-12: under the negotiated ACP v1 contract, session/cancel is a notification. It must not
   * be sent as a request; the original prompt's own completion/cancellation result is observed
   * separately through session notifications.
   */
  protected interrupt(nativeId: string) { this.notify('session/cancel', { sessionId: nativeId }); return Promise.resolve({ notified: true }); }
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
