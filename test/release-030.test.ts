import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../src/conversations.js';
import { WorkflowStore } from '../src/workflow.js';
import { InteropRegistry } from '../src/interop-runtime.js';
import { ClaudeCodeAdapter, OpenCodeAdapter, isLoopbackHost } from '../src/adapters.js';

async function temp(name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), name));
  return { dir, file: path.join(dir, 'state.json'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('0.3: caller idempotency keys are atomic across two stores', async () => {
  const { file, cleanup } = await temp('interop-idempotency-');
  try {
    const a = new ConversationStore(file);
    const conversation = await a.create('atomic');
    await a.join(conversation.id, { provider: 'codex', nativeId: 'a' });
    await a.join(conversation.id, { provider: 'codex', nativeId: 'b' });
    const b = new ConversationStore(file); await b.load();
    let sends = 0;
    const registry = { send: async () => { sends += 1; return { provider: 'codex', nativeId: 'b', operation: 'send', accepted: true, status: 'completed' }; } } as never;
    const results = await Promise.allSettled([
      a.send(conversation.id, 'codex:a', 'codex:b', 'one', registry, undefined, undefined, 'stable-work-key'),
      b.send(conversation.id, 'codex:a', 'codex:b', 'two', registry, undefined, undefined, 'stable-work-key'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(sends, 1, 'only one provider dispatch may occur for one caller idempotency key');
    const disk = new ConversationStore(file); await disk.load();
    assert.equal((await disk.get(conversation.id))!.messages.filter((m) => m.idempotencyKey === 'stable-work-key').length, 1);
  } finally { await cleanup(); }
});

test('0.3: a durable dispatch lease prevents another process from reclassifying live work', async () => {
  const { file, cleanup } = await temp('interop-dispatch-');
  try {
    const a = new ConversationStore(file);
    const conversation = await a.create('lease');
    await a.join(conversation.id, { provider: 'codex', nativeId: 'a' });
    await a.join(conversation.id, { provider: 'codex', nativeId: 'b' });
    let finish!: (value: unknown) => void;
    const registry = { send: async () => await new Promise((resolve) => { finish = resolve; }) } as never;
    const sending = a.send(conversation.id, 'codex:a', 'codex:b', 'slow', registry, undefined, undefined, 'lease-key');
    const b = new ConversationStore(file);
    for (let i = 0; i < 50; i += 1) {
      const current = await b.get(conversation.id);
      if (current?.messages[0]?.dispatchLease) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const before = (await b.get(conversation.id))!.messages[0]!;
    assert.ok(before.dispatchLease);
    assert.equal(before.delivery, 'queued');
    const reconciled = await b.reconcileInterruptedSends(conversation.id);
    assert.equal(reconciled.length, 0, 'live leased dispatch must be skipped by another process');
    assert.equal((await b.get(conversation.id))!.messages[0]!.delivery, 'queued');
    finish({ provider: 'codex', nativeId: 'b', operation: 'send', accepted: true, status: 'completed' });
    await sending;
  } finally { await cleanup(); }
});

test('0.3: workflow readers observe other-process writes', async () => {
  const { file, cleanup } = await temp('interop-workflow-refresh-');
  try {
    const reader = new WorkflowStore(file); await reader.load();
    const writer = new WorkflowStore(file); await writer.load();
    const work = await writer.createWork({ objective: 'external write', acceptanceCriteria: ['visible'] });
    assert.equal((await reader.getWork(work.id))?.objective, 'external write');
  } finally { await cleanup(); }
});

test('0.3: resource claims enforce deterministic ownership and release', async () => {
  const { file, cleanup } = await temp('interop-claims-');
  try {
    const store = new WorkflowStore(file);
    const workA = await store.createWork({ objective: 'A', acceptanceCriteria: ['done'] });
    const workB = await store.createWork({ objective: 'B', acceptanceCriteria: ['done'] });
    const claim = await store.claimResource({ workId: workA.id, sessionId: 'codex:a', resource: 'src/auth', kind: 'directory' });
    await assert.rejects(
      () => store.claimResource({ workId: workB.id, sessionId: 'claude-code:b', resource: 'src/auth/token.ts', kind: 'file' }),
      /conflicts with active claim/,
    );
    await assert.rejects(() => store.releaseClaim(claim.id, 'claude-code:b'), /belongs to codex:a/);
    await store.releaseClaim(claim.id, 'codex:a');
    const next = await store.claimResource({ workId: workB.id, sessionId: 'claude-code:b', resource: 'src/auth/token.ts', kind: 'file' });
    assert.equal(next.status, 'active');
  } finally { await cleanup(); }
});

test('0.3: evidence is addressable and hashed and handoff state is structured', async () => {
  const store = new WorkflowStore();
  const base = await store.createWork({ objective: 'base', acceptanceCriteria: ['green'] });
  const dependent = await store.createWork({ objective: 'continue', acceptanceCriteria: ['green'], dependsOn: [base.id] });
  const evidence = await store.addEvidence({ workId: dependent.id, kind: 'test', trust: 'runtime_observed', source: { adapter: 'test' }, summary: 'tests passed', data: { exitCode: 0 } });
  assert.match(evidence.contentHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal((await store.getEvidence(evidence.id))?.contentHash, evidence.contentHash);
  const handoff = await store.createHandoff({
    workId: dependent.id,
    sourceSession: 'codex:a',
    destinationSession: 'claude-code:b',
    objective: 'continue safely',
    acceptanceCriteria: ['green'],
    evidenceIds: [evidence.id],
    changedFiles: ['src/a.ts'],
    risks: ['API drift'],
    unresolvedQuestions: ['Does B need migration?'],
    authorityBoundaries: ['Do not edit migrations'],
    continuationState: 'needs_completion',
    latestValidation: { command: 'pnpm test', outcome: 'passed' },
    assumptions: ['Current API remains stable'],
    rollbackNotes: ['Revert src/a.ts if integration fails'],
    nextAction: 'Inspect failing integration test',
    repositoryRevision: 'abc123',
  });
  const packet = await store.handoffPacket(handoff.id);
  assert.equal(packet.continuationState, 'needs_completion');
  assert.equal(packet.latestValidation?.outcome, 'passed');
  assert.equal(packet.repositoryRevision, 'abc123');
  await store.updateHandoffStatus(handoff.id, 'accepted');
  await store.updateHandoffStatus(handoff.id, 'applied');
  await assert.rejects(() => store.updateHandoffStatus(handoff.id, 'completed'), /Invalid handoff transition/);
  await store.updateHandoffStatus(handoff.id, 'verified');
  assert.equal((await store.updateHandoffStatus(handoff.id, 'completed')).status, 'completed');
  assert.ok((await store.graph()).edges.some((edge) => edge.from === dependent.id && edge.to === base.id && edge.kind === 'depends_on'));
});

test('0.3: native permission IDs round-trip without double-prefixing', async () => {
  const adapter = new ClaudeCodeAdapter({ rpc: async () => ({}) });
  const pending = (adapter as any).handleServerRequest({ id: 7, method: 'session/request_permission', params: { sessionId: 'session-a', choices: ['allow', 'deny'] } });
  await Promise.resolve();
  const listed = adapter.listPendingPermissions();
  assert.equal(listed[0]?.requestId, '7');
  assert.equal(listed[0]?.nativeId, 'session-a');
  await adapter.respondPermission('session-a', '7', 'deny');
  const resolved = await pending;
  assert.equal(resolved.outcome.outcome, 'deny');
});

test('0.3: provider event pumps reopen after a native iterator ends', async () => {
  let sequence = 0;
  let subscriptions = 0;
  const adapter = {
    id: 'codex',
    capabilities: async () => { throw new Error('unused'); },
    listSessions: async () => [],
    getSession: async () => null,
    events: async function* () { subscriptions += 1; yield { provider: 'codex', nativeId: 's', sequence: ++sequence, timestamp: new Date().toISOString(), type: 'event', data: null }; },
  } as any;
  const registry = new InteropRegistry().register(adapter);
  const first = await registry.readEventPage('codex', 's', 1, 1000, 0);
  assert.equal(first.events[0]?.sequence, 1);
  assert.equal(first.epoch, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await registry.readEventPage('codex', 's', 1, 1000, 1);
  assert.equal(second.events[0]?.sequence, 2, 'registry cursor must not reset when the provider iterator reconnects');
  assert.equal(second.epoch, 2);
  assert.equal(second.next, 2);
  assert.equal(subscriptions, 2);
});

test('0.3: endpoint security rejects IPv6 wildcard and blocks HTTP redirects', async () => {
  assert.equal(isLoopbackHost('::'), false);
  assert.equal(isLoopbackHost('::1'), true);
  const previousFetch = globalThis.fetch;
  let redirect: RequestRedirect | undefined;
  globalThis.fetch = async (_input, init) => { redirect = init?.redirect; return new Response(JSON.stringify({ healthy: true }), { status: 200 }); };
  try {
    const adapter = new OpenCodeAdapter('http://127.0.0.1:4096');
    await adapter.capabilities();
    assert.equal(redirect, 'error');
  } finally { globalThis.fetch = previousFetch; }
});

test('0.3: custom conversation participant IDs cannot alias another native session', async () => {
  const { file, cleanup } = await temp('interop-participant-id-');
  try {
    const store = new ConversationStore(file);
    const conversation = await store.create('ids');
    await store.join(conversation.id, { provider: 'codex', nativeId: 'a', id: 'shared-name' });
    await assert.rejects(
      () => store.join(conversation.id, { provider: 'claude-code', nativeId: 'b', id: 'shared-name' }),
      /already bound/,
    );
  } finally { await cleanup(); }
});


test('0.3: configured remote OpenCode failures never fall back to a local discovered server', async () => {
  const previousFetch = globalThis.fetch;
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_SERVER_PASSWORD = 'audit-placeholder-password';
  const seen: string[] = [];
  globalThis.fetch = async (input) => { seen.push(String(input)); throw new Error('remote unavailable'); };
  try {
    const adapter = new OpenCodeAdapter('https://example.invalid:4096');
    const capabilities = await adapter.capabilities();
    assert.equal(capabilities.discovery.supported, false);
    assert.ok(seen.length >= 1);
    assert.equal(seen.every((value) => new URL(value).hostname === 'example.invalid'), true, 'remote configuration must never retarget to a loopback server after failure');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD; else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
  }
});


test('0.3: async review transactions persist nested evidence without overwriting it', async () => {
  const { file, cleanup } = await temp('interop-review-atomic-');
  try {
    const store = new WorkflowStore(file);
    const work = await store.createWork({ objective: 'review persistence', acceptanceCriteria: ['review stored'] });
    const subject = await store.addEvidence({ workId: work.id, kind: 'diff', trust: 'runtime_observed', source: { adapter: 'fixture' }, summary: 'subject', data: { diff: 'x' } });
    const review = await store.createReview({
      workId: work.id,
      subjectEvidenceIds: [subject.id],
      reviewerSessionId: 'codex:reviewer',
      independence: { differentSession: true, differentProvider: true, freshContext: true, writeAccess: false },
      findings: [],
      verdict: 'approve',
    });
    const fresh = new WorkflowStore(file);
    await fresh.load();
    assert.equal((await fresh.listReviews(work.id)).some((value) => value.id === review.id), true);
    const evidence = await fresh.listEvidence(work.id);
    assert.equal(evidence.some((value) => value.kind === 'review' && value.summary.includes('review verdict approve')), true);
  } finally { await cleanup(); }
});
