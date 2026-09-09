/**
 * Provider/toolset profiles (audit backlog item 5).
 *
 * A profile selects which tools a write-enabled server registers so hosts with context
 * constraints can expose a compact core catalog instead of the full 44-tool surface.
 * Profiles only ever REMOVE tools; they never redefine behavior, so a tool present in
 * two profiles behaves identically. The default profile is `full`, which is exactly the
 * pre-profiles catalog — existing clients see no change (compatibility contract).
 *
 * - `core`: discovery, session control, observation, handoffs, and evidence. Legacy
 *   per-provider Freebuff thread tools and coordinator bookkeeping tools are omitted.
 * - `legacy`: the core set plus the pre-unification Freebuff thread tools and the
 *   conversation coordinator; a bridge for clients built against the older surface.
 * - `full` (default): every tool, identical to the pre-profiles server.
 *
 * Read-only mode is orthogonal: it strips all mutation tools from whichever profile is
 * active, exactly as before.
 */

export type ProfileId = 'core' | 'legacy' | 'full';

export const PROFILE_IDS: readonly ProfileId[] = ['core', 'legacy', 'full'];

/** Every registered write tool except work/evidence/review/verification administration. */
const CORE_TOOLS = [
  // Unified provider session control
  'agent_send',
  'agent_cancel',
  'session_create',
  'session_resume',
  'permission_respond',
  'session_set_model',
  'session_set_reasoning',
  // Coordinator flows (directed messaging + handoffs)
  'conversation_send',
  'conversation_reconcile',
  'handoff_create',
  'work_create',
  'work_verify',
  'review_create',
  'review_request',
] as const;

/** Legacy-only tools: per-provider Freebuff thread controls and coordinator bookkeeping. */
const LEGACY_ONLY_TOOLS = [
  'send_message',
  'stop_thread',
  'resume_thread',
  'set_model',
  'set_reasoning',
  'conversation_create',
  'conversation_join',
] as const;

const FULL_TOOLS = [...CORE_TOOLS, ...LEGACY_ONLY_TOOLS];

export function profileToolset(profile: ProfileId): ReadonlySet<string> {
  switch (profile) {
    case 'core': return new Set(CORE_TOOLS);
    case 'legacy': return new Set([...CORE_TOOLS, ...LEGACY_ONLY_TOOLS]);
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
    case 'core': return 'Core: unified provider control, coordinator messaging, handoffs, and work/evidence tools. Legacy Freebuff thread tools are omitted.';
    case 'legacy': return 'Legacy: core plus per-provider Freebuff thread tools and conversation bookkeeping, for clients built on the older surface.';
    case 'full': return 'Full: every tool the runtime offers (the default, unchanged from before profiles existed).';
  }
}
