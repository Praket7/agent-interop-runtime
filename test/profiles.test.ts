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

test('profiles: default exposes a predictable nine-tool provider surface', () => {
  const names = toolNames(createServer(fakeRuntime())).sort();
  assert.equal(parseProfile(undefined), 'minimal');
  assert.equal(parseProfile('MINIMAL'), 'minimal');
  assert.equal(names.length, 9);
  assert.deepEqual(names, ['cancel_session', 'create_session', 'get_runtime_status', 'get_session_diff', 'list_agent_sessions', 'list_providers', 'read_session_events', 'resume_session', 'send_session_message'].sort());
});

test('profiles: catalog sizes stay within their intended budgets', () => {
  assert.equal(toolNames(createServer(fakeRuntime(), true, 'core')).length, 30);
  assert.equal(toolNames(createServer(fakeRuntime(), true, 'freebuff')).length, 16);
  assert.equal(toolNames(createServer(fakeRuntime(), true, 'full')).length, 49);
  assert.equal(toolNames(createServer(fakeRuntime(), true, 'legacy')).length, 52);
});

test('profiles: core keeps interop and coordination while omitting Freebuff-specific tools', () => {
  const names = toolNames(createServer(fakeRuntime(), true, 'core'));
  for (const name of ['list_providers', 'list_agent_sessions', 'read_conversation', 'get_work', 'send_session_message', 'create_conversation', 'join_conversation', 'send_conversation_message', 'create_handoff', 'create_work', 'verify_work', 'create_review', 'request_review']) {
    assert.ok(names.includes(name), `core must keep ${name}`);
  }
  for (const name of ['list_projects', 'list_threads', 'read_project_file', 'send_thread_message', 'stop_thread', 'resume_thread', 'set_thread_model', 'set_thread_reasoning']) {
    assert.equal(names.includes(name), false, `core must omit Freebuff-specific tool ${name}`);
  }
});

test('profiles: legacy keeps all 52 old names while full exposes modern names', () => {
  const core = new Set(toolNames(createServer(fakeRuntime(), true, 'core')));
  const legacy = new Set(toolNames(createServer(fakeRuntime(), true, 'legacy')));
  const full = new Set(toolNames(createServer(fakeRuntime(), true, 'full')));
  assert.equal(legacy.size, 52);
  assert.ok(legacy.has('agent_send'));
  assert.ok(legacy.has('events_read'));
  assert.ok(legacy.has('watch_thread'));
  assert.ok(legacy.has('watch_active_threads'));
  assert.ok(full.has('send_session_message'));
  assert.ok(full.has('read_session_events'));
  assert.equal(full.has('agent_send'), false);
  assert.equal(full.has('events_read'), false);
  assert.equal(full.has('watch_thread'), false);
  assert.equal(full.size, 49);
  assert.ok(core.size > 15);
});

test('profiles: core catalog is smaller than full', () => {
  const coreBytes = catalogBytes(createServer(fakeRuntime(), true, 'core'));
  const fullBytes = catalogBytes(createServer(fakeRuntime(), true, 'full'));
  assert.ok(coreBytes < fullBytes * 0.80, `core catalog (${coreBytes}B) should be materially smaller than full (${fullBytes}B)`);
});

test('profiles: read-only composes with profiles instead of being overridden', () => {
  const readOnlyCore = toolNames(createServer(fakeRuntime(), false, 'core'));
  assert.equal(readOnlyCore.includes('send_session_message'), false);
  assert.equal(readOnlyCore.includes('send_thread_message'), false);
  const readOnlyFull = toolNames(createServer(fakeRuntime(), false, 'full'));
  assert.equal(readOnlyFull.includes('send_thread_message'), false);
  assert.equal(readOnlyFull.includes('read_conversation'), true, 'read tools survive read-only mode');
});

test('profiles: runtime status reports the active profile', async () => {
  const server = createServer(fakeRuntime(), true, 'core') as unknown as { _registeredTools: Record<string, { handler?: (args: Record<string, never>) => Promise<{ content: Array<{ text: string }> }> }> };
  const status = server._registeredTools['get_runtime_status'];
  assert.ok(status?.handler, 'get_runtime_status must be registered and expose its handler');
  const result = await status.handler!({});
  const payload = JSON.parse(result.content[0]!.text) as { toolsetProfile: string; toolsetProfileDescription: string };
  assert.equal(payload.toolsetProfile, 'core');
  assert.match(payload.toolsetProfileDescription, /Core:/);
});

