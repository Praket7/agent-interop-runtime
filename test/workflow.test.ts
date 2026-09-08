import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowStore } from '../src/workflow.js';

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
