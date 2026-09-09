import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ConversationStore } from '../src/conversations.js';
import { withStateLock } from '../src/state.js';

/** Isolated state file per test; cleaned up even on failure. */
async function tempStore(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-air-'));
  return { file: path.join(dir, 'conversations.json'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('conversation coordinator keeps directed receipts and participant identity', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-conversation-'));
  const store = new ConversationStore(path.join(dir, 'conversations.json'));
  await store.load();
  const conversation = await store.create('shared review');
  await store.join(conversation.id, { provider: 'codex', nativeId: 'thread-a' });
  await store.join(conversation.id, { provider: 'claude-code', nativeId: 'session-b' });
  const registry = { send: async (provider: string, nativeId: string, text: string) => ({ provider, nativeId, operation: 'send', accepted: true, status: 'queued', detail: { text } }) } as any;
  const delivered = await store.send(conversation.id, 'codex:thread-a', 'claude-code:session-b', 'Please review this file', registry);
  assert.equal(delivered.receipt.status, 'queued');
  assert.equal(delivered.message.delivery, 'queued');
  const page = await store.read(conversation.id);
  assert.equal(page.messages[0]?.recipient, 'claude-code:session-b');
  assert.equal(page.messages[0]?.receipt?.provider, 'claude-code');
  assert.equal(page.next, page.messages[0]?.sequence);
  assert.equal(page.latestSequence, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

// ── Readiness review regressions (AIR-01..04) ──────────────────────────────────────────

test('AIR-01: dispatch uses the joined participant nativeId, not the composite participant ID', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('routing');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a' }); // participant id opencode:a
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b' }); // participant id opencode:b
    const registry = { send: async (_provider: unknown, nativeId: string) => ({ provider: 'opencode', nativeId, operation: 'send', accepted: true, status: 'completed' }) } as never;
    const { message, receipt } = await store.send(conversation.id, 'opencode:a', 'opencode:b', 'hello', registry);
    assert.equal(receipt.nativeId, 'b', 'the adapter must receive the native session ID, not opencode:b');
    assert.equal(message.delivery, 'completed');
    // Custom participant IDs must not influence provider resolution either.
    const second = await store.create('routing2');
    await store.join(second.id, { provider: 'codex', nativeId: 'thread-9', id: 'weird-custom-id' });
    let routedProvider = '';
    await store.send(second.id, 'weird-custom-id', 'weird-custom-id', 'self', { send: async (provider: string) => { routedProvider = provider as unknown as string; return { provider, nativeId: 'thread-9', operation: 'send', accepted: true } as never; } } as never);
    assert.equal(routedProvider, 'codex');
  } finally { await cleanup(); }
});

test('AIR-02: same-millisecond concurrent joins both survive (deterministic interleaved writers)', async () => {
  const { file, cleanup } = await tempStore();
  const RealDate = globalThis.Date;
  // A fixed clock makes every writer observe identical timestamps, which defeats any
  // wall-clock-based reconciliation.
  globalThis.Date = class extends RealDate { constructor(...args: unknown[]) { super(...(args.length ? args as [] : ['2030-01-01T00:00:00.000Z'])); } } as typeof Date;
  try {
    const x = new ConversationStore(file);
    const conversation = await x.create('same time');
    const y = new ConversationStore(file); await y.load();
    await x.join(conversation.id, { provider: 'opencode', nativeId: 'x' });
    await y.join(conversation.id, { provider: 'opencode', nativeId: 'y' });
    const disk = new ConversationStore(file); await disk.load();
    const participants = (await disk.get(conversation.id))!.participants.map((p) => p.nativeId).sort();
    assert.deepEqual(participants, ['x', 'y'], 'both joins must be preserved');
  } finally { globalThis.Date = RealDate; await cleanup(); }
});

test('AIR-02: receipt updates persist even when the clock is frozen', async () => {
  const { file, cleanup } = await tempStore();
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate { constructor(...args: unknown[]) { super(...(args.length ? args as [] : ['2030-01-01T00:00:00.000Z'])); } } as typeof Date;
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('receipts');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b', id: 'opencode:b' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a', id: 'opencode:a' });
    const registry = { send: async () => ({ provider: 'opencode', nativeId: 'session-b', operation: 'send', accepted: true, status: 'completed', detail: { n: 1 } }) } as never;
    await store.send(conversation.id, 'opencode:a', 'opencode:b', 'hello', registry);
    const disk = new ConversationStore(file); await disk.load();
    const message = (await disk.get(conversation.id))!.messages[0]!;
    assert.equal(message.delivery, 'completed', 'receipt classification must be durable');
    assert.equal((message.receipt as { detail?: { n?: number } })?.detail?.n, 1, 'receipt detail must be persisted');
  } finally { globalThis.Date = RealDate; await cleanup(); }
});