test('profiles: minimal and freebuff expose purpose-built narrow surfaces', () => {
  const minimal = toolNames(createServer(fakeRuntime(), true, 'minimal'));
  assert.ok(minimal.includes('list_agent_sessions'));
  assert.ok(minimal.includes('send_session_message'));
  assert.equal(minimal.includes('get_work'), false);
  assert.equal(minimal.includes('list_projects'), false);
  const freebuff = toolNames(createServer(fakeRuntime(), true, 'freebuff'));
  assert.ok(freebuff.includes('list_projects'));
  assert.ok(freebuff.includes('send_thread_message'));
  assert.equal(freebuff.includes('send_session_message'), false);
  assert.equal(freebuff.includes('get_work'), false);
});

test('modern catalogs use verb-first names and leave old names to legacy', () => {
  for (const profile of ['minimal', 'core', 'freebuff', 'full'] as const) {
    for (const name of toolNames(createServer(fakeRuntime(), true, profile))) {
      assert.match(name, /^(get|list|read|send|cancel|create|resume|set|stop|respond|reconcile|join|update|acquire|release|request|verify)_[a-z]+(?:_[a-z]+)*$/, `${profile} tool ${name} must use verb_resource naming`);
    }
  }
});

test('modern descriptions use the names of the alternatives visible in that profile', () => {
  const modern = createServer(fakeRuntime(), true, 'full') as unknown as { _registeredTools: Record<string, { description?: string; title?: string }> };
  const legacy = createServer(fakeRuntime(), true, 'legacy') as unknown as { _registeredTools: Record<string, { description?: string }> };
  assert.match(modern._registeredTools['get_session_diff']!.description!, /read_session_events/);
  assert.doesNotMatch(modern._registeredTools['get_session_diff']!.description!, /events_page/);
  assert.match(modern._registeredTools['get_session_diff']!.title!, /Get Session Diff/);
  assert.match(legacy._registeredTools['get_agent_diff']!.description!, /events_page/);
});

test('verification is annotated as potentially destructive because configured commands can change files', () => {
  const server = createServer(fakeRuntime(), true, 'core') as unknown as { _registeredTools: Record<string, { annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean }; description?: string }> };
  const verify = server._registeredTools['verify_work'];
  assert.equal(verify?.annotations?.readOnlyHint, false);
  assert.equal(verify?.annotations?.destructiveHint, true);
  assert.match(verify?.description ?? '', /may modify or delete files/i);
});

test('progress tools consolidate raw waits and summaries for one or all threads', async () => {
  const calls: Array<[string, unknown]> = [];
  const runtime = fakeRuntime() as unknown as Record<string, unknown>;
  runtime.getThreadProgress = async (...args: unknown[]) => { calls.push(['get', args]); return { kind: 'snapshot' }; };
  runtime.watchThread = async (...args: unknown[]) => { calls.push(['watch', args]); return { kind: 'waited' }; };
  runtime.getThreadProgressSummary = async (...args: unknown[]) => { calls.push(['summary', args]); return { kind: 'summary' }; };
  runtime.watchActiveThreads = async (...args: unknown[]) => { calls.push(['active', args]); return { kind: 'active' }; };
  const server = createServer(runtime as unknown as Runtime, true, 'freebuff') as unknown as { _registeredTools: Record<string, { handler?: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> };
  const raw = server._registeredTools['get_thread_progress']?.handler;
  const summary = server._registeredTools['get_thread_progress_summary']?.handler;
  assert.ok(raw && summary);
  await raw({ threadId: 't1' });
  await raw({ threadId: 't1', timeoutMs: 2000 });
  await summary({ threadId: 't1' });
  await summary({});
  assert.deepEqual(calls, [['get', ['t1', undefined, undefined]], ['watch', ['t1', undefined, 2000, undefined]], ['summary', ['t1']], ['active', []]]);
  const names = toolNames(server);
  assert.equal(names.includes('watch_thread'), false);
  assert.equal(names.includes('watch_active_threads'), false);
});

test('profiles: unknown profile names are rejected with supported values', () => {
  assert.throws(() => parseProfile('turbo'), /Supported profiles: minimal, core, freebuff, legacy, full/);
  assert.deepEqual([...PROFILE_IDS], ['minimal', 'core', 'freebuff', 'legacy', 'full']);
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
