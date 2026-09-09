import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter, CursorAdapter, type RpcRequest } from '../src/adapters.js';
import { FreebuffAdapter } from '../src/freebuff-adapter.js';

function mockRpc(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc: RpcRequest = async (method, params) => {
    calls.push({ method, params });
    return responses[method] ?? {};
  };
  return { rpc, calls };
}

test('Codex App Server adapter initializes and maps native thread operations', async () => {
  const mock = mockRpc({
    initialize: { serverInfo: { name: 'codex' } },
    'thread/list': { data: [{ id: 'thread-1', name: 'Existing work', status: 'idle', cwd: 'C:/repo' }] },
    'thread/start': { thread: { id: 'thread-2', name: 'New work', status: 'idle' } },
    'thread/resume': { thread: { id: 'thread-1', name: 'Existing work', status: 'idle' } },
    'turn/start': { turn: { id: 'turn-1' } },
    'turn/interrupt': {},
  });
  const adapter = new CodexAdapter({ rpc: mock.rpc });
  const caps = await adapter.capabilities();
  assert.equal(caps.discovery.supported, true);
  assert.equal(caps.sendMessage.supported, true);
  assert.deepEqual((await adapter.listSessions()).map((s) => s.nativeId), ['thread-1']);
  const session = await adapter.createSession({ cwd: 'C:/repo', title: 'New work' });
  assert.equal(session.nativeId, 'thread-2');
  assert.equal((await adapter.send('thread-2', 'hello', { model: { providerID: 'openai', modelID: 'gpt-5.6' }, reasoning: 'high' })).accepted, true);
  assert.equal((await adapter.cancel('thread-2')).accepted, true);
  assert.deepEqual(mock.calls.map((call) => call.method), ['initialize', 'thread/list', 'thread/start', 'turn/start', 'turn/interrupt']);
  assert.deepEqual(mock.calls[2]?.params, { cwd: 'C:/repo', name: 'New work' });
  assert.deepEqual(mock.calls[3]?.params, { threadId: 'thread-2', input: [{ type: 'text', text: 'hello' }], model: 'gpt-5.6', effort: 'high' });
});

test('Claude ACP adapter uses session/new prompt and cancel', async () => {
  const mock = mockRpc({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'session-1', title: 'Claude work', cwd: 'C:/repo' },
    'session/cancel': {},
    'session/prompt': {},
  });
  const adapter = new ClaudeCodeAdapter({ rpc: mock.rpc });
  assert.equal((await adapter.capabilities()).sessions.supported, true);
  const session = await adapter.createSession({ cwd: 'C:/repo' });
  assert.equal(session.id, 'claude-code:session-1');
  assert.equal((await adapter.send('session-1', 'inspect this')).accepted, true);
  // AI-12: ACP cancellation is a notification; it never appears as a request call and
  // a no-reply provider does not time out.
  assert.equal((await adapter.cancel('session-1')).accepted, true);
  assert.equal(mock.calls.filter((call) => call.method === 'session/cancel').length, 0);
  assert.deepEqual(mock.calls.map((call) => call.method), ['initialize', 'session/new', 'session/prompt']);
  assert.deepEqual(mock.calls[2]?.params, { sessionId: 'session-1', prompt: [{ type: 'text', text: 'inspect this' }] });
});

test('Claude ACP exposes persisted sessions and applies model and reasoning separately', async () => {
  const mock = mockRpc({
    initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } } },
    'session/list': { sessions: [{ sessionId: 'old-1', title: 'Existing Claude work', cwd: 'C:/repo' }] },
    'session/set_config_option': {},
    'session/prompt': {},
  });
  const adapter = new ClaudeCodeAdapter({ rpc: mock.rpc });
  const caps = await adapter.capabilities();
  assert.equal(caps.model.supported, false);
  assert.equal(caps.model.state, 'degraded');
  assert.equal(caps.reasoning.supported, false);
  assert.deepEqual((await adapter.listSessions()).map((s) => s.nativeId), ['old-1']);
  const receipt = await adapter.send('old-1', 'read the files', { model: { providerID: 'anthropic', modelID: 'claude-sonnet' }, reasoning: 'high' });
  assert.equal(receipt.accepted, true);
  assert.deepEqual(mock.calls.filter((call) => call.method === 'session/set_config_option').map((call) => call.params), [
    { sessionId: 'old-1', configId: 'model', type: 'id', value: 'claude-sonnet' },
    { sessionId: 'old-1', configId: 'thought_level', type: 'id', value: 'high' },
  ]);
});

