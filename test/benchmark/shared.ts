/**
 * Shared benchmark primitives for the two-provider offline harness (audit §7/§10).
 *
 * Everything here is offline: "providers" are in-memory AgentAdapter implementations
 * speaking the real registry/store contracts, not HTTP mocks of provider APIs.
 * No live provider calls are made and no usage/latency numbers are invented — the
 * harness measures only what it can observe locally (bytes, tokens, read duplication).
 *
 * Measurement conventions:
 * - Bytes: UTF-8 byte length of the exact JSON payload a caller would receive.
 * - Tokens: js-tiktoken `o200k_base` (named tokenizer), applied to the same payload.
 *   Token counts are an offline estimate of prompt-size cost, NOT native provider usage.
 * - Duplicate reads: an event or message body delivered more than once to the same
 *   consumer across paginated reads (e.g. cursor reuse bugs like AI-04 / AI-03).
 */

import { getEncoding } from 'js-tiktoken';
import type { Json } from '../../src/types.js';
import type {
  AgentAdapter, AgentCapabilities, AgentEvent, AgentSession, AgentSendOptions,
  OperationReceipt, ProviderId,
} from '../../src/interop.js';

// Named tokenizer: OpenAI's o200k_base BPE ranks via js-tiktoken (fully offline).
// Counts are an offline estimate of prompt-size cost, NOT native provider usage.
const encoder = getEncoding('o200k_base');

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}

export function countPayloadTokens(value: unknown): number {
  return countTokens(JSON.stringify(value));
}

export function countBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export type UsageObservation = { provider: ProviderId; nativeId: string; kind: 'send' | 'steer' | 'cancel'; at: string };

/**
 * In-memory provider adapter conforming to the real AgentAdapter contract. It records
 * every send/steer/cancel so the harness can correlate delivery (queued → running →
 * completed) without claiming anything about a real provider's internals.
 */
export class InMemoryProvider implements AgentAdapter {
  readonly id: ProviderId;
  readonly displayName: string;

  /** Sends observed by the provider itself — the ground truth for duplicate detection. */
  readonly received: Array<{ nativeId: string; text: string; options?: AgentSendOptions; at: string }> = [];
  readonly usageObservations: UsageObservation[] = [];

  private readonly sessions = new Map<string, AgentSession>();
  private readonly eventLog = new Map<string, AgentEvent[]>();
  private readonly waiters = new Map<string, Array<(event: AgentEvent) => void>>();
  private readonly runState = new Map<string, 'idle' | 'running' | 'blocked' | 'completed' | 'cancelled'>();

  constructor(id: ProviderId, displayName: string, seedSessions: Array<{ nativeId: string; cwd?: string; title?: string }> = []) {
    this.id = id;
    this.displayName = displayName;
    for (const seed of seedSessions) {
      const nativeId = seed.nativeId;
      const session: AgentSession = {
        provider: id, nativeId, transport: 'in-memory', cwd: seed.cwd,
        title: seed.title ?? `${displayName} ${nativeId}`,
        id: `${id}:${nativeId}`, state: 'idle', model: 'bench-model', metadata: {}, live: false,
        provenance: { discoveredAt: new Date().toISOString(), source: 'benchmark', native: true },
      };
      this.sessions.set(nativeId, session);
    }
  }

  async capabilities(): Promise<AgentCapabilities> {
    const record = (transport: string) => ({ supported: true, state: 'available' as const, transport });
    return {
      provider: this.id, adapterVersion: 'bench', authorization: 'authorized',
      discovery: record('in-memory'), sessions: record('in-memory'), sendMessage: record('in-memory'),
      steer: record('in-memory'), cancel: record('in-memory'), events: record('in-memory'),
      diff: record('in-memory'), permissions: { supported: false, state: 'unavailable' as const, reason: 'not exercised in offline benchmark' },
      model: record('in-memory'), reasoning: record('in-memory'),
      limitations: ['offline benchmark peer; not a live provider'],
    };
  }

  async listSessions(): Promise<AgentSession[]> { return [...this.sessions.values()]; }

  async getSession(nativeId: string): Promise<AgentSession | null> { return this.sessions.get(nativeId) ?? null; }

