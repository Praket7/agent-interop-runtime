import test from 'node:test';
import { countJsonTokens } from '../src/tokens.js';
import assert from 'node:assert/strict';
import { WorkflowStore } from '../src/workflow.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('workflow store keeps work provenance and deterministic verification evidence', async () => {
  const store = new WorkflowStore();
  const work = await store.createWork({ objective: 'verify a change', acceptanceCriteria: ['command passes'], sourceSession: 'codex:thread-1' });
  const evidence = await store.addEvidence({ workId: work.id, sessionId: 'codex:thread-1', kind: 'diff', trust: 'provider_observed', source: { adapter: 'codex' }, summary: 'native diff', data: { files: ['src/a.ts'] } });
  const handoff = await store.createHandoff({ workId: work.id, sourceSession: 'codex:thread-1', destinationSession: 'claude-code:session-2', objective: 'review', acceptanceCriteria: ['find blockers'], evidenceIds: [evidence.id], changedFiles: ['src/a.ts'], risks: [], unresolvedQuestions: [], authorityBoundaries: ['reviewer cannot edit'] });
  assert.equal(handoff.status, 'created');
  const results = await store.verify(work.id, process.cwd(), ['node --version']);
  assert.equal(results[0]?.commands[0]?.exitCode, 0);
  // AI-08: verification success is distinct from human acceptance of the objective.
  assert.equal((await store.getWork(work.id))?.status, 'in_progress');
  assert.equal((await store.listEvidence(work.id)).some((item) => item.trust === 'runtime_observed'), true);
});

test('workflow store preserves corrupt state and reports recovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-state-'));
  const file = path.join(directory, 'state.json');
  await fs.writeFile(file, '{not-json', 'utf8');
  const store = new WorkflowStore(file);
  await store.load();
  const recovery = store.recoveryStatus();
  assert.equal(recovery?.required, true);
  assert.equal(recovery?.file, file);
  assert.ok(recovery?.preservedFile);
  await fs.rm(directory, { recursive: true, force: true });
});

test('handoff token budget: oversized fields become explicit omissions, durable record keeps everything (AIR-05)', async () => {
  const previous = process.env.INTEROP_HANDOFF_TOKEN_BUDGET;
  try {
    const store = new WorkflowStore();
    // Controlled input: a fixed workId so the packet's token size is a pure function of
    // the caller's content — no random store-generated IDs participate in accounting.
    const workId = 'work_budget_fixture';
    const input = {
      workId, sourceSession: 'codex:t1', destinationSession: 'claude-code:s1',
      objective: 'Apply the migration script and report results',
      acceptanceCriteria: ['migration runs cleanly', 'rollback documented'],
      evidenceIds: ['evidence_1'], changedFiles: ['db/migration.sql', 'db/rollback.sql', 'docs/migration-notes.md'],
      // Large controlled risk text: its exclusion gap (hundreds of tokens) must dwarf
      // both the omission-note cost (~29 tokens) and random-ID tokenization variance
      // (a 12-token band), so the budget sits in a wide, deterministic safe zone.
      risks: [
        'locking on large tables during the migration window may block production traffic for several minutes and require a coordinated maintenance announcement',
        'replication lag may cause stale reads on the analytics replica during the cutover window',
        ...Array.from({ length: 12 }, (_, i) => `contingency ${i + 1}: if step ${i + 1} of the migration plan fails mid-application, roll back using the documented procedure, verify row counts against the pre-migration snapshot, and notify the on-call owner before retrying`),
      ],
      unresolvedQuestions: ['should the analytics replica be paused during the migration window to avoid replication lag and stale dashboards during the cutover'],
      authorityBoundaries: ['recipient may run migrations only in the staging workspace'],
    };
    // Derive the test budget from MEASURED content sizes so the omission path triggers
    // deterministically. Two constraints must hold simultaneously, both far outside
    // random-ID tokenization variance (±a few tokens):
    //   1. without-risks packet + omission note + margin <= budget  (note fits)
    //   2. full packet - margin > budget                             (risks cannot fit)
    // The note cost is measured with the same tokenizer; the budget number appears in the
    // note text, so the computation converges on its own digit count.
    process.env.INTEROP_HANDOFF_TOKEN_BUDGET = '100000';
    const probeFull = await store.createHandoff(input);
    const probeWithoutRisks = await store.createHandoff({ ...input, risks: [] });
    const gap = probeFull.contextTokens - probeWithoutRisks.contextTokens;
    assert.ok(gap > 200, 'risks must be large enough that its exclusion gap dwarfs the omission-note cost and ID tokenization noise');
    // Budget at the gap midpoint: far above (without-risks + note + noise) and far below
    // (full - noise). No iteration needed; the midpoint has ~100 tokens of clearance on
    // both sides.
    const budget = probeWithoutRisks.contextTokens + Math.floor(gap / 2);
    process.env.INTEROP_HANDOFF_TOKEN_BUDGET = String(budget);
    const handoff = await store.createHandoff(input);
    assert.ok(handoff.contextTokens > 0);
    assert.equal(handoff.tokenBudget, budget);
    assert.ok(handoff.omittedFields.includes('risks'), `risks must be the omitted field (got ${handoff.omittedFields})`);
    // Durable record keeps every field even when the packet omits it.
    assert.ok(handoff.risks.length === 14, 'durable record must not silently lose fields');
    const packet = await store.handoffPacket(handoff.id);
    for (const field of handoff.omittedFields) assert.equal((packet as Record<string, unknown>)[field], undefined, `omitted field ${field} must not appear in the packet`);
    for (const omission of packet.omissions) assert.match(omission.reason, /token handoff budget/);
    assert.equal(packet.tokenizer.includes('o200k_base'), true);
    assert.ok(handoff.contextTokens <= handoff.tokenBudget, 'kept fields must fit the budget');
  } finally {
    if (previous === undefined) delete process.env.INTEROP_HANDOFF_TOKEN_BUDGET; else process.env.INTEROP_HANDOFF_TOKEN_BUDGET = previous;
  }
});

