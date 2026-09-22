/**
 * Capability-oriented MCP tool profiles.
 *
 * Profiles gate BOTH read and write tools. This matters because MCP clients generally
 * serialize every visible tool schema into model context even when the tool is never used.
 * Existing core/legacy/full names remain supported; minimal and freebuff add narrower
 * surfaces for low-context and provider-specific deployments.
 */
export type ProfileId = 'minimal' | 'core' | 'freebuff' | 'legacy' | 'full';

export const PROFILE_IDS: readonly ProfileId[] = ['minimal', 'core', 'freebuff', 'legacy', 'full'];

const STATUS = ['freebuff_status'] as const;

const INTEROP_READS = [
  'list_agents',
  'list_agent_sessions',
  'get_agent_diff',
  'events_read',
  'permission_pending',
] as const;

const COORDINATION_READS = [
  'get_work_graph',
  'evidence_list',
  'work_list',
  'work_get',
  'handoff_packet',
  'conversation_list',
  'conversation_read',
] as const;

const INTEROP_WRITES = [
  'agent_send',
  'agent_cancel',
  'session_create',
  'session_resume',
  'permission_respond',
  'session_set_model',
  'session_set_reasoning',
] as const;

const COORDINATION_WRITES = [
  'conversation_create',
  'conversation_join',
  'conversation_send',
  'conversation_reconcile',
  'handoff_create',
  'work_create',
  'work_verify',
  'review_create',
  'review_request',
] as const;

const FREEBUFF_READS = [
  'list_projects',
  'list_threads',
  'get_thread',
  'get_thread_messages',
  'get_active_work',
  'get_thread_progress',
  'watch_thread',
  'get_thread_progress_summary',
  'watch_active_threads',
  'list_project_files',
  'read_project_file',
  'list_models',
] as const;

const FREEBUFF_WRITES = [
  'send_message',
  'stop_thread',
  'resume_thread',
  'set_model',
  'set_reasoning',
] as const;

const MINIMAL_TOOLS = [...STATUS, ...INTEROP_READS, ...INTEROP_WRITES];
const CORE_TOOLS = [...MINIMAL_TOOLS, ...COORDINATION_READS, ...COORDINATION_WRITES];
const FREEBUFF_TOOLS = [...STATUS, ...FREEBUFF_READS, ...FREEBUFF_WRITES];
const LEGACY_TOOLS = [...CORE_TOOLS, ...FREEBUFF_READS, ...FREEBUFF_WRITES];
const FULL_TOOLS = [...LEGACY_TOOLS];

export function profileToolset(profile: ProfileId): ReadonlySet<string> {
  switch (profile) {
    case 'minimal': return new Set(MINIMAL_TOOLS);
    case 'core': return new Set(CORE_TOOLS);
    case 'freebuff': return new Set(FREEBUFF_TOOLS);
    case 'legacy': return new Set(LEGACY_TOOLS);
    case 'full': return new Set(FULL_TOOLS);
  }
}

export function parseProfile(value: string | undefined): ProfileId {
  const normalized = (value ?? 'full').trim().toLowerCase();
  if (PROFILE_IDS.includes(normalized as ProfileId)) return normalized as ProfileId;
  throw new Error(`Unknown toolset profile '${value}'. Supported profiles: ${PROFILE_IDS.join(', ')}. Set INTEROP_TOOLS_PROFILE or pass --profile.`);
}

export function activeProfile(): ProfileId {
  return parseProfile(process.env.INTEROP_TOOLS_PROFILE);
}

export function profileDescription(profile: ProfileId): string {
  switch (profile) {
    case 'minimal': return 'Minimal: native provider discovery/control, bounded events/diffs, and permission handling only.';
    case 'core': return 'Core: minimal provider control plus durable conversations, work, handoffs, evidence, reviews, and verification. Freebuff-specific project/thread tools are omitted.';
    case 'freebuff': return 'Freebuff: only Freebuff project/thread/file/model tools plus status.';
    case 'legacy': return 'Legacy: core plus the complete Freebuff-specific surface; preserves the previous broad catalog.';
    case 'full': return 'Full: every tool the runtime offers.';
  }
}
