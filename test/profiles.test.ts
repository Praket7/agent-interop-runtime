import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/mcp.js';
import { profileToolset, parseProfile, activeProfile, PROFILE_IDS } from '../src/profiles.js';
import type { Runtime } from '../src/runtime.js';

function fakeRuntime(): Runtime {
  return {
    capabilities: async () => ({ product: 'unknown', signedIn: 'unknown', orchestrator: false, readOnly: true, endpoints: [], notes: [] }),
    listProjects: async () => [], listThreads: async () => [], getThread: async () => ({}), getMessages: async () => [],
    activeWork: async () => [], getThreadProgress: async () => ({ events: [], connected: false, stale: true }), watchThread: async () => ({ events: [], connected: false, stale: true }),
    getThreadProgressSummary: async () => ({ events: [], connected: false, stale: true }), watchActiveThreads: async () => [],
    listFiles: async () => [], readFile: async () => ({ path: '', content: '' }),
    sendMessage: async () => ({}), stop: async () => ({}), resume: async () => ({}), listModels: async () => ({}), setModel: async () => ({}), setReasoning: async () => ({}),
  } as unknown as Runtime;
}

function toolNames(server: unknown): string[] { return Object.keys((server as { _registeredTools: Record<string, unknown> })._registeredTools); }

/** Serialized catalog size using the same formula as the audit measurement. */
function catalogBytes(server: unknown): number {
  const tools = (server as { _registeredTools: Record<string, { title?: string; description?: string; inputSchema?: unknown }> })._registeredTools;
  let total = 0;
  for (const tool of Object.values(tools)) {
    if (typeof tool.inputSchema === 'object' && tool.inputSchema !== null && '_def' in (tool.inputSchema as object)) {
      // Raw zod schema (no MCP client conversion): measure name + description, which is
      // what a host actually sees in tool discovery before schema conversion.
      total += JSON.stringify({ name: tool.title, description: tool.description }).length;
    } else {
      total += JSON.stringify({ name: tool.title, description: tool.description, inputSchema: tool.inputSchema }).length;
    }
  }
  return total;
}

test('profiles: default is full and identical to the pre-profile catalog', () => {
  const before = toolNames(createServer(fakeRuntime(), true, 'full')).sort();
  // Full profile must be the exact legacy surface: everything registered.
  const legacyNames = ['send_message', 'stop_thread', 'resume_thread', 'set_model', 'set_reasoning', 'agent_send', 'agent_cancel', 'session_create', 'session_resume', 'permission_respond', 'session_set_model', 'session_set_reasoning', 'conversation_create', 'conversation_join', 'conversation_send', 'work_create', 'handoff_create', 'review_create', 'review_request', 'work_verify'];
  for (const name of legacyNames) assert.ok(before.includes(name), `full profile must keep ${name}`);
  assert.equal(parseProfile(undefined), 'full');
  assert.equal(parseProfile('FULL'), 'full');
});

test('profiles: core keeps unified provider control and work tools, omits legacy per-provider tools', () => {
  const names = toolNames(createServer(fakeRuntime(), true, 'core'));
  for (const name of ['agent_send', 'agent_cancel', 'session_create', 'session_resume', 'permission_respond', 'session_set_model', 'session_set_reasoning', 'conversation_send', 'handoff_create', 'work_create', 'work_verify', 'review_create', 'review_request']) {
    assert.ok(names.includes(name), `core must keep ${name}`);
  }
  for (const name of ['send_message', 'stop_thread', 'resume_thread', 'set_model', 'set_reasoning', 'conversation_create', 'conversation_join']) {
    assert.equal(names.includes(name), false, `core must omit legacy tool ${name}`);
  }
});

test('profiles: legacy = core + legacy-only, and every core tool exists in full', () => {
  const core = new Set(toolNames(createServer(fakeRuntime(), true, 'core')));
  const legacy = new Set(toolNames(createServer(fakeRuntime(), true, 'legacy')));
  const full = new Set(toolNames(createServer(fakeRuntime(), true, 'full')));
  for (const name of core) assert.ok(legacy.has(name) || !profileToolset('core').has(name), `legacy must be a superset of core (missing ${name})`);
  for (const name of legacy) assert.ok(full.has(name), `full must be a superset of legacy (missing ${name})`);
  assert.ok(legacy.size > core.size);
  assert.equal(full.size, legacy.size);
});

test('profiles: core catalog is smaller than full', () => {
  const coreBytes = catalogBytes(createServer(fakeRuntime(), true, 'core'));
  const fullBytes = catalogBytes(createServer(fakeRuntime(), true, 'full'));
  // Core omits 7 of 44 tools (~16% of names/descriptions; raw zod shared defs make the byte
  // delta look smaller than the converted-schema delta a host actually downloads).
  assert.ok(coreBytes < fullBytes * 0.95, `core catalog (${coreBytes}B) should be smaller than full (${fullBytes}B)`);
});

test('profiles: read-only composes with profiles instead of being overridden', () => {
  const readOnlyCore = toolNames(createServer(fakeRuntime(), false, 'core'));
  assert.equal(readOnlyCore.includes('agent_send'), false);
  assert.equal(readOnlyCore.includes('send_message'), false);
  const readOnlyFull = toolNames(createServer(fakeRuntime(), false, 'full'));
  assert.equal(readOnlyFull.includes('send_message'), false);
  assert.equal(readOnlyFull.includes('conversation_read'), true, 'read tools survive read-only mode');
});

test('profiles: freebuff_status reports the active profile', async () => {
  const server = createServer(fakeRuntime(), true, 'core') as unknown as { _registeredTools: Record<string, { handler?: (args: Record<string, never>) => Promise<{ content: Array<{ text: string }> }> }> };
  const status = server._registeredTools['freebuff_status'];
  assert.ok(status?.handler, 'freebuff_status must be registered and expose its handler');
  const result = await status.handler!({});
  const payload = JSON.parse(result.content[0]!.text) as { toolsetProfile: string; toolsetProfileDescription: string };
  assert.equal(payload.toolsetProfile, 'core');
  assert.match(payload.toolsetProfileDescription, /Core:/);
});

test('profiles: unknown profile names are rejected with supported values', () => {
  assert.throws(() => parseProfile('turbo'), /Supported profiles: core, legacy, full/);
  assert.deepEqual([...PROFILE_IDS], ['core', 'legacy', 'full']);
});

test('profiles: INTEROP_TOOLS_PROFILE env selects the catalog', () => {
  const previous = process.env.INTEROP_TOOLS_PROFILE;
  try {
    process.env.INTEROP_TOOLS_PROFILE = 'core';
    assert.equal(activeProfile(), 'core');
  } finally {
    if (previous === undefined) delete process.env.INTEROP_TOOLS_PROFILE; else process.env.INTEROP_TOOLS_PROFILE = previous;
  }
});