  async createSession(options: { cwd?: string; title?: string } = {}): Promise<AgentSession> {
    const nativeId = `${this.id}-bench-${this.sessions.size + 1}`;
    const session: AgentSession = {
      provider: this.id, nativeId, transport: 'in-memory', cwd: options.cwd,
      title: options.title ?? `${this.displayName} ${nativeId}`,
      id: `${this.id}:${nativeId}`, state: 'idle', model: 'bench-model', metadata: {}, live: false,
      provenance: { discoveredAt: new Date().toISOString(), source: 'benchmark', native: true },
    };
    this.sessions.set(nativeId, session);
    return session;
  }

  async send(nativeId: string, text: string, options?: AgentSendOptions): Promise<OperationReceipt> {
    this.received.push({ nativeId, text, options, at: new Date().toISOString() });
    this.usageObservations.push({ provider: this.id, nativeId, kind: 'send', at: new Date().toISOString() });
    this.runState.set(nativeId, 'running');
    this.emit(nativeId, { type: 'message.accepted', data: { preview: text.slice(0, 120) } });
    this.emit(nativeId, { type: 'turn.completed', data: { stopReason: 'end_turn' } });
    this.runState.set(nativeId, 'completed');
    return { provider: this.id, nativeId, operation: 'send', accepted: true, status: 'queued', providerState: 'running' };
  }

  async steer(nativeId: string, text: string, options?: AgentSendOptions): Promise<OperationReceipt> {
    return this.send(nativeId, text, options);
  }

  async cancel(nativeId: string): Promise<OperationReceipt> {
    this.usageObservations.push({ provider: this.id, nativeId, kind: 'cancel', at: new Date().toISOString() });
    this.runState.set(nativeId, 'cancelled');
    return { provider: this.id, nativeId, operation: 'cancel', accepted: true, status: 'completed' };
  }

  async *events(nativeId: string): AsyncIterable<AgentEvent> {
    const log = this.eventLog.get(nativeId) ?? [];
    for (const event of log) yield event;
    // Live tail: yield future events as they are emitted, one wait per event.
    for (;;) {
      const event = await new Promise<AgentEvent | null>((resolve) => {
        const list = this.waiters.get(nativeId) ?? [];
        list.push(resolve);
        this.waiters.set(nativeId, list);
      });
      if (!event) return;
      yield event;
    }
  }

  async getDiff(nativeId: string): Promise<Json | null> {
    return { files: [{ path: `src/${nativeId}.ts`, additions: 12, deletions: 3 }], revision: `${this.id}:${nativeId}:rev-1` } as unknown as Json;
  }

  /** Only for tests/benchmark: pushes a synthetic event to the live tail. */
  emit(nativeId: string, event: { type: string; data: Json }): AgentEvent {
    const log = this.eventLog.get(nativeId) ?? [];
    const record: AgentEvent = { provider: this.id, nativeId, sequence: log.length + 1, timestamp: new Date().toISOString(), type: event.type, data: event.data };
    log.push(record);
    this.eventLog.set(nativeId, log);
    for (const waiter of this.waiters.get(nativeId) ?? []) waiter(record);
    this.waiters.set(nativeId, []);
    return record;
  }

  /** Drives the correlatable lifecycle: running → blocked → completed/cancelled. */
  async runTurn(nativeId: string, phases: Array<'blocked' | 'completed' | 'cancelled'>): Promise<void> {
    for (const phase of phases) {
      this.runState.set(nativeId, phase);
      this.emit(nativeId, { type: phase === 'blocked' ? 'permission.requested' : `turn.${phase}`, data: { state: phase } });
    }
  }

  dispose(): void { this.waiters.clear(); }
}

/**
 * Duplicate-read accounting for a paginated consumer: records the identity of every
 * item body returned by reads and counts repeats. Item identity is the stable key the
 * fixed contract guarantees (event sequence, message id), not array position.
 */
export class DuplicateReadCounter {
  private readonly seen = new Map<string, number>();

  record(item: { key: string; body: unknown }): void {
    const body = JSON.stringify(item.body);
    const fingerprint = `${item.key}::${body}`;
    this.seen.set(fingerprint, (this.seen.get(fingerprint) ?? 0) + 1);
  }

  /** Items delivered to this consumer more than once. */
  duplicates(): Array<{ key: string; times: number }> {
    return [...this.seen.entries()].filter(([, times]) => times > 1).map(([fingerprint, times]) => ({ key: fingerprint.split('::')[0]!, times }));
  }

  get totalReads(): number { return [...this.seen.values()].reduce((sum, times) => sum + times, 0); }
  get uniqueItems(): number { return this.seen.size; }
}
