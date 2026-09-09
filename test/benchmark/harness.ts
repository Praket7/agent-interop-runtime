/**
 * Two-provider offline benchmark harness (audit §7 first vertical slice + §10).
 *
 * Fixed handoff tasks run against the REAL runtime contracts — ConversationStore,
 * WorkflowStore, InteropRegistry, and the MCP tool handlers — with two in-memory
 * provider peers (in-memory only; they are not live providers). No network, no live
 * providers, and no invented usage numbers.
 *
 * Measured, honestly labeled:
 * - payloadBytes: UTF-8 bytes of the exact JSON payload an MCP caller would receive.
 * - tokens: js-tiktoken `o200k_base` over the same payload. This is an OFFLINE ESTIMATE
 *   of prompt-size cost, not native provider usage reporting.
 * - duplicateReads: identical event/message bodies delivered more than once to the same
 *   consumer across paginated reads.
 * - providerUsage: only what the in-memory peers themselves observed (sends, cancels).
 *   Real provider usage/latency is reported as unknown because it is unobserved here.
 *
 * Fixed handoff tasks (identical inputs for every comparison run):
 *   T1 implement-utils:    sender → recipient with evidence + acceptance criteria
 *   T2 review-hotfix:      subject → reviewer with diff evidence and review verdict
 *   T3 blocked-then-resume: handoff blocked on a permission, then completed
 *
 * Run: npx pnpm build && node scripts/benchmark.mjs
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../../src/conversations.js';
import { WorkflowStore } from '../../src/workflow.js';
import { InteropRegistry } from '../../src/interop-runtime.js';
import { InMemoryProvider, DuplicateReadCounter, countBytes, countPayloadTokens } from './shared.js';

export interface TaskResult {
  task: string;
  steps: number;
  payloadBytes: number;
  tokens: number;
  duplicateReads: number;
  providerObservedSends: number;
  duplicateProviderSends: number;
  finalState: string;
}

const CRITERIA_IMPLEMENT = ['util parses ISO dates', 'handles invalid input without throwing'];
const CRITERIA_REVIEW = ['reviewer confirms the fix matches the objective', 'no unrelated files changed'];

async function tempState(): Promise<{ dir: string; conversations: string; workflow: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-bench-'));
  return { dir, conversations: path.join(dir, 'conversations.json'), workflow: path.join(dir, 'workflow.json') };
}

/**
 * One benchmark task: create work + handoff in the real WorkflowStore, deliver a
 * directed message through the real ConversationStore + InteropRegistry, then observe
 * the outcome through paginated reads. Every returned payload is metered.
 */
export async function runTask(
  name: string,
  steps: {
    objective: string;
    criteria: string[];
    senderProvider: InMemoryProvider;
    recipientProvider: InMemoryProvider;
    blockers?: number;
  },
): Promise<TaskResult> {
  const state = await tempState();
  try {
    const conversations = new ConversationStore(state.conversations);
    const workflow = new WorkflowStore(state.workflow);
    const registry = new InteropRegistry().register(steps.senderProvider).register(steps.recipientProvider);
    const metered: unknown[] = [];

    // Discover exact native sessions through the real registry path.
    const sessions = await registry.listSessions();
    metered.push(sessions);
    const sender = sessions.find((s) => s.provider === steps.senderProvider.id)!;
    const recipient = sessions.find((s) => s.provider === steps.recipientProvider.id)!;

    // Durable work record and bounded handoff packet (objective, criteria, evidence refs).
    const work = await workflow.createWork({
      objective: steps.objective,
      acceptanceCriteria: steps.criteria,
      sourceSession: sender.id,
      unresolvedQuestions: ['should the helper be exported from the index?'],
    });
    const evidence = await workflow.addEvidence({
      workId: work.id, sessionId: sender.id, kind: 'diff', trust: 'runtime_observed',
      source: { adapter: steps.senderProvider.id }, summary: 'Native diff snapshot for handoff',
      data: await registry.diff(steps.senderProvider.id, sender.nativeId),
    });
    const handoff = await workflow.createHandoff({
      workId: work.id, sourceSession: sender.id, destinationSession: recipient.id,
      objective: steps.objective, acceptanceCriteria: steps.criteria, evidenceIds: [evidence.id],
      changedFiles: ['src/utils.ts'], risks: [], unresolvedQuestions: [], authorityBoundaries: ['recipient implements; reviewer reports only'],
    });
    metered.push(work, evidence, handoff);

    // Directed delivery through the real persist-before-send path.
    const conversation = await conversations.create(`bench: ${name}`);
    await conversations.join(conversation.id, { provider: steps.senderProvider.id, nativeId: sender.nativeId, id: sender.id });
    await conversations.join(conversation.id, { provider: steps.recipientProvider.id, nativeId: recipient.nativeId, id: recipient.id });
    const { message, receipt } = await conversations.send(
      conversation.id, sender.id, recipient.id,
      `Handoff ${handoff.id}: ${steps.objective}. Criteria: ${JSON.stringify(steps.criteria)}. Evidence: ${evidence.id}. Authority: implement within src/utils.ts only.`,
      registry,
    );
    metered.push({ message: { ...message, text: message.text.slice(0, 80) + '…' }, receipt });

    // Correlate the lifecycle through bounded observation (blocked phases if requested).
    if (steps.blockers) {
      for (let i = 0; i < steps.blockers; i += 1) await steps.recipientProvider.runTurn(recipient.nativeId, ['blocked']);
    }
    await steps.recipientProvider.runTurn(recipient.nativeId, ['completed']);

    // Paginated observation: cursor round trips against the shared per-session buffer.
    // Each observer (sender-side, recipient-side) has its own duplicate counter: the same
    // event legitimately fans out to two observers, but redelivery to the SAME observer
    // is a cursor-contract bug and is metered as a duplicate.
    let duplicateReads = 0;
    for (const provider of [steps.senderProvider, steps.recipientProvider]) {
      const observer = new DuplicateReadCounter();
      let cursor = 0;
      const total = provider === steps.recipientProvider ? 2 + (steps.blockers ?? 0) : 2;
      for (let page = 0; page < 6; page += 1) {
        const events = await registry.readEvents(provider.id, recipient.nativeId, 2, 50, cursor);
        for (const event of events) observer.record({ key: `event:${event.sequence}`, body: event });
        metered.push(events);
        if (events.length === 0) { if (cursor >= total) break; else continue; }
        cursor = Math.max(...events.map((e) => e.sequence));
        if (cursor >= total) break;
      }
      duplicateReads += observer.duplicates().length;
    }
    // Transcript observation: two cursor round trips; redelivery to the same reader is metered.
    const transcriptObserver = new DuplicateReadCounter();
    let transcriptCursor = 0;
    for (let page = 0; page < 2; page += 1) {
      const conversationPage = await conversations.read(conversation.id, transcriptCursor, 100);
      for (const m of conversationPage.messages) transcriptObserver.record({ key: `message:${m.id}`, body: m });
      metered.push(conversationPage.messages.map((m) => ({ ...m, text: `${m.text.slice(0, 40)}…` })));
      if (conversationPage.next <= transcriptCursor) break;
      transcriptCursor = conversationPage.next;
    }
    duplicateReads += transcriptObserver.duplicates().length;

    // Record the terminal work state through the real verification gate.
    await workflow.verify(work.id, process.cwd(), [
      { executable: process.execPath, args: ['-e', 'process.exit(0)'], label: 'bench-check' },
    ]);
    const updated = await workflow.getWork(work.id);
    const finalState = updated?.status ?? 'unknown';

    return {
      task: name,
      steps: metered.length,
      payloadBytes: metered.reduce((sum, payload) => sum + countBytes(payload), 0),
      tokens: metered.reduce((sum, payload) => sum + countPayloadTokens(payload), 0),
      duplicateReads,
      providerObservedSends: steps.recipientProvider.received.length,
      duplicateProviderSends: steps.recipientProvider.received.filter((r, i, all) => all.findIndex((o) => o.text === r.text && o.nativeId === r.nativeId) !== i).length,
      finalState,
    };
  } finally {
    await fs.rm(state.dir, { recursive: true, force: true });
  }
}

