import type { Json } from './types.js';
import type { AgentAdapter, AgentCapabilities, AgentEvent, AgentSession, EvidenceRecord, OperationReceipt, ProviderId, WorkGraphSnapshot } from './interop.js';

export class InteropRegistry {
  private adapters = new Map<ProviderId, AgentAdapter>();
  private evidence: EvidenceRecord[] = [];
  register(adapter: AgentAdapter) { this.adapters.set(adapter.id, adapter); return this; }
  listProviders(): ProviderId[] { return [...this.adapters.keys()]; }
  adapter(provider: ProviderId) { const value = this.adapters.get(provider); if (!value) throw new Error(`Unknown provider ${provider}`); return value; }
  async capabilities(): Promise<AgentCapabilities[]> { return Promise.all([...this.adapters.values()].map((a) => a.capabilities())); }
  async listSessions(provider?: ProviderId): Promise<AgentSession[]> { const adapters = provider ? [this.adapter(provider)] : [...this.adapters.values()]; const sessions = (await Promise.all(adapters.map((a) => a.listSessions()))).flat(); for (const s of sessions) this.capture({ id: `${s.provider}:${s.nativeId}`, provider: s.provider, nativeId: s.nativeId, kind: 'session', capturedAt: new Date().toISOString(), trust: 'native', summary: s.title ?? 'Native session discovered', data: s as unknown as Json }); return sessions; }
  async send(provider: ProviderId, nativeId: string, text: string, mode: 'send' | 'steer' = 'send'): Promise<OperationReceipt> { const adapter = this.adapter(provider); const fn = mode === 'steer' ? adapter.steer : adapter.send; if (!fn) throw new Error(`${provider} does not support ${mode}`); const result = await fn.call(adapter, nativeId, text); this.capture({ id: `${Date.now()}`, provider, nativeId, kind: 'event', capturedAt: new Date().toISOString(), trust: 'observed', summary: `${mode} accepted`, data: result.detail ?? null }); return result; }
  async cancel(provider: ProviderId, nativeId: string): Promise<OperationReceipt> { const fn = this.adapter(provider).cancel; if (!fn) throw new Error(`${provider} does not support cancel`); return fn.call(this.adapter(provider), nativeId); }
  async diff(provider: ProviderId, nativeId: string): Promise<Json | null> { const fn = this.adapter(provider).getDiff; if (!fn) throw new Error(`${provider} does not expose native diff`); const result = await fn.call(this.adapter(provider), nativeId); this.capture({ id: `${Date.now()}`, provider, nativeId, kind: 'diff', capturedAt: new Date().toISOString(), trust: 'native', summary: 'Native diff read', data: result ?? null }); return result; }
  capture(record: EvidenceRecord) { this.evidence.push(record); if (this.evidence.length > 1000) this.evidence.splice(0, this.evidence.length - 1000); }
  async graph(): Promise<WorkGraphSnapshot> { return { sessions: await this.listSessions(), edges: this.evidence.map((e) => ({ from: `${e.provider}:${e.nativeId}`, to: e.id, kind: 'evidence' as const })), evidence: [...this.evidence] }; }
  dispose() { for (const adapter of this.adapters.values()) adapter.dispose?.(); }
}
