import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter, type RpcRequest } from '../src/adapters.js';

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
  assert.equal((await adapter.send('thread-2', 'hello')).accepted, true);
  assert.equal((await adapter.cancel('thread-2')).accepted, true);
  assert.deepEqual(mock.calls.map((call) => call.method), ['initialize', 'thread/list', 'thread/start', 'turn/start', 'turn/interrupt']);
  assert.deepEqual(mock.calls[2]?.params, { cwd: 'C:/repo', name: 'New work' });
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
  assert.equal((await adapter.cancel('session-1')).accepted, true);
  assert.deepEqual(mock.calls.map((call) => call.method), ['initialize', 'session/new', 'session/prompt', 'session/cancel']);
  assert.deepEqual(mock.calls[2]?.params, { sessionId: 'session-1', prompt: [{ type: 'text', text: 'inspect this' }] });
});

test('native adapters degrade honestly when their process cannot be started', async () => {
  const adapter = new CodexAdapter({ command: 'definitely-not-a-real-codex-command' });
  const caps = await adapter.capabilities();
  assert.equal(caps.discovery.supported, false);
  assert.equal(caps.discovery.state, 'unavailable');
  assert.equal((await adapter.listSessions()).length, 0);
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
    const receipt = await adapter.send('session-1', 'hello', { model: 'provider/model', variant: 'build' });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.status, 'queued');
    const sent = JSON.parse(String(requests[0]?.init?.body));
    assert.deepEqual(sent, { model: 'provider/model', agent: 'build', parts: [{ type: 'text', text: 'hello' }] });
  } finally { globalThis.fetch = previousFetch; }
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
