import test from 'node:test';
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
  assert.equal((await store.getWork(work.id))?.status, 'accepted');
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
