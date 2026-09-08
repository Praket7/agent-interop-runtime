import test from 'node:test';
import assert from 'node:assert/strict';
import { InteropRegistry } from '../src/interop-runtime.js';
import type { AgentAdapter, AgentCapabilities, AgentSession } from '../src/interop.js';

const capabilities: AgentCapabilities = {
  provider: 'codex', adapterVersion: 'test', authorization: 'unknown',
  discovery: { supported: true, state: 'available', transport: 'test', protocol: 'test' },
  sessions: { supported: true, state: 'available', transport: 'test', protocol: 'test' },
  sendMessage: { supported: false, state: 'unavailable', reason: 'test' },
  steer: { supported: false, state: 'unavailable' }, cancel: { supported: false, state: 'unavailable' },
  events: { supported: false, state: 'unavailable' }, diff: { supported: false, state: 'unavailable' },
  permissions: { supported: false, state: 'unavailable' }, model: { supported: false, state: 'unavailable' }, reasoning: { supported: false, state: 'unavailable' }, limitations: []
};
const session: AgentSession = { id: 'codex:thread-1', nativeId: 'thread-1', provider: 'codex', title: 'Test thread', provenance: { discoveredAt: new Date().toISOString(), source: 'test', native: true } };
const adapter: AgentAdapter = { id: 'codex', capabilities: async () => capabilities, listSessions: async () => [session], getSession: async () => session };

test('registry preserves provider identity and captures discovery evidence', async () => {
  const registry = new InteropRegistry().register(adapter);
  assert.deepEqual(await registry.listProviders(), ['codex']);
  const sessions = await registry.listSessions();
  assert.equal(sessions[0]?.nativeId, 'thread-1');
  const graph = await registry.graph();
  assert.equal(graph.sessions[0]?.provider, 'codex');
  assert.equal(graph.evidence[0]?.trust, 'native');
});

test('unsupported operations fail clearly instead of being emulated', async () => {
  const registry = new InteropRegistry().register(adapter);
  await assert.rejects(() => registry.send('codex', 'thread-1', 'hello'), /does not support send/);
});

test('session discovery keeps healthy providers when one adapter fails', async () => {
  const failing: AgentAdapter = { ...adapter, id: 'opencode', listSessions: async () => { throw new Error('server unavailable'); } };
  const registry = new InteropRegistry().register(failing).register(adapter);
  const sessions = await registry.listSessions();
  assert.deepEqual(sessions.map((value) => value.provider), ['codex']);
});
