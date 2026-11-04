import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentAdapter, AgentCapabilities, AgentSession } from '../src/interop.js';
import { InteropRegistry } from '../src/interop-runtime.js';

const capabilities: AgentCapabilities = {
  provider: 'codex',
  adapterVersion: 'test',
  authorization: 'unknown',
  discovery: { supported: true, state: 'available', transport: 'test', protocol: 'test' },
  sessions: { supported: true, state: 'available', transport: 'test', protocol: 'test' },
  sendMessage: { supported: false, state: 'unavailable', reason: 'test' },
  steer: { supported: false, state: 'unavailable' },
  cancel: { supported: false, state: 'unavailable' },
  events: { supported: false, state: 'unavailable' },
  diff: { supported: false, state: 'unavailable' },
  permissions: { supported: false, state: 'unavailable' },
  model: { supported: false, state: 'unavailable' },
  reasoning: { supported: false, state: 'unavailable' },
  limitations: [],
};
const session: AgentSession = {
  id: 'codex:thread-1',
  nativeId: 'thread-1',
  provider: 'codex',
  title: 'Test thread',
  provenance: { discoveredAt: new Date().toISOString(), source: 'test', native: true },
};
const adapter: AgentAdapter = {
  id: 'codex',
  capabilities: async () => capabilities,
  listSessions: async () => [session],
  getSession: async () => session,
};

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
  const failing: AgentAdapter = {
    ...adapter,
    id: 'opencode',
    listSessions: async () => {
      throw new Error('server unavailable');
    },
  };
  const registry = new InteropRegistry().register(failing).register(adapter);
  const sessions = await registry.listSessions();
  assert.deepEqual(
    sessions.map((value) => value.provider),
    ['codex'],
  );
});

test('event subscriptions cancel idle streams and bound retained session state', async () => {
  const aborted: string[] = [];
  const streaming: AgentAdapter = {
    ...adapter,
    events: async function* (nativeId, signal) {
      try {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        aborted.push(nativeId);
      }
    },
  };
  const registry = new InteropRegistry().register(streaming);
  try {
    for (let index = 0; index < 1_100; index += 1) {
      await registry.readEvents('codex', `thread-${index}`, 1, 0);
    }
    const internal = registry as unknown as {
      eventBuffers: Map<string, unknown>;
      eventEpochs: Map<string, number>;
    };
    assert.ok(internal.eventBuffers.size <= 128);
    assert.ok(internal.eventEpochs.size <= 1_024);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      aborted.length >= 972,
      `expected evicted streams to receive cancellation, got ${aborted.length}`,
    );
  } finally {
    registry.dispose();
  }
});

test('cancelling one event read releases its consumer without hiding other stream users', async () => {
  const streaming: AgentAdapter = {
    ...adapter,
    events: async function* (_nativeId, signal) {
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  };
  const registry = new InteropRegistry().register(streaming);
  const controller = new AbortController();
  try {
    const pending = registry.readEvents('codex', 'thread-cancel', 1, 30_000, 0, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const buffers = (registry as unknown as { eventBuffers: Map<string, { consumers: unknown[] }> })
      .eventBuffers;
    assert.equal(buffers.get('codex:thread-cancel')?.consumers.length, 0);
  } finally {
    registry.dispose();
  }
});