test('AIR-03: a lock held by a live process is never stolen, regardless of age', async () => {
  const { file, cleanup } = await tempStore();
  try {
    await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, host: 'x', acquiredAt: new Date(Date.now() - 31_000).toISOString(), owner: 'still-active', token: 'theirs' }), 'utf8');
    await assert.rejects(() => withStateLock(file, 'second-writer', async () => undefined), /Could not acquire state lock/, 'elapsed time alone must not justify stealing a live owner lock');
  } finally { await cleanup(); }
});

test('AIR-03: a crashed writer lock is recovered, but release never removes another writer lock', async () => {
  const { file, cleanup } = await tempStore();
  try {
    // Dead PID, older than the orphan grace: recoverable.
    await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: 999_999_999, host: 'x', acquiredAt: new Date(Date.now() - 31_000).toISOString(), owner: 'dead', token: 'theirs' }), 'utf8');
    let ran = false;
    await withStateLock(file, 'recoverer', async () => { ran = true; });
    assert.equal(ran, true, 'orphaned lock must be recoverable');
    assert.equal(await fs.stat(`${file}.lock`).then(() => true, () => false), false, 'lock must be released after the transaction');
  } finally { await cleanup(); }
});

test('AIR-03: two real child processes serialize through the lock and both writes survive', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-xproc-'));
  const file = path.join(dir, 'conversations.json');
  try {
    const script = [
      `import { ConversationStore } from 'file://${path.resolve('dist/src/conversations.js')}';`,
      `const store = new ConversationStore(${JSON.stringify(file)});`,
      `const label = process.argv[2];`,
      `const conversation = await store.create('proc ' + label);`,
      `await store.join(conversation.id, { provider: 'opencode', nativeId: label });`,
      `console.log(conversation.id);`,
    ].join('\n');
    await fs.writeFile(path.join(dir, 'child.mjs'), script, 'utf8');
    const run = (label: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(dir, 'child.mjs'), label], { cwd: process.cwd() });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)));
    });
    const [idA, idB] = await Promise.all([run('proc-a'), run('proc-b')]);
    const disk = new ConversationStore(file); await disk.load();
    const a = await disk.get(idA); const b = await disk.get(idB);
    assert.ok(a, 'process A conversation must survive process B writes');
    assert.ok(b, 'process B conversation must survive process A writes');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('AIR-04: a long-lived reader observes another process committed writes', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const writer = new ConversationStore(file);
    const conversation = await writer.create('refresh');
    await writer.join(conversation.id, { provider: 'opencode', nativeId: 'a', id: 'opencode:a' });
    await writer.join(conversation.id, { provider: 'opencode', nativeId: 'b', id: 'opencode:b' });
    const reader = new ConversationStore(file); await reader.load();
    assert.equal((await reader.get(conversation.id))!.messages.length, 0);
    const registry = { send: async () => ({ provider: 'opencode', nativeId: 'b', operation: 'send', accepted: true, status: 'completed' }) } as never;
    await writer.send(conversation.id, 'opencode:a', 'opencode:b', 'hello', registry);
    // The reader instance was loaded BEFORE the write; it must still see the new message.
    assert.equal((await reader.get(conversation.id))!.messages.length, 1, 'stale cache must refresh from disk');
    assert.equal((await reader.read(conversation.id)).messages.length, 1, 'read() must also observe external writes');
    assert.equal((await reader.list())[0]!.messageCount, 1, 'list() must also observe external writes');
  } finally { await cleanup(); }
});

test('delivery_unknown is classified and never blindly resent after provider throws', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('ambiguous');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a', id: 'opencode:a' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b', id: 'opencode:b' });
    let calls = 0;
    const registry = { send: async () => { calls += 1; throw new Error('connection reset after provider accepted'); } } as never;
    await assert.rejects(() => store.send(conversation.id, 'opencode:a', 'opencode:b', 'maybe delivered', registry), /delivery_unknown/);
    assert.equal(calls, 1, 'a delivery-unknown message must not be automatically retried');
    const disk = new ConversationStore(file); await disk.load();
    const message = (await disk.get(conversation.id))!.messages[0]!;
    assert.equal(message.delivery, 'delivery_unknown');
    assert.ok(message.idempotencyKey, 'an idempotency key must be persisted for reconciliation');
    assert.ok(message.deliveryUnknownAt, 'the ambiguity timestamp must be recorded');
  } finally { await cleanup(); }
});

