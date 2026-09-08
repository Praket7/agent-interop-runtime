import type { Json, ProjectSummary, ThreadDetail, ThreadProgressSnapshot, ThreadSummary } from './types.js';

export type ProviderId = 'freebuff' | 'opencode' | 'codex' | 'claude-code';
export type CapabilityState = 'available' | 'unavailable' | 'degraded' | 'unknown';

export interface CapabilityRecord {
  supported: boolean;
  state: CapabilityState;
  transport?: string;
  protocol?: string;
  reason?: string;
}

export interface AgentCapabilities {
  provider: ProviderId;
  adapterVersion: string;
  providerVersion?: string;
  authorization: 'authorized' | 'unauthorized' | 'unknown';
  discovery: CapabilityRecord;
  sessions: CapabilityRecord;
  sendMessage: CapabilityRecord;
  steer: CapabilityRecord;
  cancel: CapabilityRecord;
  events: CapabilityRecord;
  diff: CapabilityRecord;
  permissions: CapabilityRecord;
  model: CapabilityRecord;
  reasoning: CapabilityRecord;
  limitations: string[];
}

export interface AgentSession extends ThreadSummary {
  provider: ProviderId;
  nativeId: string;
  transport?: string;
  cwd?: string;
  provenance: { discoveredAt: string; source: string; native: true };
}

export interface OperationReceipt { provider: ProviderId; nativeId: string; operation: string; accepted: boolean; status?: 'accepted' | 'queued' | 'completed' | 'rejected'; providerState?: string; detail?: Json; }
export interface AgentSendOptions { model?: { providerID: string; modelID: string }; agent?: string; reasoning?: string; }
export interface AgentEvent { provider: ProviderId; nativeId: string; sequence: number; timestamp: string; type: string; data: Json; }

export interface AgentAdapter {
  readonly id: ProviderId;
  capabilities(): Promise<AgentCapabilities>;
  listSessions(): Promise<AgentSession[]>;
  getSession(nativeId: string): Promise<AgentSession | null>;
  createSession?(options: { cwd?: string; title?: string }): Promise<AgentSession>;
  resumeSession?(nativeId: string): Promise<AgentSession>;
  send?(nativeId: string, text: string, options?: AgentSendOptions): Promise<OperationReceipt>;
  steer?(nativeId: string, text: string, options?: AgentSendOptions): Promise<OperationReceipt>;
  cancel?(nativeId: string): Promise<OperationReceipt>;
  events?(nativeId: string): AsyncIterable<AgentEvent>;
  getDiff?(nativeId: string): Promise<Json | null>;
  respondPermission?(nativeId: string, requestId: string, decision: string): Promise<OperationReceipt>;
  setModel?(nativeId: string, model: string): Promise<OperationReceipt>;
  setReasoning?(nativeId: string, effort: string): Promise<OperationReceipt>;
  dispose?(): void;
}

export interface EvidenceRecord {
  id: string;
  provider: ProviderId;
  nativeId: string;
  kind: 'session' | 'event' | 'diff' | 'verification';
  capturedAt: string;
  trust: 'agent_claim' | 'provider_observed' | 'runtime_observed' | 'repository_verified' | 'external_verified' | 'human_accepted' | 'native' | 'observed' | 'verified';
  summary: string;
  data: Json;
}

export interface WorkGraphSnapshot {
  sessions: AgentSession[];
  edges: Array<{ from: string; to: string; kind: 'handoff' | 'review' | 'parent' | 'evidence' | 'depends_on' | 'verifies' | 'supersedes' | 'blocks' | 'shares_workspace_with' }>;
  evidence: EvidenceRecord[];
}

export type RuntimeView = Pick<ThreadDetail, 'id' | 'title' | 'state' | 'model' | 'metadata' | 'live'> & { provider: ProviderId; nativeId: string };
export type LegacyRuntime = { capabilities(): Promise<unknown>; listProjects(): Promise<ProjectSummary[]>; listThreads(projectId?: string): Promise<ThreadSummary[]>; getThread(id: string): Promise<ThreadDetail>; getThreadProgress(id: string, after?: number, limit?: number): Promise<ThreadProgressSnapshot>; };
