/**
 * Capability-oriented MCP tool profiles.
 *
 * Profiles gate BOTH read and write tools. This matters because MCP clients generally
 * serialize every visible tool schema into model context even when the tool is never used.
 * Minimal is the default, while core, Freebuff-specific, full, and legacy catalogs
 * remain available for clients that need more tools or the original 0.3.x names.
 */
export type ProfileId = 'minimal' | 'core' | 'freebuff' | 'legacy' | 'full';

export const PROFILE_IDS: readonly ProfileId[] = ['minimal', 'core', 'freebuff', 'legacy', 'full'];

const STATUS = ['freebuff_status'] as const;

// Keep the default profile focused on the modern, common transport surface.
// Compatibility controls remain available in the legacy profile for migration.
const CORE_INTEROP_READS = [
  'list_agents',
  'list_agent_sessions',
  'get_agent_diff',
  'events_page',
] as const;

const CORE_INTEROP_WRITES = [
  'agent_send',
  'agent_cancel',
  'session_create',
  'session_resume',
] as const;

const OPTIONAL_NATIVE_TOOLS = [
  'events_read',
  'permission_pending',
  'permission_respond',
  'session_set_model',
  'session_set_reasoning',
] as const;

// Retained only for clients migrating from 0.3.x. Modern profiles merge these
// variants into their cursor-aware or parameterized equivalents.
const LEGACY_ONLY_TOOLS = new Set(['events_read', 'watch_thread', 'watch_active_threads']);

const COORDINATION_READS = [
  'get_work_graph',
  'evidence_list',
  'evidence_get',
  'work_list',
  'work_get',
  'handoff_packet',
  'conversation_list',
  'conversation_read',
  'claim_list',
] as const;

const COORDINATION_WRITES = [
  'conversation_create',
  'conversation_join',
  'conversation_send',
  'conversation_reconcile',
  'handoff_create',
  'handoff_update_status',
  'work_create',
  'work_verify',
  'review_create',
  'review_request',
  'claim_acquire',
  'claim_release',
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

const MINIMAL_TOOLS = [...STATUS, ...CORE_INTEROP_READS, ...CORE_INTEROP_WRITES];
const CORE_TOOLS = [...MINIMAL_TOOLS, ...COORDINATION_READS, ...COORDINATION_WRITES];
const FREEBUFF_TOOLS = [...STATUS, ...FREEBUFF_READS, ...FREEBUFF_WRITES];
const LEGACY_TOOLS = [...CORE_TOOLS, ...OPTIONAL_NATIVE_TOOLS, ...FREEBUFF_READS, ...FREEBUFF_WRITES];
const FULL_TOOLS = LEGACY_TOOLS.filter((name) => !LEGACY_ONLY_TOOLS.has(name));

/** Stable verb-resource names for the modern profiles; keys are 0.3.x internal names. */
export const MODERN_TOOL_NAMES: Readonly<Record<string, string>> = {
  freebuff_status: 'get_runtime_status', list_agents: 'list_providers', list_agent_sessions: 'list_agent_sessions',
  get_agent_diff: 'get_session_diff', events_page: 'read_session_events',
  evidence_list: 'list_evidence', evidence_get: 'get_evidence', work_list: 'list_work', work_get: 'get_work',
  handoff_packet: 'get_handoff_packet', conversation_list: 'list_conversations', conversation_read: 'read_conversation',
  claim_list: 'list_claims', permission_pending: 'list_pending_permissions', send_message: 'send_thread_message',
  set_model: 'set_thread_model', set_reasoning: 'set_thread_reasoning', agent_send: 'send_session_message',
  agent_cancel: 'cancel_session', session_create: 'create_session', session_resume: 'resume_session',
  permission_respond: 'respond_to_permission', session_set_model: 'set_session_model',
  session_set_reasoning: 'set_session_reasoning', conversation_create: 'create_conversation',
  conversation_reconcile: 'reconcile_conversation_sends', conversation_join: 'join_conversation',
  conversation_send: 'send_conversation_message', work_create: 'create_work', handoff_create: 'create_handoff',
  handoff_update_status: 'update_handoff_status', review_create: 'create_review', claim_acquire: 'acquire_claim',
  claim_release: 'release_claim', review_request: 'request_review', work_verify: 'verify_work',
};

export function exposedToolName(profile: ProfileId, name: string): string {
  return profile === 'legacy' ? name : MODERN_TOOL_NAMES[name] ?? name;
}

export function profileToolset(profile: ProfileId): ReadonlySet<string> {
  switch (profile) {
    case 'minimal': return new Set(MINIMAL_TOOLS);
    case 'core': return new Set(CORE_TOOLS);
    case 'freebuff': return new Set(FREEBUFF_TOOLS.filter((name) => !LEGACY_ONLY_TOOLS.has(name)));
    case 'legacy': return new Set(LEGACY_TOOLS);
    case 'full': return new Set(FULL_TOOLS);
  }
}

export function parseProfile(value: string | undefined): ProfileId {
  const normalized = (value ?? 'minimal').trim().toLowerCase();
  if (PROFILE_IDS.includes(normalized as ProfileId)) return normalized as ProfileId;
  throw new Error(`Unknown toolset profile '${value}'. Supported profiles: ${PROFILE_IDS.join(', ')}. Set INTEROP_TOOLS_PROFILE or pass --profile.`);
}

export function activeProfile(): ProfileId {
  return parseProfile(process.env.INTEROP_TOOLS_PROFILE);
}

export function profileDescription(profile: ProfileId): string {
  switch (profile) {
    case 'minimal': return 'Minimal: the recommended nine-tool provider discovery, native session, diff, event, and session action surface.';
    case 'core': return 'Core: provider controls plus durable conversations, work, handoffs, evidence, reviews, claims, and verification.';
    case 'freebuff': return 'Freebuff: Freebuff project, thread, file, model, and progress tools.';
    case 'legacy': return 'Legacy: the original 0.3.x tool names and operations for existing MCP clients.';
    case 'full': return 'Full: every modern tool, including Freebuff-specific and coordination features.';
  }
}