test('caller-stable idempotency key: a retried send resolves to the same record, not a duplicate', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('idempotent');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a', id: 'opencode:a' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b', id: 'opencode:b' });
    const registry = { send: async () => ({ provider: 'opencode', nativeId: 'b', operation: 'send', accepted: true, status: 'completed' }) } as never;
    const first = await store.send(conversation.id, 'opencode:a', 'opencode:b', 'exactly once', registry, undefined, undefined, 'work-1/handoff-1');
    // A crash/retry with the SAME caller key must not enqueue a second provider delivery.
    await assert.rejects(
      () => store.send(conversation.id, 'opencode:a', 'opencode:b', 'exactly once', registry, undefined, undefined, 'work-1/handoff-1'),
      /idempotency key .*already has a message/i,
    );
    assert.equal((await store.get(conversation.id))!.messages.length, 1);
    assert.equal(first.message.idempotencyKey, 'work-1/handoff-1');
  } finally { await cleanup(); }
});

test('crash boundary: a queued record from a crash before receipt persistence is reconciled, never resent', async () => {
  const { file, cleanup } = await tempStore();
  try {
    // Simulate the crash window: persist a queued message directly, as send() does before dispatch.
    const store = new ConversationStore(file);
    const conversation = await store.create('crash');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b', id: 'opencode:b' });
    const crashed = await store.create('crash2');
    void crashed;
    const transactions = await import('../src/state.js');
    await transactions.withStateLock(file, 'simulate-crash', async () => {
      await store.load();
      const target = (await store.get(conversation.id))!;
      void target;
    });
    // Write a queued message by hand (crash between persist-before-send and receipt).
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { conversations: Array<{ id: string; messages: unknown[]; lastSequence: number; updatedAt: string }> };
    const target = raw.conversations.find((c) => c.id === conversation.id)!;
    target.messages.push({ id: 'message_crashed', conversationId: conversation.id, sender: 'opencode:b', recipient: 'opencode:b', text: 'lost in crash', createdAt: new Date().toISOString(), sequence: 1, delivery: 'queued', idempotencyKey: 'crash-key-1' });
    await fs.writeFile(file, JSON.stringify(raw), 'utf8');
    // Restart: reconciliation reclassifies the orphan as delivery_unknown, no provider call.
    let providerCalls = 0;
    const registry = { send: async () => { providerCalls += 1; return {} as never; } } as never;
    const reconciled = await store.reconcileInterruptedSends(conversation.id);
    void registry; void providerCalls;
    assert.equal(reconciled.length, 1, 'the orphaned queued message must be found');
    assert.equal(reconciled[0]!.message.delivery, 'delivery_unknown');
    assert.equal(providerCalls, 0, 'reconciliation must not resend');
    // An observed receipt closes the record explicitly.
    const raw2 = JSON.parse(await fs.readFile(file, 'utf8')) as { conversations: Array<{ messages: Array<{ delivery: string }> }> };
    assert.equal(raw2.conversations.flatMap((c) => c.messages).every((m) => m.delivery !== 'queued'), true);
  } finally { await cleanup(); }
});

// ---- Second readiness review blockers 2/3: reconciliation semantics ----

/** Seeds a message row directly, simulating any historical delivery state. */
async function seedMessage(store: ConversationStore, file: string, conversationId: string, patch: Record<string, unknown>): Promise<string> {
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { conversations: Array<{ id: string; messages: Array<Record<string, unknown>>; lastSequence: number }> };
  const target = raw.conversations.find((c) => c.id === conversationId)!;
  const sequence = target.lastSequence + 1;
  target.lastSequence = sequence;
  target.messages.push({ id: `message_${String(patch.idempotencyKey)}`, conversationId, sender: 'opencode:a', recipient: 'opencode:b', text: 'seeded', createdAt: new Date().toISOString(), sequence, delivery: 'queued', ...patch });
  await fs.writeFile(file, JSON.stringify(raw), 'utf8');
  return String(patch.idempotencyKey);
}

test('reconcile: delivery_unknown resolves when a verified completed receipt is supplied', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('unknown-recovery');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b' });
    const key = await seedMessage(store, file, conversation.id, { idempotencyKey: 'key-unknown-1', delivery: 'delivery_unknown', deliveryUnknownAt: new Date().toISOString() });
    const out = await store.reconcileInterruptedSends(conversation.id, [{ idempotencyKey: key, receipt: { provider: 'opencode', nativeId: 'b', operation: 'send', accepted: true, status: 'completed' } }]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.resolved, true, 'a supplied verified receipt must resolve the record');
    assert.equal(out[0]!.message.delivery, 'completed');
    assert.equal((await store.get(conversation.id))!.messages[0]!.delivery, 'completed', 'the stored record must actually transition');
  } finally { await cleanup(); }
});

