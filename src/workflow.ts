import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Json } from './types.js';
import type { AgentSession, WorkGraphSnapshot } from './interop.js';
import { runVerification, type VerificationResult, type VerificationCommands } from './verification.js';
import { atomicWriteJson, withStateLock } from './state.js';
import { countJsonTokens, TOKENIZER_NAME } from './tokens.js';

export type EvidenceTrust = 'agent_claim' | 'provider_observed' | 'runtime_observed' | 'repository_verified' | 'external_verified' | 'human_accepted';
export type EvidenceKind = 'diff' | 'file_change' | 'command' | 'test' | 'build' | 'review' | 'artifact' | 'approval' | 'lint' | 'typecheck' | 'session';

export interface Evidence {
  id: string;
  workId?: string;
  sessionId?: string;
  kind: EvidenceKind;
  trust: EvidenceTrust;
  source: { adapter: string; protocol?: string; nativeEventId?: string };
  capturedAt: string;
  summary: string;
  data: Json;
}

export interface WorkRecord {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  sourceSession?: string;
  destinationSession?: string;
  status: 'open' | 'in_progress' | 'blocked' | 'accepted' | 'rejected';
  changedFiles: string[];
  risks: string[];
  unresolvedQuestions: string[];
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Handoff {
  id: string;
  workId: string;
  sourceSession: string;
  destinationSession?: string;
  objective: string;
  acceptanceCriteria: string[];
  evidenceIds: string[];
  changedFiles: string[];
  risks: string[];
  unresolvedQuestions: string[];
  authorityBoundaries: string[];
  status: 'created' | 'accepted' | 'completed' | 'blocked';
  /**
   * Token-budget accounting (audit §7 bounded handoff packet): the durable record keeps
   * every field (never silently loses constraints), and `contextTokens`/`omittedFields`
   * describe the DELIVERY PACKET built by `handoffPacket` — fields whose serialized form
   * would exceed the budget are listed explicitly so the caller can trim or fetch them.
   */
  contextTokens: number;
  tokenBudget: number;
  omittedFields: string[];
  createdAt: string;
}

export interface ReviewFinding { id: string; severity: 'blocking' | 'major' | 'minor' | 'note'; title: string; detail: string; file?: string; line?: number; }
export interface Review {
  id: string;
  workId: string;
  subjectEvidenceIds: string[];
  reviewerSessionId: string;
  independence: { differentSession: boolean; differentProvider: boolean; freshContext: boolean; writeAccess: boolean };
  findings: ReviewFinding[];
  verdict: 'approve' | 'changes_requested' | 'blocked';
  /** Provenance: caller-submitted reviews are never provider observations (AI-R1). */
  provenance: 'agent_claim' | 'provider_observed';
  createdAt: string;
}

export interface HandoffPacket {
  handoffId: string;
  workId: string;
  sourceSession: string;
  destinationSession?: string;
  objective?: string;
  acceptanceCriteria?: string[];
  authorityBoundaries?: string[];
  evidenceIds?: string[];
  changedFiles?: string[];
  unresolvedQuestions?: string[];
  risks?: string[];
  omissions: Array<{ field: string; reason: string }>;
  contextTokens: number;
  tokenBudget: number;
  tokenizer: string;
}

export type WorkSummary = Omit<WorkRecord, 'objective' | 'acceptanceCriteria' | 'risks' | 'unresolvedQuestions'> & { objectivePreview: string };
export type EvidenceSummary = Omit<Evidence, 'data'> & { dataBytes: number };

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json;

/** Structured verification entries (AI-08): no whitespace splitting, quoted args preserved. */
export interface VerificationRequest { executable: string; args?: string[]; cwd?: string; label?: string }
export const MAX_VERIFICATION_COMMANDS = 8;

export class WorkflowStore {
  private works = new Map<string, WorkRecord>();
  private evidence = new Map<string, Evidence>();
  private handoffs = new Map<string, Handoff>();
  private reviews = new Map<string, Review>();
  private recovery?: { required: true; file: string; preservedFile?: string; reason: string };
  private loaded = false;
  constructor(private readonly file?: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.file) { this.loaded = true; return; }
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, unknown>;
      this.adopt(raw);
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = true; return; }
      const reason = error instanceof Error ? error.message : String(error);
      let preservedFile: string | undefined;
      try { preservedFile = `${this.file}.corrupt-${Date.now()}`; await fs.rename(this.file, preservedFile); } catch { /* preserve the original if the filesystem cannot rename it */ }
      this.recovery = { required: true, file: this.file, preservedFile, reason };
      this.loaded = true;
    }
  }

  recoveryStatus(): { required: true; file: string; preservedFile?: string; reason: string } | null { return this.recovery ?? null; }

  private adopt(raw: Record<string, unknown>): void {
    for (const item of Array.isArray(raw.works) ? raw.works : []) { const w = item as WorkRecord; if (w?.id) this.works.set(w.id, w); }
    for (const item of Array.isArray(raw.evidence) ? raw.evidence : []) { const e = item as Evidence; if (e?.id) this.evidence.set(e.id, e); }
    for (const item of Array.isArray(raw.handoffs) ? raw.handoffs : []) { const h = item as Handoff; if (h?.id) this.handoffs.set(h.id, h); }
    for (const item of Array.isArray(raw.reviews) ? raw.reviews : []) { const r = item as Review; if (r?.id) this.reviews.set(r.id, r); }
  }

  private async transact<T>(fn: () => T): Promise<T> {
    await this.load();
    if (!this.file) return fn();
    const file = this.file;
    return withStateLock(file, 'workflow', async () => {
      // Read current on-disk state inside the lock so parallel writers never lose records (AI-10).
      try { this.adopt(JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const result = fn();
      const value = { works: [...this.works.values()], evidence: [...this.evidence.values()], handoffs: [...this.handoffs.values()], reviews: [...this.reviews.values()] };
      await atomicWriteJson(file, value);
      return result;
    });
  }

  private snapshot(): { works: WorkRecord[]; evidence: Evidence[]; handoffs: Handoff[]; reviews: Review[] } {
    return { works: [...this.works.values()], evidence: [...this.evidence.values()], handoffs: [...this.handoffs.values()], reviews: [...this.reviews.values()] };
  }

  async createWork(input: Pick<WorkRecord, 'objective' | 'acceptanceCriteria'> & Partial<Pick<WorkRecord, 'sourceSession' | 'risks' | 'unresolvedQuestions'>>): Promise<WorkRecord> {
    return this.transact(() => {
      const stamp = now();
      const work: WorkRecord = { id: id('work'), objective: input.objective, acceptanceCriteria: input.acceptanceCriteria, sourceSession: input.sourceSession, status: 'open', changedFiles: [], risks: input.risks ?? [], unresolvedQuestions: input.unresolvedQuestions ?? [], evidenceIds: [], createdAt: stamp, updatedAt: stamp };
      this.works.set(work.id, work);
      return work;
    });
  }

  async getWork(workId: string): Promise<WorkRecord | null> { await this.load(); return this.works.get(workId) ?? null; }

  /** Metadata-only list (token efficiency): previews instead of full objectives and criteria. */
  async listWorks(): Promise<WorkSummary[]> {
    await this.load();
    return [...this.works.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((work) => {
      const { objective, acceptanceCriteria, risks, unresolvedQuestions, ...rest } = work;
      void risks; void unresolvedQuestions;
      return { ...rest, objectivePreview: objective.slice(0, 200), acceptanceCriteriaCount: acceptanceCriteria.length } as WorkSummary & { acceptanceCriteriaCount: number };
    });
  }

  async addEvidence(input: Omit<Evidence, 'id' | 'capturedAt'>): Promise<Evidence> {
    return this.transact(() => {
      const evidence: Evidence = { ...input, id: id('evidence'), capturedAt: now(), data: json(input.data) };
      this.evidence.set(evidence.id, evidence);
      if (input.workId) {
        const work = this.works.get(input.workId);
        if (work && !work.evidenceIds.includes(evidence.id)) { work.evidenceIds.push(evidence.id); work.updatedAt = evidence.capturedAt; }
      }
      return evidence;
    });
  }

  async listEvidence(workId?: string): Promise<Evidence[]> { await this.load(); return [...this.evidence.values()].filter((e) => !workId || e.workId === workId).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)); }

  /** Metadata-only evidence list: contents are addressable by ID, not re-returned in bulk. */
  async listEvidenceSummaries(workId?: string): Promise<EvidenceSummary[]> {
    return (await this.listEvidence(workId)).map(({ data, ...rest }) => ({ ...rest, dataBytes: JSON.stringify(data ?? null).length }));
  }

  async createHandoff(input: Omit<Handoff, 'id' | 'createdAt' | 'status' | 'contextTokens' | 'tokenBudget' | 'omittedFields'>): Promise<Handoff> {
    return this.transact(async () => {
      const budget = parseTokenBudget();
      // AIR-05: the budget applies to the COMPLETE serialized delivery packet (routing
      // metadata, field names, omission explanations, and accounting included), measured
      // with the same named tokenizer a consumer would use. Mandatory fields (objective,
      // acceptance criteria, authority boundaries) are non-negotiable: if they cannot fit,
      // creation is rejected BEFORE delivery rather than shipping a handoff without its
      // essential instructions. Optional fields become explicit omissions.
      const mandatory = {
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        authorityBoundaries: input.authorityBoundaries,
      };
      const optional: Array<{ name: 'evidenceIds' | 'changedFiles' | 'unresolvedQuestions' | 'risks'; value: string[] }> = [
        { name: 'evidenceIds', value: input.evidenceIds },
        { name: 'changedFiles', value: input.changedFiles },
        { name: 'unresolvedQuestions', value: input.unresolvedQuestions },
        { name: 'risks', value: input.risks },
      ];
      // Collision-resistant ID with a FIXED length (randomUUID is always 36 chars): no two
      // handoffs — even in the same millisecond — share an ID, and the serialized packet
      // size is a pure function of content, so budget accounting is reproducible for
      // identical inputs without weakening identity uniqueness. Generated BEFORE measuring
      // so every accounting step uses the actual final ID, never a placeholder.
      const handoffId = `handoff_${randomUUID()}`;
      const buildPacket = (included: Array<{ name: string; value: unknown }>, omissions: Array<{ field: string; reason: string }>): HandoffPacket => ({
        handoffId, workId: input.workId, sourceSession: input.sourceSession, ...(input.destinationSession ? { destinationSession: input.destinationSession } : {}),
        ...mandatory,
        ...Object.fromEntries(included.map((f) => [f.name, f.value])),
        omissions,
        contextTokens: 0, tokenBudget: budget, tokenizer: TOKENIZER_NAME,
      });
      const measure = (included: Array<{ name: string; value: unknown }>, omissions: Array<{ field: string; reason: string }>) => countJsonTokens(buildPacket(included, omissions));
      const requiredTokens = measure([], []);
      if (requiredTokens > budget) {
        throw new Error(
          `Handoff exceeds its ${budget}-token delivery budget even with every optional field omitted ` +
          `(mandatory routing, objective, acceptance criteria, and authority boundaries measure ${requiredTokens} tokens). ` +
          'Raise INTEROP_HANDOFF_TOKEN_BUDGET or shorten the objective/criteria/boundaries; the handoff was NOT created.',
        );
      }
      const omission = (field: string) => ({ field, reason: `exceeds ${budget}-token handoff delivery budget; request field explicitly from work ${input.workId}` });
      const finalize = (included: Array<{ name: string; value: unknown }>, omissions: Array<{ field: string; reason: string }>): { packet: HandoffPacket; tokens: number } => {
        const packet = buildPacket(included, omissions);
        // Converge the self-referential contextTokens field: measure with 0, set, re-measure.
        let tokens = countJsonTokens(packet);
        for (let i = 0; i < 3; i += 1) {
          packet.contextTokens = tokens;
          const next = countJsonTokens(packet);
          if (next === tokens) break;
          tokens = next;
        }
        return { packet, tokens };
      };
      // Greedy fill of optional fields against the EXACT serialized size, including omissions
      // already declared and all accounting metadata. Declaring an omission also costs tokens;
      // if even the omission note cannot fit, creation fails explicitly rather than dropping
      // data without the required retrieval explanation.
      const included: Array<{ name: string; value: unknown }> = [];
      const omissions: Array<{ field: string; reason: string }> = [];
      for (const field of optional) {
        if (finalize([...included, field], omissions).tokens <= budget) { included.push(field); continue; }
        const withNote = [...omissions, omission(field.name)];
        if (finalize(included, withNote).tokens > budget) {
          throw new Error(
            `Handoff exceeds its ${budget}-token delivery budget: even the omission note for '${field.name}' does not fit ` +
            'alongside mandatory routing, objective, acceptance criteria, authority boundaries, and accounting. ' +
            'Raise INTEROP_HANDOFF_TOKEN_BUDGET or shorten the content; the handoff was NOT created.',
          );
        }
        omissions.push(omission(field.name));
      }
      const { packet, tokens: finalTokens } = finalize(included, omissions);
      if (finalTokens > budget) {
        throw new Error(
          `Handoff exceeds its ${budget}-token delivery budget (final packet measures ${finalTokens} tokens ` +
          'including mandatory routing, objective, acceptance criteria, authority boundaries, omission notes, and accounting). ' +
          'Raise INTEROP_HANDOFF_TOKEN_BUDGET or shorten the content; the handoff was NOT created.',
        );
      }
      const contextTokens = packet.contextTokens;
      const handoff: Handoff = { ...input, id: handoffId, status: 'created', contextTokens, tokenBudget: budget, omittedFields: omissions.map((o) => o.field), createdAt: now() };
      this.handoffs.set(handoff.id, handoff);
      const work = this.works.get(input.workId);
      if (work) { work.destinationSession = input.destinationSession; work.status = 'in_progress'; work.updatedAt = handoff.createdAt; }
      return handoff;
    });
  }

  /**
   * The bounded delivery packet for a handoff: exactly what a sender should put on the
   * wire. Mandatory fields are always present (creation is rejected otherwise, AIR-05);
   * optional fields recorded as omissions are replaced by an explicit explanation so the
   * recipient knows data exists and how to request it.
   */
  async handoffPacket(handoffId: string): Promise<HandoffPacket> {
    await this.load();
    const handoff = this.handoffs.get(handoffId);
    if (!handoff) throw new Error(`Unknown handoff ${handoffId}`);
    const full: Record<string, unknown> = {
      objective: handoff.objective,
      acceptanceCriteria: handoff.acceptanceCriteria,
      authorityBoundaries: handoff.authorityBoundaries,
      evidenceIds: handoff.evidenceIds,
      changedFiles: handoff.changedFiles,
      unresolvedQuestions: handoff.unresolvedQuestions,
      risks: handoff.risks,
    };
    const packet: HandoffPacket = { handoffId: handoff.id, workId: handoff.workId, sourceSession: handoff.sourceSession, ...(handoff.destinationSession ? { destinationSession: handoff.destinationSession } : {}), omissions: [], contextTokens: handoff.contextTokens, tokenBudget: handoff.tokenBudget, tokenizer: TOKENIZER_NAME };
    for (const name of handoff.omittedFields) packet.omissions.push({ field: name, reason: `exceeds ${handoff.tokenBudget}-token handoff budget; request field explicitly from work ${handoff.workId}` });
    for (const [name, value] of Object.entries(full)) if (!handoff.omittedFields.includes(name)) (packet as unknown as Record<string, unknown>)[name] = value;
    return packet;
  }

  async listHandoffs(workId?: string): Promise<Handoff[]> { await this.load(); return [...this.handoffs.values()].filter((h) => !workId || h.workId === workId); }

  /**
   * AI-R1: caller-submitted reviews are recorded as agent_claim, never provider_observed.
   * Only reviews observed through verified provider events may carry provider_observed trust.
   */
  async createReview(input: Omit<Review, 'id' | 'createdAt' | 'provenance'> & { provenance?: 'agent_claim' | 'provider_observed' }): Promise<Review> {
    const provenance = input.provenance ?? 'agent_claim';
    return this.transact(async () => {
      const review: Review = { ...input, provenance, id: id('review'), createdAt: now() };
      this.reviews.set(review.id, review);
      await this.addEvidence({
        workId: input.workId, sessionId: input.reviewerSessionId, kind: 'review',
        trust: provenance === 'provider_observed' ? 'provider_observed' : 'agent_claim',
        source: { adapter: input.reviewerSessionId.split(':')[0] ?? 'unknown', ...(provenance === 'provider_observed' ? {} : { protocol: 'caller submission' }) },
        summary: provenance === 'provider_observed' ? `Provider-observed review verdict ${input.verdict}` : `Caller-submitted review verdict ${input.verdict} (unverified provenance)`,
        data: review as unknown as Json,
      });
      return review;
    });
  }

  async listReviews(workId?: string): Promise<Review[]> { await this.load(); return [...this.reviews.values()].filter((r) => !workId || r.workId === workId); }

  /**
   * AI-08: every accepted command runs; input beyond the documented limit is rejected before
   * anything executes. Structured {executable,args,cwd} entries keep quoted arguments intact.
   * Verification-pass status is distinct from human acceptance of the objective.
   */
  async verify(workId: string, cwd: string, requests: Array<string | VerificationRequest>): Promise<VerificationResult[]> {
    if (requests.length > MAX_VERIFICATION_COMMANDS) throw new Error(`Verification accepts at most ${MAX_VERIFICATION_COMMANDS} commands; received ${requests.length}. Submit the remainder separately.`);
    if (!requests.length) throw new Error('Verification requires at least one command');
    const work = await this.getWork(workId);
    if (!work) throw new Error(`Unknown work ${workId}`);
    const names = ['test', 'lint', 'typecheck', 'build', 'extra1', 'extra2', 'extra3', 'extra4'] as const;
    const configured: VerificationCommands = Object.fromEntries(requests.map((request, index) => {
      const structured = typeof request === 'string' ? parseLegacyRequest(request) : request;
      const executable = structured.executable?.trim();
      if (!executable) throw new Error('Verification commands must not be empty');
      const name = index < 4 ? names[index]! : `check${index - 3}` as (typeof names)[number];
      return [name, { executable, args: structured.args ?? [], cwd: structured.cwd ?? cwd, ...(structured.label ? { label: structured.label } : {}) }];
    }));
    const result = await runVerification({ cwd, commands: configured });
    for (const command of result.commands) {
      const kind: EvidenceKind = command.name === 'test' ? 'test' : command.name === 'build' ? 'build' : command.name === 'lint' ? 'lint' : 'typecheck';
      await this.addEvidence({ workId, kind, trust: 'runtime_observed', source: { adapter: 'agent-interop-runtime', protocol: 'local process' }, summary: `${command.command} exited ${command.exitCode ?? 'unknown'}`, data: command as unknown as Json });
    }
    const passed = result.commands.length > 0 && result.commands.every((command) => command.exitCode === 0);
    return this.transact(() => {
      const record = this.works.get(workId);
      // Verification success blocks only the 'blocked' state; it never marks human acceptance.
      if (record) { record.status = passed ? (record.status === 'accepted' ? 'accepted' : 'in_progress') : 'blocked'; record.updatedAt = now(); }
      return [result];
    });
  }

  async graph(sessions: AgentSession[] = []): Promise<WorkGraphSnapshot & { works: WorkRecord[]; handoffs: Handoff[]; reviews: Review[] }> {
    await this.load();
    const snap = this.snapshot();
    const edges: WorkGraphSnapshot['edges'] = snap.evidence.filter((e) => e.workId).map((e) => ({ from: e.workId!, to: e.id, kind: 'evidence' as const }));
    for (const handoff of snap.handoffs) { if (handoff.destinationSession) edges.push({ from: handoff.sourceSession, to: handoff.destinationSession, kind: 'handoff' }); }
    for (const review of snap.reviews) edges.push({ from: review.reviewerSessionId, to: review.workId, kind: 'review' });
    return { sessions, edges, evidence: snap.evidence as unknown as WorkGraphSnapshot['evidence'], works: snap.works, handoffs: snap.handoffs, reviews: snap.reviews };
  }
}

/** Legacy string form: quote-aware tokens; shell metacharacters are rejected. */
function parseLegacyRequest(command: string): Omit<VerificationRequest, 'name'> {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  const executable = tokens.shift();
  if (!executable || /[;&|<>`$]/.test(command)) throw new Error(`Unsafe verification command: ${command}`);
  return { executable, args: tokens };
}

/** Handoff token budget: INTEROP_HANDOFF_TOKEN_BUDGET overrides the 2,000-token default. */
function parseTokenBudget(): number {
  const raw = process.env.INTEROP_HANDOFF_TOKEN_BUDGET;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed >= 100) return Math.floor(parsed);
  return 2_000;
}