test('handoff IDs are collision-resistant under a frozen clock (same-millisecond creations must not overwrite)', async () => {
  const realNow = Date.now;
  const fixed = realNow();
  Date.now = () => fixed;
  try {
    const store = new WorkflowStore();
    const base = {
      workId: 'work_collision_fixture', sourceSession: 'codex:t1', destinationSession: 'claude-code:s1',
      objective: 'placeholder', acceptanceCriteria: ['done'], evidenceIds: [], changedFiles: [],
      risks: [], unresolvedQuestions: [], authorityBoundaries: ['staging only'],
    };
    const first = await store.createHandoff({ ...base, objective: 'First handoff objective' });
    const second = await store.createHandoff({ ...base, objective: 'Second handoff objective' });
    assert.notEqual(first.id, second.id, 'two handoffs created in the same millisecond must have distinct IDs');
    // Each ID resolves to its own record: the second creation must not overwrite the first.
    const packetFirst = await store.handoffPacket(first.id);
    const packetSecond = await store.handoffPacket(second.id);
    assert.equal(packetFirst.objective, 'First handoff objective');
    assert.equal(packetSecond.objective, 'Second handoff objective');
    assert.equal((await store.listHandoffs()).length, 2);
  } finally {
    Date.now = realNow;
  }
});

test('handoff token budget: small handoffs report zero omissions and full packet', async () => {
  const store = new WorkflowStore();
  const work = await store.createWork({ objective: 'fix typo', acceptanceCriteria: ['fixed'] });
  const handoff = await store.createHandoff({
    workId: work.id, sourceSession: 'codex:t1', objective: 'fix the typo in README',
    acceptanceCriteria: ['fixed'], evidenceIds: [], changedFiles: [], risks: [], unresolvedQuestions: [], authorityBoundaries: [],
  });
  assert.deepEqual(handoff.omittedFields, []);
  const packet = await store.handoffPacket(handoff.id);
  assert.equal(packet.objective, 'fix the typo in README');
  assert.deepEqual(packet.omissions, []);
  assert.ok(handoff.contextTokens > 0);
});

test('handoff packet: unknown id fails clearly', async () => {
  const store = new WorkflowStore();
  await assert.rejects(() => store.handoffPacket('nope'), /Unknown handoff/);
});

test('handoff token budget: mandatory fields that cannot fit are rejected before delivery (AIR-05)', async () => {
  const previous = process.env.INTEROP_HANDOFF_TOKEN_BUDGET;
  process.env.INTEROP_HANDOFF_TOKEN_BUDGET = '100';
  try {
    const store = new WorkflowStore();
    const work = await store.createWork({ objective: 'migrate schema', acceptanceCriteria: ['done'] });
    await assert.rejects(
      () => store.createHandoff({
        workId: work.id, sourceSession: 'codex:t1', destinationSession: 'claude-code:s1',
        objective: 'Implement requested changes. '.repeat(40),
        acceptanceCriteria: ['tests pass'],
        authorityBoundaries: ['Do not publish. '.repeat(40)],
        evidenceIds: [], changedFiles: [], risks: [], unresolvedQuestions: [],
      }),
      /NOT created/,
      'a handoff whose mandatory fields exceed the budget must be rejected before delivery',
    );
  } finally {
    if (previous === undefined) delete process.env.INTEROP_HANDOFF_TOKEN_BUDGET; else process.env.INTEROP_HANDOFF_TOKEN_BUDGET = previous;
  }
});