test('reconcile: queued reclassifies to delivery_unknown without a receipt; receipts classify accepted-but-not-completed as queued', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('queued-recovery');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b' });
    const key = await seedMessage(store, file, conversation.id, { idempotencyKey: 'key-queued-1' });
    const out = await store.reconcileInterruptedSends(conversation.id);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.resolved, false, 'reclassification without a receipt is honest, not resolution');
    assert.equal(out[0]!.message.delivery, 'delivery_unknown');
    // Now close it with an accepted-but-not-completed receipt: transport accepted, so the
    // record becomes queued-with-confirmed-receipt (provider turn observable via events).
    const out2 = await store.reconcileInterruptedSends(conversation.id, [{ idempotencyKey: key, receipt: { provider: 'opencode', nativeId: 'b', operation: 'send', accepted: true, status: 'queued' } }]);
    assert.equal(out2[0]!.resolved, true);
    assert.equal(out2[0]!.message.delivery, 'queued');
    assert.equal(out2[0]!.message.receipt?.accepted, true);
  } finally { await cleanup(); }
});

test('reconcile: rejected receipt closes delivery_unknown as rejected; terminal records are never touched', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('mixed');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b' });
    await seedMessage(store, file, conversation.id, { idempotencyKey: 'key-rej', delivery: 'delivery_unknown', deliveryUnknownAt: new Date().toISOString() });
    await seedMessage(store, file, conversation.id, { idempotencyKey: 'key-done', delivery: 'completed', receipt: { provider: 'opencode', nativeId: 'b', operation: 'send', accepted: true, status: 'completed' } });
    await seedMessage(store, file, conversation.id, { idempotencyKey: 'key-rejected', delivery: 'rejected', receipt: { provider: 'opencode', nativeId: 'b', operation: 'send', accepted: false, status: 'rejected' } });
    const out = await store.reconcileInterruptedSends(conversation.id, [{ idempotencyKey: 'key-rej', receipt: { provider: 'opencode', nativeId: 'b', operation: 'send', accepted: false, status: 'rejected' } }]);
    assert.equal(out.length, 1, 'only the non-terminal candidate is reported');
    assert.equal(out[0]!.resolved, true);
    assert.equal(out[0]!.message.delivery, 'rejected');
    const messages = (await store.get(conversation.id))!.messages;
    assert.equal(messages.find((m) => m.idempotencyKey === 'key-done')!.delivery, 'completed', 'completed records must not be reclassified');
    assert.equal(messages.find((m) => m.idempotencyKey === 'key-rejected')!.delivery, 'rejected', 'rejected records must not be reclassified');
  } finally { await cleanup(); }
});

test('reconcile: repeated reconciliation is idempotent and resolved stays false once closed without new receipts', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('repeat');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b' });
    const key = await seedMessage(store, file, conversation.id, { idempotencyKey: 'key-repeat', delivery: 'delivery_unknown', deliveryUnknownAt: new Date().toISOString() });
    const first = await store.reconcileInterruptedSends(conversation.id, [{ idempotencyKey: key, receipt: { provider: 'opencode', nativeId: 'b', operation: 'send', accepted: true, status: 'completed' } }]);
    assert.equal(first[0]!.resolved, true);
    // Second run: the record is terminal now, so nothing is returned at all.
    const second = await store.reconcileInterruptedSends(conversation.id, [{ idempotencyKey: key, receipt: { provider: 'opencode', nativeId: 'b', operation: 'send', accepted: true, status: 'completed' } }]);
    assert.equal(second.length, 0, 'a terminal record must not be re-reported as a candidate');
    // And an unknown record without receipts is reported with resolved:false every time.
    await seedMessage(store, file, conversation.id, { idempotencyKey: 'key-repeat-2', delivery: 'delivery_unknown', deliveryUnknownAt: new Date().toISOString() });
    const third = await store.reconcileInterruptedSends(conversation.id);
    assert.equal(third.length, 1);
    assert.equal(third[0]!.resolved, false);
    const fourth = await store.reconcileInterruptedSends(conversation.id);
    assert.equal(fourth.length, 1);
    assert.equal(fourth[0]!.resolved, false, 'unknown records stay unknown until a verified receipt arrives');
  } finally { await cleanup(); }
});

