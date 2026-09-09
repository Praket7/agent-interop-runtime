import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryProvider, DuplicateReadCounter, countBytes, countPayloadTokens } from './shared.js';
import { runTask, runBenchmark } from './harness.js';

test('benchmark: in-memory providers observe their own sends (delivery correlation ground truth)', async () => {
  const provider = new InMemoryProvider('codex', 'Bench', [{ nativeId: 's1' }]);
  const receipt = await provider.send('s1', 'do the thing');
  assert.equal(receipt.accepted, true);
  assert.equal(provider.received.length, 1);
  assert.match(provider.received[0]!.text, /do the thing/);
  assert.equal(provider.usageObservations.filter((o) => o.kind === 'send').length, 1);
});

test('benchmark: duplicate-read counter reports repeats but not first deliveries', () => {
  const counter = new DuplicateReadCounter();
  counter.record({ key: 'event:1', body: { sequence: 1 } });
  assert.deepEqual(counter.duplicates(), []);
  counter.record({ key: 'event:1', body: { sequence: 1 } });
  assert.equal(counter.duplicates()[0]?.times, 2);
  counter.record({ key: 'event:2', body: { sequence: 2 } });
  assert.equal(counter.totalReads, 3);
  assert.equal(counter.uniqueItems, 2);
});

test('benchmark: token accounting uses a named tokenizer and is deterministic', () => {
  const first = countPayloadTokens({ hello: 'world' });
  const second = countPayloadTokens({ hello: 'world' });
  assert.equal(first, second);
  assert.ok(first > 0);
  assert.ok(countBytes({ a: 1 }) > 0);
});

test('benchmark task: implement-utils completes with exactly one provider send and no duplicate reads', async () => {
  const result = await runTask('implement-utils', {
    objective: 'Implement a date-parsing utility in src/utils.ts with tests',
    criteria: ['util parses ISO dates', 'handles invalid input without throwing'],
    senderProvider: new InMemoryProvider('codex', 'S', [{ nativeId: 'sender-1', cwd: '/tmp/s' }]),
    recipientProvider: new InMemoryProvider('claude-code', 'R', [{ nativeId: 'worker-1', cwd: '/tmp/r' }]),
  });
  assert.equal(result.duplicateProviderSends, 0, 'delivery must be exactly-once at the coordinator level');
  assert.equal(result.providerObservedSends, 1);
  assert.equal(result.duplicateReads, 0, 'cursor-driven observation must never redeliver an event');
  assert.ok(['in_progress', 'accepted', 'blocked'].includes(result.finalState), `unexpected terminal state ${result.finalState}`);
  assert.ok(result.payloadBytes > 0 && result.tokens > 0);
});

test('benchmark task: blocked-then-resume records blocked phases and still completes without duplicate sends', async () => {
  const result = await runTask('blocked-then-resume', {
    objective: 'Apply the migration script after approval',
    criteria: ['migration runs cleanly', 'rollback documented'],
    senderProvider: new InMemoryProvider('codex', 'S', [{ nativeId: 'sender-2', cwd: '/tmp/s' }]),
    recipientProvider: new InMemoryProvider('claude-code', 'W', [{ nativeId: 'worker-2', cwd: '/tmp/w' }]),
    blockers: 2,
  });
  assert.equal(result.duplicateProviderSends, 0);
  assert.equal(result.duplicateReads, 0);
  assert.ok(result.steps > 5, 'blocked phases must produce additional observable steps');
});

test('benchmark suite: full run reports honest labels and consistent metrics', async () => {
  const result = await runBenchmark();
  assert.match(result.tokenizer, /o200k_base/);
  assert.match(result.tokenizer, /not native provider usage/);
  assert.equal(result.tasks.length, 3);
  for (const task of result.tasks) {
    assert.equal(task.duplicateProviderSends, 0, `${task.task}: no duplicate provider sends`);
    assert.equal(task.duplicateReads, 0, `${task.task}: no duplicate event/message reads`);
    assert.ok(task.payloadBytes > 0 && task.tokens > 0, `${task.task}: metrics must be populated`);
  }
  assert.ok(result.catalog.tools > 0, 'catalog delta must be measured, not asserted');
});

test('benchmark: shared per-session subscription survives repeated polls without new streams (AI-14)', async () => {
  const { InteropRegistry } = await import('../../src/interop-runtime.js');
  const provider = new InMemoryProvider('codex', 'P', [{ nativeId: 'poll-1' }]);
  const registry = new InteropRegistry().register(provider);
  let streamCount = 0;
  const originalEvents = provider.events.bind(provider);
  (provider as { events: typeof provider.events }).events = function (nativeId: string) {
    streamCount += 1;
    return originalEvents(nativeId);
  } as typeof provider.events;
  provider.emit('poll-1', { type: 'a', data: {} });
  provider.emit('poll-1', { type: 'b', data: {} });
  const first = await registry.readEvents('codex', 'poll-1', 10, 200);
  const firstCursor = Math.max(...first.map((e) => e.sequence));
  const second = await registry.readEvents('codex', 'poll-1', 10, 200, firstCursor);
  assert.equal(second.length, 0, 'round-trip cursor must not redeliver events');
  assert.equal(streamCount, 1, 'repeated polls must reuse one subscription');
  provider.emit('poll-1', { type: 'c', data: {} });
  const third = await registry.readEvents('codex', 'poll-1', 10, 200, firstCursor);
  assert.deepEqual(third.map((e) => e.type), ['c'], 'only events after the cursor are delivered');
  registry.dispose();
});
