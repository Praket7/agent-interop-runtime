import fs from 'node:fs/promises';
import os from 'node:os';
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
  async send(nativeId: string, value: string): Promise<OperationReceipt> { await this.request('POST', `/session/${encodeURIComponent(nativeId)}/prompt_async`, { parts: [{ type: 'text', text: value }] }); return { provider: this.id, nativeId, operation: 'send', accepted: true }; }
  async steer(nativeId: string, value: string): Promise<OperationReceipt> { return this.send(nativeId, value); }
  async cancel(nativeId: string): Promise<OperationReceipt> { const result = await this.request('POST', `/session/${encodeURIComponent(nativeId)}/abort`); return { provider: this.id, nativeId, operation: 'cancel', accepted: Boolean(result), detail: json(result) }; }
  async getDiff(nativeId: string): Promise<Json | null> { return json(await this.request('GET', `/session/${encodeURIComponent(nativeId)}/diff`)); }
  async setModel(nativeId: string, model: string): Promise<OperationReceipt> { await this.request('POST', `/session/${encodeURIComponent(nativeId)}/message`, { noReply: true, model, parts: [] }); return { provider: this.id, nativeId, operation: 'set_model', accepted: true }; }
}

abstract class DiscoveryAdapter implements AgentAdapter {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  abstract readonly protocol: string;
  async capabilities(): Promise<AgentCapabilities> { const found = await this.commandAvailable(); return { provider: this.id, adapterVersion: '0.1.0', authorization: found ? 'unknown' : 'unauthorized', discovery: cap(found, 'local process', this.protocol, found ? undefined : `${this.label} executable was not found`), sessions: cap(found, 'local files or app server', this.protocol), sendMessage: cap(false, 'not connected', this.protocol, 'No supported live session transport was detected'), steer: cap(false, 'not connected', this.protocol, 'No supported live session transport was detected'), cancel: cap(false, 'not connected', this.protocol), events: cap(false, 'not connected', this.protocol), diff: cap(false, 'local workspace', 'filesystem observation', 'Native diff requires an attached session'), permissions: cap(false, 'not connected', this.protocol), model: cap(false, 'not connected', this.protocol), reasoning: cap(false, 'not connected', this.protocol), limitations: ['This adapter reports discovery honestly and does not scrape terminal keystrokes', 'Live control becomes available when the provider transport is connected'] }; }
  protected abstract commandAvailable(): Promise<boolean>;
  async listSessions(): Promise<AgentSession[]> { return []; }
  async getSession(): Promise<AgentSession | null> { return null; }
}

export class CodexAdapter extends DiscoveryAdapter { readonly id: ProviderId = 'codex'; readonly label = 'Codex'; readonly protocol = 'Codex App Server JSON RPC'; protected async commandAvailable() { return Boolean(process.env.CODEX_APP_SERVER_COMMAND || await which('codex')); } }
export class ClaudeCodeAdapter extends DiscoveryAdapter { readonly id: ProviderId = 'claude-code'; readonly label = 'Claude Code'; readonly protocol = 'Claude Agent SDK or ACP'; protected async commandAvailable() { return Boolean(process.env.CLAUDE_CODE_COMMAND || await which('claude')); } }
async function which(command: string): Promise<string | undefined> { const dirs = (process.env.Path ?? process.env.PATH ?? '').split(path.delimiter); for (const dir of dirs) for (const name of process.platform === 'win32' ? [command, `${command}.cmd`, `${command}.exe`] : [command]) { const file = path.join(dir, name); try { await fs.access(file); return file; } catch {} } return undefined; }

export class AcpSessionAdapter extends DiscoveryAdapter { readonly id: ProviderId = 'claude-code'; readonly label = 'ACP compatible agent'; readonly protocol = 'Agent Client Protocol'; protected async commandAvailable() { return Boolean(process.env.ACP_AGENT_COMMAND); } }