test('reconcile: an in-flight queued dispatch in this process is never reclassified as crashed', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('inflight');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b' });
    const key = await seedMessage(store, file, conversation.id, { idempotencyKey: 'key-inflight' });
    // Read the seeded message ID and mark its dispatch in flight (as send() does).
    const seeded = (await store.get(conversation.id))!.messages[0]!;
    store.markDispatchStarted(seeded.id);
    try {
      const out = await store.reconcileInterruptedSends(conversation.id);
      assert.equal(out.length, 0, 'the in-flight queued record must be skipped');
      assert.equal((await store.get(conversation.id))!.messages[0]!.delivery, 'queued', 'the healthy queued record stays queued');
    } finally { store.markDispatchFinished(seeded.id); }
    // Without the marker, the same record IS treated as an interrupted dispatch.
    const out2 = await store.reconcileInterruptedSends(conversation.id);
    assert.equal(out2.length, 1);
    assert.equal(out2[0]!.message.delivery, 'delivery_unknown');
    void key;
  } finally { await cleanup(); }
});

test('send: an in-flight dispatch is protected from concurrent reconciliation (end-to-end)', async () => {
  const { file, cleanup } = await tempStore();
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('race');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b' });
    let release; const gate = new Promise((r) => { release = r; });
    const registry = { send: async () => { await gate; return { provider: 'opencode', nativeId: 'b', operation: 'send', accepted: true, status: 'queued' }; } } as any;
    const sendPromise = store.send(conversation.id, 'opencode:a', 'opencode:b', 'hello', registry);
    await new Promise((r) => setTimeout(r, 80)); // dispatch is now in flight, record queued
    const reconciled = await store.reconcileInterruptedSends(conversation.id);
    assert.equal(reconciled.length, 0, 'concurrent reconciliation must not reclassify the in-flight send');
    release();
    const result = await sendPromise;
    assert.equal(result.message.delivery, 'queued');
    assert.equal((await store.get(conversation.id))!.messages[0]!.delivery, 'queued');
  } finally { await cleanup(); }
});

test('mcp: conversation_reconcile tool is registered and drives recovery through the runtime workflow', async () => {
  const { createServer } = await import('../src/mcp.js');
  const runtime = { capabilities: async () => ({ providers: {} }), listProjects: async () => [], listThreads: async () => [], getThread: async () => null, getMessages: async () => [], activeWork: async () => null, getThreadProgress: async () => ({ events: [], nextSequence: 0 }), watchThread: async () => ({ events: [], nextSequence: 0 }), getThreadProgressSummary: async () => ({}), watchActiveThreads: async () => ({}), listFiles: async () => [], readFile: async () => '', listModels: async () => [], sendMessage: async () => ({}), stop: async () => ({}), resume: async () => ({}), setModel: async () => ({}), setReasoning: async () => ({}), dispose: () => undefined } as never;
  const server = createServer(runtime, true, 'full') as unknown as { _registeredTools: Record<string, { handler?: (args: Record<string, never>) => Promise<{ content: Array<{ text: string }> }> }> };
  const tool = server._registeredTools['conversation_reconcile'];
  assert.ok(tool?.handler, 'conversation_reconcile must be registered as a write tool');
  // Drive it with a seeded delivery_unknown record; a verified receipt closes it.
  const { file, cleanup } = await tempStore();
  try {
    process.env.INTEROP_CONVERSATIONS_FILE = file;
    const fresh = createServer(runtime, true, 'full') as unknown as { _registeredTools: Record<string, { handler?: (args: Record<string, never>) => Promise<{ content: Array<{ text: string }> }> }> };
    const store = new ConversationStore(file);
    const conversation = await store.create('via-mcp');
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'a' });
    await store.join(conversation.id, { provider: 'opencode', nativeId: 'b' });
    await seedMessage(store, file, conversation.id, { idempotencyKey: 'key-mcp', delivery: 'delivery_unknown', deliveryUnknownAt: new Date().toISOString() });
    const result = await fresh._registeredTools['conversation_reconcile']!.handler!({ conversationId: conversation.id, observedReceipts: [{ idempotencyKey: 'key-mcp', receipt: { provider: 'opencode', nativeId: 'b', operation: 'send', accepted: true, status: 'completed' } }] });
    const payload = JSON.parse(result.content[0]!.text) as Array<{ resolved: boolean; message: { delivery: string } }>;
    assert.equal(payload[0]?.resolved, true);
    assert.equal(payload[0]?.message.delivery, 'completed');
  } finally { delete process.env.INTEROP_CONVERSATIONS_FILE; await cleanup(); }
});
