import fs from 'node:fs/promises';
import path from 'node:path';
import type { Json } from './types.js';
import type { ProviderId, EvidenceRecord, AgentSession, WorkGraphSnapshot } from './interop.js';
import { runVerification, type VerificationResult } from './verification.js';

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
  createdAt: string;
}

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json;

export class WorkflowStore {
  private works = new Map<string, WorkRecord>();
  private evidence = new Map<string, Evidence>();
  private handoffs = new Map<string, Handoff>();
  private reviews = new Map<string, Review>();
  constructor(private readonly file?: string) {}
  async load(): Promise<void> { if (!this.file) return; try { const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, unknown>; for (const item of Array.isArray(raw.works) ? raw.works : []) { const w = item as WorkRecord; this.works.set(w.id, w); } for (const item of Array.isArray(raw.evidence) ? raw.evidence : []) { const e = item as Evidence; this.evidence.set(e.id, e); } for (const item of Array.isArray(raw.handoffs) ? raw.handoffs : []) { const h = item as Handoff; this.handoffs.set(h.id, h); } for (const item of Array.isArray(raw.reviews) ? raw.reviews : []) { const r = item as Review; this.reviews.set(r.id, r); } } catch { /* first run or corrupt optional state stays empty */ } }
  private async save(): Promise<void> { if (!this.file) return; await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }); const value = { works: [...this.works.values()], evidence: [...this.evidence.values()], handoffs: [...this.handoffs.values()], reviews: [...this.reviews.values()] }; const temp = `${this.file}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 }); await fs.rename(temp, this.file); if (process.platform !== 'win32') await fs.chmod(this.file, 0o600); }
  async createWork(input: Pick<WorkRecord, 'objective' | 'acceptanceCriteria'> & Partial<Pick<WorkRecord, 'sourceSession' | 'risks' | 'unresolvedQuestions'>>): Promise<WorkRecord> { const stamp = now(); const work: WorkRecord = { id: id('work'), objective: input.objective, acceptanceCriteria: input.acceptanceCriteria, sourceSession: input.sourceSession, status: 'open', changedFiles: [], risks: input.risks ?? [], unresolvedQuestions: input.unresolvedQuestions ?? [], evidenceIds: [], createdAt: stamp, updatedAt: stamp }; this.works.set(work.id, work); await this.save(); return work; }
  async getWork(workId: string): Promise<WorkRecord | null> { return this.works.get(workId) ?? null; }
  async listWorks(): Promise<WorkRecord[]> { return [...this.works.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async addEvidence(input: Omit<Evidence, 'id' | 'capturedAt'>): Promise<Evidence> { const evidence: Evidence = { ...input, id: id('evidence'), capturedAt: now(), data: json(input.data) }; this.evidence.set(evidence.id, evidence); if (input.workId) { const work = this.works.get(input.workId); if (work) { work.evidenceIds.push(evidence.id); work.updatedAt = evidence.capturedAt; } } await this.save(); return evidence; }
  async listEvidence(workId?: string): Promise<Evidence[]> { return [...this.evidence.values()].filter((e) => !workId || e.workId === workId).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)); }
  async createHandoff(input: Omit<Handoff, 'id' | 'createdAt' | 'status'>): Promise<Handoff> { const handoff: Handoff = { ...input, id: id('handoff'), createdAt: now(), status: 'created' }; this.handoffs.set(handoff.id, handoff); const work = this.works.get(input.workId); if (work) { work.destinationSession = input.destinationSession; work.status = 'in_progress'; work.updatedAt = handoff.createdAt; } await this.save(); return handoff; }
  async listHandoffs(workId?: string): Promise<Handoff[]> { return [...this.handoffs.values()].filter((h) => !workId || h.workId === workId); }
  async createReview(input: Omit<Review, 'id' | 'createdAt'>): Promise<Review> { const review: Review = { ...input, id: id('review'), createdAt: now() }; this.reviews.set(review.id, review); await this.addEvidence({ workId: input.workId, sessionId: input.reviewerSessionId, kind: 'review', trust: 'provider_observed', source: { adapter: input.reviewerSessionId.split(':')[0] ?? 'unknown' }, summary: `Review verdict ${input.verdict}`, data: review as unknown as Json }); await this.save(); return review; }
  async listReviews(workId?: string): Promise<Review[]> { return [...this.reviews.values()].filter((r) => !workId || r.workId === workId); }
  async verify(workId: string, cwd: string, commands: string[]): Promise<VerificationResult[]> { const work = this.works.get(workId); if (!work) throw new Error(`Unknown work ${workId}`); const names = ['test', 'lint', 'typecheck', 'build'] as const; const configured = Object.fromEntries(commands.slice(0, names.length).map((command, index) => { const [executable, ...args] = command.trim().split(/\s+/); if (!executable) throw new Error('Verification commands must not be empty'); return [names[index], { executable, args, cwd }]; })); const result = await runVerification({ cwd, commands: configured }); for (const command of result.commands) { const kind: EvidenceKind = command.name === 'test' ? 'test' : command.name === 'build' ? 'build' : command.name === 'lint' ? 'lint' : 'typecheck'; await this.addEvidence({ workId, kind, trust: 'runtime_observed', source: { adapter: 'agent-interop-runtime', protocol: 'local process' }, summary: `${command.command} exited ${command.exitCode ?? 'unknown'}`, data: command as unknown as Json }); } const passed = result.commands.length > 0 && result.commands.every((command) => command.exitCode === 0); work.status = passed ? 'accepted' : 'blocked'; work.updatedAt = now(); await this.save(); return [result]; }
  async graph(sessions: AgentSession[] = []): Promise<WorkGraphSnapshot & { works: WorkRecord[]; handoffs: Handoff[]; reviews: Review[] }> { const evidence = [...this.evidence.values()]; const edges: WorkGraphSnapshot['edges'] = evidence.filter((e) => e.workId).map((e) => ({ from: e.workId!, to: e.id, kind: 'evidence' as const })); for (const handoff of this.handoffs.values()) { if (handoff.destinationSession) edges.push({ from: handoff.sourceSession, to: handoff.destinationSession, kind: 'handoff' }); } for (const review of this.reviews.values()) edges.push({ from: review.reviewerSessionId, to: review.workId, kind: 'review' }); return { sessions, edges, evidence: evidence as unknown as EvidenceRecord[], works: [...this.works.values()], handoffs: [...this.handoffs.values()], reviews: [...this.reviews.values()] }; }
}
