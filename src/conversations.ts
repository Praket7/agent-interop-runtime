import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ProviderId, AgentSendOptions, OperationReceipt } from './interop.js';
import type { InteropRegistry } from './interop-runtime.js';
import { atomicWriteJson, withStateLock } from './state.js';

export interface ConversationParticipant { id: string; provider: ProviderId; nativeId: string; workspaceId?: string; role?: 'sender' | 'reviewer' | 'editor'; }
export type DeliveryState = 'queued' | 'rejected' | 'delivery_unknown' | 'completed';
export interface ConversationMessage {
  id: string; conversationId: string; sender: string; recipient: string; text: string;
  replyTo?: string; createdAt: string;
  /** Monotonic per-conversation sequence; survives retention trimming and is stable for pagination. */
  sequence: number;
  receipt?: OperationReceipt;
  delivery?: DeliveryState;
  /** Set when the provider may or may not have executed the prompt; such records are never silently resent. */
  deliveryUnknownAt?: string;
  idempotencyKey?: string;
}
export interface Conversation { id: string; title: string; participants: ConversationParticipant[]; messages: ConversationMessage[]; createdAt: string; updatedAt: string; /** Highest sequence ever assigned, persisted so monotonic cursors survive restart and trimming. */ lastSequence: number; }
export type ConversationSummary = Omit<Conversation, 'messages'> & { messageCount: number };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const stamp = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${randomUUID()}`;

export const MAX_MESSAGES_PER_CONVERSATION = 500;

export class ConversationStore {
  private conversations = new Map<string, Conversation>();
  private loaded = false;
  private loading?: Promise<void>;
  private loadError?: string;
  /** AIR-04: signature of the state file at last read/persist; drives cache refresh for long-lived readers. */
  private diskSignature = '';
  constructor(private readonly file: string) {}

  /** All operations gate on initialization so early reads cannot see empty state (section 4 gap). */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) { await this.refreshFromDisk(); return; }
    this.loading ??= this.load();
    await this.loading;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.refreshFromDisk();
    this.loaded = true;
  }

  loadErrorReason(): string | undefined { return this.loadError; }

  /** File signature used to detect external writes cheaply on read paths (AIR-04). */
  private async currentSignature(): Promise<string> {
    try { const stat = await fs.stat(this.file); return `${stat.mtimeMs}:${stat.size}`; } catch { return ''; }
  }

  /**
   * AIR-04: replaces the in-memory map with the current disk content when the file changed.
   * A long-lived reader therefore observes other processes' committed writes. The disk file
   * is the authority: every local mutation goes through transact() and persists immediately,
   * so replacing the map cannot lose this process's own committed state.
   */
  private async refreshFromDisk(): Promise<void> {
    const signature = await this.currentSignature();
    if (signature === this.diskSignature) return;
    let raw: { conversations?: unknown[] } | undefined;
    try {
      raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as { conversations?: unknown[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.conversations.clear(); this.diskSignature = signature; return; }
      this.loadError = error instanceof Error ? error.message : String(error);
      throw new Error(`Conversation state is not readable: ${this.loadError}`);
    }
    const disk = new Map<string, Conversation>();
    for (const value of raw.conversations ?? []) { const conversation = this.normalize(value); if (conversation) disk.set(conversation.id, conversation); }
    this.conversations = disk;
    this.diskSignature = signature;
  }

  /** Migration: assign monotonic sequence numbers and conversation-level counters to pre-0.3 state. */
  private normalize(value: unknown): Conversation | null {
    const conversation = value as Conversation;
    if (!conversation?.id || !Array.isArray(conversation.participants) || !Array.isArray(conversation.messages)) return null;
    let counter = 0;
    for (const message of conversation.messages) {
      counter += 1;
      if (typeof message.sequence !== 'number') message.sequence = counter;
    }
    const highest = conversation.messages.reduce((max, m) => Math.max(max, m.sequence ?? 0), 0);
    conversation.lastSequence = Math.max(typeof conversation.lastSequence === 'number' ? conversation.lastSequence : 0, highest, conversation.messages.length);
    return conversation;
  }

  /** Metadata-only listing (token efficiency): message bodies are excluded. */
  async list(options?: { detail?: boolean }): Promise<ConversationSummary[]> {
    await this.ensureLoaded();
    const ordered = [...this.conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return ordered.map((conversation) => ({
      id: conversation.id, title: conversation.title, participants: clone(conversation.participants),
      createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, lastSequence: conversation.lastSequence,
      messageCount: conversation.messages.length,
      ...(options?.detail ? { messages: clone(conversation.messages) } : {}),
    })) as ConversationSummary[];
  }

  async get(id: string): Promise<Conversation | null> { await this.ensureLoaded(); return clone(this.conversations.get(id) ?? null); }

  async create(title: string): Promise<Conversation> {
    await this.ensureLoaded();
    return this.transact(() => {
      const time = stamp();
      const conversation: Conversation = { id: newId('conversation'), title: title.trim().slice(0, 300), participants: [], messages: [], createdAt: time, updatedAt: time, lastSequence: 0 };
      this.conversations.set(conversation.id, conversation);
      return clone(conversation);
    });
  }

  async join(conversationId: string, participant: Omit<ConversationParticipant, 'id'> & { id?: string }): Promise<Conversation> {
    await this.ensureLoaded();
    return this.transact(() => {
      const conversation = this.require(conversationId);
      const existing = conversation.participants.find((value) => value.provider === participant.provider && value.nativeId === participant.nativeId);
      if (!existing) conversation.participants.push({ ...participant, id: participant.id ?? `${participant.provider}:${participant.nativeId}` });
      conversation.updatedAt = stamp();
      return clone(conversation);
    });
  }

  /**
   * Persist-before-send (AI-01): the outbound record and idempotency key are durable before the
   * provider is contacted. Delivery is classified as queued, rejected, or delivery_unknown; an
   * unknown outcome is recorded and never blindly resent (no exactly-once provider claim).
   *
   * AIR-01: dispatch uses the JOINED PARTICIPANT's actual provider and nativeId — never the
   * composite participant ID, which would otherwise be sent to the adapter as a native session
   * ID (e.g. OpenCode building /session/opencode%3Ab/prompt_async). Sender/recipient arguments
   * are participant IDs within this conversation; the participant record is resolved under the
   * transaction so routing and receipt identity come from the authoritative join record.
   */
  async send(conversationId: string, sender: string, recipient: string, text: string, registry: InteropRegistry, options?: AgentSendOptions, replyTo?: string, callerIdempotencyKey?: string): Promise<{ message: ConversationMessage; receipt: OperationReceipt }> {
    await this.ensureLoaded();
    // Idempotency: a caller may supply a stable key (e.g. derived from work ID + handoff ID)
    // so a crashed/retried send resolves to the SAME message record instead of enqueueing a
    // duplicate. Without it, a fresh key is minted per call.
    const idempotencyKey = callerIdempotencyKey?.trim() || newId('outbound');
    if (callerIdempotencyKey?.trim()) {
      await this.ensureLoaded();
      const duplicate = [...this.conversations.values()].flatMap((c) => c.messages).find((m) => m.idempotencyKey === idempotencyKey);
      if (duplicate) {
        throw new Error(`Idempotency key '${idempotencyKey}' already has a message (${duplicate.id}, delivery ${duplicate.delivery}). Inspect the existing record instead of resending.`);
      }
    }
    const destination = await this.resolveDestination(conversationId, recipient);
    const pending = await this.transact(() => {
      const conversation = this.require(conversationId);
      if (!conversation.participants.some((value) => value.id === sender)) throw new Error(`Unknown conversation sender ${sender}`);
      const destinationParticipant = conversation.participants.find((value) => value.id === recipient);
      if (!destinationParticipant) throw new Error(`Unknown conversation recipient ${recipient}`);
      const message: ConversationMessage = {
        id: newId('message'), conversationId, sender, recipient, text: text.trim(),
        ...(replyTo ? { replyTo } : {}), createdAt: stamp(),
        sequence: conversation.lastSequence + 1,
        delivery: 'queued', idempotencyKey,
      };
      conversation.lastSequence = message.sequence;
      conversation.messages.push(message);
      if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES_PER_CONVERSATION);
      conversation.updatedAt = stamp();
      return clone(message);
    });
    const provider = destination.provider;
    const nativeId = destination.nativeId;

    const envelope = `[agent-interop message ${pending.id} from ${sender}]\n${pending.text}`;
    let receipt: OperationReceipt;
    // Blocker 3: mark the dispatch window so reconciliation treats the queued record as
    // healthy in-flight work, not a crash, while the provider call is executing.
    this.markDispatchStarted(pending.id);
    try {
      receipt = await registry.send(provider, nativeId, envelope, 'send', options);
    } catch (error) {
      this.markDispatchFinished(pending.id);
      const reason = error instanceof Error ? error.message : String(error);
      // Provider never confirmed receipt: delivery outcome is unknown, not failed-and-resendable.
      await this.transact(() => {
        const conversation = this.require(conversationId);
        const message = conversation.messages.find((m) => m.id === pending.id);
        if (message) {
          message.delivery = 'delivery_unknown';
          message.deliveryUnknownAt = stamp();
          message.receipt = { provider, nativeId, operation: 'send', accepted: false, status: 'rejected', detail: { reason, classification: 'delivery_unknown' } };
        }
        return null;
      });
      throw new Error(`Message ${pending.id} persisted with delivery_unknown; it may have reached the provider and must not be resent blindly: ${reason}`);
    }
    this.markDispatchFinished(pending.id);
    const delivery: DeliveryState = receipt.accepted ? (receipt.status === 'completed' ? 'completed' : 'queued') : 'rejected';
    await this.transact(() => {
      const conversation = this.require(conversationId);
      const message = conversation.messages.find((m) => m.id === pending.id);
      if (message) { message.receipt = receipt; message.delivery = delivery; }
      return null;
    });
    return { message: clone({ ...pending, receipt, delivery }), receipt: clone(receipt) };
  }

  /**
   * Sequence-cursor page read (AI-03): cursors are monotonic message sequences, so retention
   * trimming never strands a cursor. Returns an explicit retention gap when `afterSequence`
   * predates the oldest retained message.
   */
  async read(conversationId: string, afterSequence = 0, limit = 100): Promise<{ conversation: ConversationSummary; messages: ConversationMessage[]; next: number; latestSequence: number; gap?: { from: number; to: number } }> {
    await this.ensureLoaded();
    const conversation = this.require(conversationId);
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const ordered = [...conversation.messages].sort((a, b) => a.sequence - b.sequence);
    const firstAvailable = ordered[0]?.sequence;
    const page = ordered.filter((m) => m.sequence > afterSequence).slice(0, boundedLimit);
    const lastDelivered = page.at(-1)?.sequence ?? afterSequence;
    const latest = ordered.at(-1)?.sequence ?? conversation.lastSequence;
    return {
      conversation: { id: conversation.id, title: conversation.title, participants: clone(conversation.participants), createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, lastSequence: conversation.lastSequence, messageCount: conversation.messages.length },
      messages: clone(page),
      next: lastDelivered,
      latestSequence: latest,
      ...(firstAvailable !== undefined && afterSequence + 1 < firstAvailable ? { gap: { from: afterSequence + 1, to: firstAvailable - 1 } } : {}),
    };
  }

  /** Read-modify-write against current on-disk state under one exclusive lock (AI-02/10, AIR-02).
   *  The complete disk snapshot IS the transaction base: the in-memory map is refreshed from
   *  disk inside the lock before `fn` runs, with no timestamp comparison, so a same-millisecond
   *  writer's committed record can never be dropped by our stale copy. */
  private async transact<T>(fn: () => T): Promise<T> {
    return withStateLock(this.file, 'conversations', async () => {
      await this.refreshFromDisk();
      const result = fn();
      await this.persistLocked();
      return result;
    });
  }

  private async persistLocked(): Promise<void> {
    await atomicWriteJson(this.file, { version: 2, conversations: [...this.conversations.values()] });
    this.diskSignature = await this.currentSignature();
  }

  private require(id: string): Conversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new Error(`Unknown conversation ${id}`);
    return conversation;
  }

  /**
   * Crash-recovery reconciliation (second readiness review blockers 2 and 3).
   *
   * Selection: records whose delivery is 'queued' (persisted, receipt phase never ran) or
   * 'delivery_unknown' (dispatch outcome never learned). Terminal records ('completed',
   * 'rejected') are never touched. A 'queued' record whose dispatch is still IN FLIGHT in
   * this process (marked via markDispatchStarted, called by send() around the provider
   * call) is skipped — a queued record is not proof of a crash; the in-flight marker is the
   * dispatch-interrupt identity. Queued records with no in-flight marker ARE interrupted
   * dispatches by definition: persist-before-send means the only way a record stays queued
   * across a reconcile call is that the process died between persist and receipt.
   *
   * Receipt application: an observed receipt from the caller (e.g. re-verified against the
   * provider) resolves EITHER state — a verified completed receipt closes a delivery_unknown
   * record as 'completed'; an accepted-but-not-completed receipt closes it as 'queued'
   * delivery confirmed (transport accepted; provider turn state is observable via events).
   * A rejected receipt closes it as 'rejected'.
   *
   * Return semantics: an entry is returned for every candidate record, with resolved:true
   * only when THIS call actually transitioned the record to a terminal or receipt-confirmed
   * state — not merely because a receipt was passed in.
   *
   * Records are NEVER automatically resent: reconciliation reclassifies and closes records;
   * re-delivery is a separate, explicit caller decision.
   */
  async reconcileInterruptedSends(conversationId?: string, observedReceipts?: Array<{ idempotencyKey: string; receipt: OperationReceipt }>): Promise<Array<{ message: ConversationMessage; resolved: boolean; previousDelivery: DeliveryState } >> {
    const receipts = new Map((observedReceipts ?? []).map((entry) => [entry.idempotencyKey, entry.receipt]));
    const resolvedIds = new Set<string>();
    const skippedInFlight = new Set<string>();
    const previousDeliveries = new Map<string, DeliveryState>();
    await this.transact(() => {
      const candidates = [...this.conversations.values()]
        .filter((conversation) => !conversationId || conversation.id === conversationId)
        .flatMap((conversation) => conversation.messages.filter((message) => message.delivery === 'queued' || message.delivery === 'delivery_unknown'));
      for (const stored of candidates) {
        const conversation = this.conversations.get(stored.conversationId);
        const message = conversation?.messages.find((m) => m.id === stored.id);
        if (!message) continue;
        const previousDelivery = message.delivery!;
        previousDeliveries.set(message.id, previousDelivery);
        // In-flight protection: an actively dispatching send() in this process has marked
        // its record; that queued record is healthy, not crashed. Cross-process in-flight
        // dispatches are transient by construction (a live dispatch completes or classifies
        // its record before its owning process exits the registry.send call) and cannot be
        // distinguished from a crash by another process — the honest classification for an
        // unmarked queued record observed by a second process is delivery_unknown, which is
        // exactly what reconciliation assigns; if the original dispatch later completes, its
        // receipt transaction overwrites the classification (send() writes the receipt for
        // its own message ID unconditionally on return).
        if (previousDelivery === 'queued' && this.inFlightDispatches.has(message.id)) { skippedInFlight.add(message.id); continue; }
        const observed = receipts.get(message.idempotencyKey ?? '');
        if (observed) {
          message.receipt = observed;
          message.delivery = observed.accepted ? (observed.status === 'completed' ? 'completed' : 'queued') : 'rejected';
          resolvedIds.add(message.id);
        } else if (message.delivery === 'queued') {
          // Interrupted dispatch with no observed outcome: the provider may or may not have
          // executed the prompt. Reclassify honestly; never resend automatically.
          message.delivery = 'delivery_unknown';
          message.deliveryUnknownAt = stamp();
        }
        // delivery_unknown without an observed receipt stays delivery_unknown (unchanged;
        // resolved stays false).
        if (conversation) conversation.updatedAt = stamp();
        void previousDelivery;
      }
      return null;
    });
    await this.ensureLoaded();
    const out: Array<{ message: ConversationMessage; resolved: boolean; previousDelivery: DeliveryState }> = [];
    for (const conversation of this.conversations.values()) {
      if (conversationId && conversation.id !== conversationId) continue;
      for (const message of conversation.messages) {
        const previousDelivery = previousDeliveries.get(message.id);
        if (previousDelivery === undefined || skippedInFlight.has(message.id)) continue; // not a candidate, or healthy in-flight work
        out.push({ message: clone(message), resolved: resolvedIds.has(message.id), previousDelivery });
      }
    }
    return out;
  }

  /** In-flight dispatch markers: message IDs whose provider call is currently executing in
   *  this process. Reconciliation skips these — a queued record with an active dispatch is
   *  healthy, not crashed (blocker 3: do not reclassify in-flight sends as interrupted). */
  private readonly inFlightDispatches = new Set<string>();

  /** Called by send() around the provider call; exposed for testing in-flight protection. */
  markDispatchStarted(messageId: string): void { this.inFlightDispatches.add(messageId); }
  markDispatchFinished(messageId: string): void { this.inFlightDispatches.delete(messageId); }

  // AIR-01: routing uses the joined participant record resolved under the transaction; the
  // composite participant ID is never interpreted as a provider or native session ID.
  private async resolveDestination(conversationId: string, recipient: string): Promise<{ provider: ProviderId; nativeId: string }> {
    await this.ensureLoaded();
    const conversation = this.conversations.get(conversationId);
    const participant = conversation?.participants.find((value) => value.id === recipient);
    if (!participant) throw new Error(`Unknown conversation recipient ${recipient}`);
    return { provider: participant.provider, nativeId: participant.nativeId };
  }
}