/** Full harness: all fixed tasks plus a catalog-level context measurement. */
export async function runBenchmark(): Promise<{
  tokenizer: string;
  tasks: TaskResult[];
  catalog: { profile: string; tools: number; bytes: number; tokens: number };
}> {
  const { createServer } = await import('../../src/mcp.js');
  const { profileToolset } = await import('../../src/profiles.js');
  const tasks = [
    await runTask('implement-utils', {
      objective: 'Implement a date-parsing utility in src/utils.ts with tests',
      criteria: CRITERIA_IMPLEMENT,
      senderProvider: new InMemoryProvider('codex', 'Benchmark Sender', [{ nativeId: 'sender-1', cwd: '/tmp/bench-sender' }]),
      recipientProvider: new InMemoryProvider('claude-code', 'Benchmark Recipient', [{ nativeId: 'worker-1', cwd: '/tmp/bench-recipient' }]),
    }),
    await runTask('review-hotfix', {
      objective: 'Review the auth hotfix against the original objective',
      criteria: CRITERIA_REVIEW,
      senderProvider: new InMemoryProvider('opencode', 'Benchmark Subject', [{ nativeId: 'subject-1', cwd: '/tmp/bench-subject' }]),
      recipientProvider: new InMemoryProvider('cursor', 'Benchmark Reviewer', [{ nativeId: 'reviewer-1', cwd: '/tmp/bench-reviewer' }]),
    }),
    await runTask('blocked-then-resume', {
      objective: 'Apply the migration script after approval',
      criteria: ['migration runs cleanly', 'rollback documented'],
      senderProvider: new InMemoryProvider('codex', 'Benchmark Sender', [{ nativeId: 'sender-2', cwd: '/tmp/bench-sender' }]),
      recipientProvider: new InMemoryProvider('claude-code', 'Benchmark Worker', [{ nativeId: 'worker-2', cwd: '/tmp/bench-worker' }]),
      blockers: 2,
    }),
  ];
  // Catalog measurement uses the real MCP server object with a stub runtime.
  const stubRuntime = { capabilities: async () => ({}) } as never;
  const fullServer = createServer(stubRuntime, true, 'full') as unknown as { _registeredTools: Record<string, { title?: string; description?: string }> };
  const coreServer = createServer(stubRuntime, true, 'core') as unknown as { _registeredTools: Record<string, { title?: string; description?: string }> };
  const measure = (server: typeof fullServer) => {
    const entries = Object.entries(server._registeredTools).map(([name, tool]) => ({ name, description: tool.description }));
    return { profile: '', tools: entries.length, bytes: countBytes(entries), tokens: countPayloadTokens(entries) };
  };
  const full = measure(fullServer); const core = measure(coreServer);
  return {
    tokenizer: 'js-tiktoken o200k_base (offline estimate, not native provider usage)',
    tasks,
    catalog: { profile: 'full vs core', tools: full.tools - core.tools, bytes: full.bytes - core.bytes, tokens: full.tokens - core.tokens },
  };
}

// Direct execution: node test/benchmark/harness.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runBenchmark();
  console.log(JSON.stringify(result, null, 2));
}