test('Cursor ACP authenticates through cursor_login and keeps mode separate from model', async () => {
  const mock = mockRpc({
    initialize: { protocolVersion: 1, authMethods: [{ methodId: 'cursor_login' }], agentCapabilities: { sessionCapabilities: { list: {} } } },
    authenticate: {},
    'session/new': { sessionId: 'cursor-1', cwd: 'C:/repo' },
    'session/set_config_option': {},
    'session/prompt': {},
  });
  const adapter = new CursorAdapter({ rpc: mock.rpc });
  const session = await adapter.createSession({ cwd: 'C:/repo' });
  assert.equal(session.id, 'cursor:cursor-1');
  assert.equal((await adapter.send('cursor-1', 'inspect this', { model: { providerID: 'cursor', modelID: 'auto' }, agent: 'plan' })).accepted, true);
  assert.deepEqual(mock.calls.map((call) => call.method), ['initialize', 'authenticate', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt']);
  assert.deepEqual(mock.calls[3]?.params, { sessionId: 'cursor-1', configId: 'mode', type: 'id', value: 'plan' });
});

test('Freebuff unified sends apply model and reasoning to the exact native session', async () => {
  const calls: string[] = [];
  const runtime = { capabilities: async () => ({ product: 'cli', signedIn: 'unknown', orchestrator: false, readOnly: false, endpoints: ['managed PTY'], notes: [] }), sendMessage: async (id: string, text: string) => { calls.push(`send:${id}:${text}`); return { id, text }; }, setModel: async (id: string, model: string) => { calls.push(`model:${id}:${model}`); return { id, model }; }, setReasoning: async (id: string, effort: string) => { calls.push(`reasoning:${id}:${effort}`); return { id, effort }; } } as any;
  const adapter = new FreebuffAdapter(runtime);
  const receipt = await adapter.send('chat-1', 'inspect files', { model: { providerID: 'freebuff', modelID: 'sonnet' }, reasoning: 'high' });
  assert.equal(receipt.accepted, true);
  assert.deepEqual(calls, ['model:chat-1:sonnet', 'reasoning:chat-1:high', 'send:chat-1:inspect files']);
});

test('native adapters degrade honestly when their process cannot be started', async () => {
  const adapter = new CodexAdapter({ command: 'definitely-not-a-real-codex-command' });
  const caps = await adapter.capabilities();
  assert.equal(caps.discovery.supported, false);
  assert.equal(caps.discovery.state, 'unavailable');
  await assert.rejects(() => adapter.listSessions(), /not found|unavailable|ENOENT/i);
  const receipt = await adapter.send('missing', 'hello');
  assert.equal(receipt.accepted, false);
  assert.match(String((receipt.detail as { reason?: string })?.reason), /not found|unavailable|ENOENT/i);
});

test('OpenCode accepts a 204 prompt response without parsing JSON', async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => { requests.push({ url: String(input), init }); return new Response(null, { status: 204 }); };
  try {
    const adapter = new OpenCodeAdapter();
    const receipt = await adapter.send('session-1', 'hello', { model: { providerID: 'opencode', modelID: 'big-pickle' }, agent: 'build' });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.status, 'queued');
    const sent = JSON.parse(String(requests[0]?.init?.body));
    assert.deepEqual(sent, { model: { providerID: 'opencode', modelID: 'big-pickle' }, agent: 'build', parts: [{ type: 'text', text: 'hello' }] });
  } finally { globalThis.fetch = previousFetch; }
});

test('OpenCode retries the alternate model identity for older or newer API shapes', async () => {
  const previousFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? new Response(JSON.stringify({ message: 'expected id' }), { status: 400 }) : new Response(null, { status: 204 }); };
  try { const receipt = await new OpenCodeAdapter().send('session-1', 'hello', { model: { providerID: 'opencode', modelID: 'big-pickle' } }); assert.equal(receipt.accepted, true); assert.deepEqual(bodies, [{ model: { providerID: 'opencode', modelID: 'big-pickle' }, parts: [{ type: 'text', text: 'hello' }] }, { model: { providerID: 'opencode', id: 'big-pickle' }, parts: [{ type: 'text', text: 'hello' }] }]); }
  finally { globalThis.fetch = previousFetch; }
});

test('OpenCode rejects malformed session discovery instead of treating it as empty', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 });
  try { await assert.rejects(() => new OpenCodeAdapter().listSessions(), /malformed response/); }
  finally { globalThis.fetch = previousFetch; }
});

test('OpenCode sends configured Basic Auth without exposing the password', async () => {
  const previousFetch = globalThis.fetch;
  const previousUser = process.env.OPENCODE_SERVER_USERNAME;
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_SERVER_USERNAME = 'alice'; process.env.OPENCODE_SERVER_PASSWORD = 'secret';
  let authorization = '';
  globalThis.fetch = async (_input, init) => { authorization = String((init?.headers as Record<string, string>)?.authorization); return new Response(JSON.stringify({ healthy: true }), { status: 200 }); };
  try { const caps = await new OpenCodeAdapter().capabilities(); assert.equal(caps.discovery.supported, true); assert.equal(authorization, `Basic ${Buffer.from('alice:secret').toString('base64')}`); }
  finally { globalThis.fetch = previousFetch; if (previousUser === undefined) delete process.env.OPENCODE_SERVER_USERNAME; else process.env.OPENCODE_SERVER_USERNAME = previousUser; if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD; else process.env.OPENCODE_SERVER_PASSWORD = previousPassword; }
});
