import type { Json } from './types.js';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentCapabilities, AgentEvent, AgentSession, EvidenceRecord, OperationReceipt, ProviderId, WorkGraphSnapshot, AgentSendOptions, ModelSelection } from './interop.js';

export interface EventConsumer { delivered: Set<number>; waiters: Array<(event: AgentEvent | null) => void> }
export interface EventBuffer { history: AgentEvent[]; consumers: EventConsumer[]; closed?: boolean }
const EVENT_BUFFER_MAX = 200;
export function normalizeProviderId(provider: ProviderId, id: string): string { const prefix = `${provider}:`; return id.startsWith(prefix) ? id.slice(prefix.length) : id; }

export class InteropRegistry {
  private adapters = new Map<ProviderId, AgentAdapter>();
  private sessionErrors: Array<{ provider: ProviderId; error: string }> = [];
  private discoveryQueue: Promise<void> = Promise.resolve();
  private evidence: EvidenceRecord[] = [];
  /** AI-14: one shared bounded buffer per provider session, not a new subscription per read. */
  private readonly eventBuffers = new Map<string, EventBuffer>();
  register(adapter: AgentAdapter) { this.adapters.set(adapter.id, adapter); return this; }
  listProviders(): ProviderId[] { return [...this.adapters.keys()]; }
  adapter(provider: ProviderId) { const value = this.adapters.get(provider); if (!value) throw new Error(`Unknown provider ${provider}`); return value; }
  async capabilities(): Promise<AgentCapabilities[]> { return Promise.all([...this.adapters.values()].map((a) => a.capabilities())); }
  async listSessions(provider?: ProviderId): Promise<AgentSession[]> { const run = this.discoveryQueue.then(async () => { this.sessionErrors = []; const adapters = provider ? [this.adapter(provider)] : [...this.adapters.values()]; const results = await Promise.all(adapters.map(async (adapter) => { try { return await adapter.listSessions(); } catch (error) { this.sessionErrors.push({ provider: adapter.id, error: error instanceof Error ? error.message : String(error) }); return []; } })); const sessions = results.flat(); for (const s of sessions) this.capture({ id: `${s.provider}:${s.nativeId}`, provider: s.provider, nativeId: s.nativeId, kind: 'session', capturedAt: new Date().toISOString(), trust: 'native', summary: s.title ?? 'Native session discovered', data: s as unknown as Json }); return sessions; }); this.discoveryQueue = run.then(() => undefined, () => undefined); return run; }
  getSessionErrors(): Array<{ provider: ProviderId; error: string }> { return [...this.sessionErrors]; }
  async send(provider: ProviderId, nativeId: string, text: string, mode: 'send' | 'steer' = 'send', options?: AgentSendOptions): Promise<OperationReceipt> { nativeId = normalizeProviderId(provider, nativeId); const adapter = this.adapter(provider); const fn = mode === 'steer' ? adapter.steer : adapter.send; if (!fn) throw new Error(`${provider} does not support ${mode}`); const result = await fn.call(adapter, nativeId, text, options); this.capture({ id: `${Date.now()}-${randomUUID()}`, provider, nativeId, kind: 'event', capturedAt: new Date().toISOString(), trust: 'observed', summary: `${mode} ${result.status ?? (result.accepted ? 'accepted' : 'rejected')}`, data: result.detail ?? null }); return result; }
  async cancel(provider: ProviderId, nativeId: string): Promise<OperationReceipt> { nativeId = normalizeProviderId(provider, nativeId); const fn = this.adapter(provider).cancel; if (!fn) throw new Error(`${provider} does not support cancel`); return fn.call(this.adapter(provider), nativeId); }
  async create(provider: ProviderId, options: { cwd?: string; title?: string }): Promise<AgentSession> { const fn = this.adapter(provider).createSession; if (!fn) throw new Error(`${provider} does not support session creation`); return fn.call(this.adapter(provider), options); }
  async resume(provider: ProviderId, nativeId: string): Promise<AgentSession> { nativeId = normalizeProviderId(provider, nativeId); const adapter = this.adapter(provider); const session = adapter.resumeSession ? await adapter.resumeSession(nativeId) : await adapter.getSession(nativeId); if (!session) throw new Error(`${provider} could not resume ${nativeId}`); return session; }
  async permission(provider: ProviderId, nativeId: string, requestId: string, decision: string): Promise<OperationReceipt> { nativeId = normalizeProviderId(provider, nativeId); const fn = this.adapter(provider).respondPermission; if (!fn) throw new Error(`${provider} does not support permission responses`); return fn.call(this.adapter(provider), nativeId, requestId, decision); }
  async model(provider: ProviderId, nativeId: string, model: ModelSelection): Promise<OperationReceipt> { nativeId = normalizeProviderId(provider, nativeId); const fn = this.adapter(provider).setModel; if (!fn) throw new Error(`${provider} does not support model changes`); return fn.call(this.adapter(provider), nativeId, model); }
  async reasoning(provider: ProviderId, nativeId: string, effort: string): Promise<OperationReceipt> { nativeId = normalizeProviderId(provider, nativeId); const fn = this.adapter(provider).setReasoning; if (!fn) throw new Error(`${provider} does not support reasoning changes`); return fn.call(this.adapter(provider), nativeId, effort); }
  async diff(provider: ProviderId, nativeId: string): Promise<Json | null> { nativeId = normalizeProviderId(provider, nativeId); const fn = this.adapter(provider).getDiff; if (!fn) throw new Error(`${provider} does not expose native diff`); const result = await fn.call(this.adapter(provider), nativeId); this.capture({ id: `${Date.now()}-${randomUUID()}`, provider, nativeId, kind: 'diff', capturedAt: new Date().toISOString(), trust: 'native', summary: 'Native diff read', data: result ?? null }); return result; }
  /**
   * AI-14: event reads are count-bounded AND time-bounded, served from ONE shared
   * per-session subscription so repeated polls reuse the same buffer instead of opening
   * a new live stream each call. Snapshot semantics: history after `afterSequence` is
   * replayed immediately (a round-trip cursor — pass the last delivered event's sequence
   * back to continue exactly where the previous read stopped), then the read waits
   * (bounded by timeoutMs) for additional events.
   */
  async readEvents(provider: ProviderId, nativeId: string, limit = 50, timeoutMs = 5_000, afterSequence = 0): Promise<AgentEvent[]> {
    nativeId = normalizeProviderId(provider, nativeId);
    const fn = this.adapter(provider).events;
    if (!fn) throw new Error(`${provider} does not expose native events`);
    const bufferKey = `${provider}:${nativeId}`;
    let buffer = this.eventBuffers.get(bufferKey);
    if (!buffer || buffer.closed) {
      buffer = { history: [], consumers: [] };
      this.eventBuffers.set(bufferKey, buffer);
      void this.pumpEvents(provider, nativeId, buffer);
    }
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const consumer: EventConsumer = { delivered: new Set<number>(), waiters: [] };
    buffer.consumers.push(consumer);
    const events: AgentEvent[] = [];
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 30_000);
    try {
      // Snapshot: history after the round-trip cursor, deduplicated by event identity.
      for (const event of buffer.history) {
        if (event.sequence <= afterSequence) continue;
        if (events.length >= boundedLimit) break;
        if (consumer.delivered.has(event.sequence)) continue;
        consumer.delivered.add(event.sequence);
        events.push(event);
      }
      // Bounded wait for further live events up to the count limit.
      while (events.length < boundedLimit && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const next = await new Promise<AgentEvent | null>((resolve) => {
          // Keep the timer referenced: an unref'd deadline can leave a standalone caller
          // (e.g. the benchmark script) awaiting forever once other loop work drains.
          const timer = setTimeout(() => resolve(null), Math.max(remaining, 0));
          consumer.waiters.push((event) => { clearTimeout(timer); resolve(event); });
        });
        if (!next) break;
        if (consumer.delivered.has(next.sequence)) continue;
        consumer.delivered.add(next.sequence);
        events.push(next);
      }
    } finally {
      const index = buffer.consumers.indexOf(consumer);
      if (index >= 0) buffer.consumers.splice(index, 1);
      for (const waiter of consumer.waiters.splice(0)) waiter(null);
    }
    return events;
  }

  /** Single background pump per provider session: adapter events fan out to all consumers. */
  private async pumpEvents(provider: ProviderId, nativeId: string, buffer: EventBuffer): Promise<void> {
    try {
      const iterator = this.adapter(provider).events!(nativeId)[Symbol.asyncIterator]();
      for (;;) {
        if (buffer.closed) return;
        const next = await iterator.next();
        if (next.done || buffer.closed) return;
        buffer.history.push(next.value);
        if (buffer.history.length > EVENT_BUFFER_MAX) buffer.history.splice(0, buffer.history.length - EVENT_BUFFER_MAX);
        for (const consumer of buffer.consumers) for (const waiter of consumer.waiters.splice(0)) waiter(next.value);
      }
    } catch { /* adapter stream ended or errored; the next readEvents recreates the buffer */ }
  }
  /** Section 4 gap: surface pending provider permission requests for human visibility. */
  pendingPermissions(): Array<{ provider: ProviderId; requestId: string; nativeId: string; method: string; options: Json; requestedAt: string }> {
    const out: Array<{ provider: ProviderId; requestId: string; nativeId: string; method: string; options: Json; requestedAt: string }> = [];
    for (const adapter of this.adapters.values()) {
      const surfaced = adapter as Partial<AgentAdapter> & { listPendingPermissions?: () => Array<{ requestId: string; nativeId: string; method: string; options: Json; requestedAt: string }> };
      for (const pending of surfaced.listPendingPermissions?.() ?? []) out.push({ provider: adapter.id, ...pending });
    }
    return out;
  }
  capture(record: EvidenceRecord) { this.evidence.push(record); if (this.evidence.length > 1000) this.evidence.splice(0, this.evidence.length - 1000); }
  async graph(): Promise<WorkGraphSnapshot> { return { sessions: await this.listSessions(), edges: this.evidence.map((e) => ({ from: `${e.provider}:${e.nativeId}`, to: e.id, kind: 'evidence' as const })), evidence: [...this.evidence] }; }
  dispose() { for (const adapter of this.adapters.values()) adapter.dispose?.(); for (const buffer of this.eventBuffers.values()) buffer.closed = true; this.eventBuffers.clear(); }
}
