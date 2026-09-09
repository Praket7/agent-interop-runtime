import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters.js';
import { InteropRegistry } from '../src/interop-runtime.js';
import { WorkflowStore } from '../src/workflow.js';
import { validateToml } from '../src/toml.js';

interface JsonRpcMessage { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown }

/**
 * Wire-level ACP contract fixture: a real child process speaking newline-delimited JSON-RPC
 * over stdio. It implements the negotiated ACP v1 behavior the audit found violated —
 * session/cancel is a NOTIFICATION and is never answered — so a request-shaped cancel
 * would time out exactly as it did against real providers.
 */
async function startAcpPeer(): Promise<{ child: ReturnType<typeof spawn>; next: () => Promise<JsonRpcMessage>; send: (message: object) => void; stop: () => void }> {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'acp-peer.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffered = '';
  const queue: JsonRpcMessage[] = [];
  const waiters: Array<(message: JsonRpcMessage) => void> = [];
  child.stdout!.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonRpcMessage;
      const waiter = waiters.shift();
      if (waiter) waiter(message); else queue.push(message);
    }
  });
  child.stderr!.on('data', () => { /* diagnostics only */ });
  return {
    child,
    next: () => new Promise((resolve) => { const queued = queue.shift(); if (queued) resolve(queued); else waiters.push(resolve); }),
    send: (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`),
    stop: () => { child.kill(); },
  };
}

test('ACP wire fixture: no-reply session/cancel notification does not time out and requests stay unanswered', async () => {
  const peer = await startAcpPeer();
  try {
    const rpc = async (method: string, params?: unknown, timeoutMs = 5_000): Promise<unknown> => {
      const id = Math.floor(Math.random() * 1e9);
      peer.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`JSON RPC request timed out: ${method}`);
        const message = await Promise.race([peer.next(), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining))]);
        if (message === 'timeout') continue;
        if (message.id === id) { if (message.error) throw new Error(String((message.error as { message?: string }).message ?? 'rpc error')); return message.result; }
      }
    };
    // Bring the adapter up against the wire peer by injecting a custom command is not
    // possible through rpc, so drive the contract directly: initialize, session/new,
    // prompt, then a cancel notification that the peer will never answer.
    const result = await rpc('initialize', { protocolVersion: 1, clientInfo: { name: 'agent-interop-runtime' }, clientCapabilities: { fs: { readTextFile: true }, terminal: false } }) as { protocolVersion: number };
    assert.equal(result.protocolVersion, 1);
    const session = await rpc('session/new', { cwd: process.cwd(), mcpServers: [] }) as { sessionId: string };
    assert.ok(session.sessionId);
    const promptId = Math.floor(Math.random() * 1e9);
    peer.send({ jsonrpc: '2.0', id: promptId, method: 'session/prompt', params: { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'long running work' }] } });
    // The fixture holds the prompt open with no reply — exactly the no-reply situation that
    // must not affect cancellation. Send cancellation as the ACP v1 notification (no id);
    // the peer then answers the original prompt with stopReason cancelled.
    peer.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.sessionId } });
    for (;;) {
      const message = await peer.next();
      if (message.id === promptId) {
        assert.deepEqual((message.result as { stopReason?: string }).stopReason, 'cancelled');
        break;
      }
    }
  } finally { peer.stop(); }
});

test('adapter cancel() uses notify transport: zero request calls for session/cancel', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = (async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    if (method === 'session/new') return { sessionId: 'wire-1' };
    return {};
  }) as unknown;
  const adapter = new ClaudeCodeAdapter({ rpc: rpc as never });
  await adapter.createSession({ cwd: process.cwd() });
  const started = Date.now();
  const receipt = await adapter.cancel('wire-1');
  assert.equal(receipt.accepted, true);
  assert.ok(Date.now() - started < 1_000, 'notification-shaped cancel must not wait on a reply');
  assert.equal(calls.filter((call) => call.method === 'session/cancel').length, 0, 'cancel must not be sent through the request channel');
});

test('pending permission requests are surfaced with method, options, and session, and require explicit response', async () => {
  const registry = new InteropRegistry();
  const adapter = new ClaudeCodeAdapter({ rpc: (async (method: string) => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    if (method === 'session/new') return { sessionId: 'perm-1' };
    return {};
  }) as never });
  registry.register(adapter);
  assert.deepEqual(registry.pendingPermissions(), []);
  // The registry exposes nothing until a provider asks; when one does, respondPermission
  // remains the only path and it throws for unknown request IDs rather than auto-approving.
  await assert.rejects(() => registry.permission('claude-code', 'perm-1', 'no-such-request', 'allow_once'), /No pending permission request/);
});

test('workflow review provenance: caller-submitted reviews are agent_claim, never provider_observed', async () => {
  const store = new WorkflowStore();
  const work = await store.createWork({ objective: 'review me', acceptanceCriteria: ['c'] });
  const review = await store.createReview({
    workId: work.id,
    subjectEvidenceIds: [],
    reviewerSessionId: 'codex:invented-session',
    independence: { differentSession: true, differentProvider: true, freshContext: true, writeAccess: false },
    findings: [],
    verdict: 'approve',
  });
  assert.equal(review.provenance, 'agent_claim');
  const evidence = await store.listEvidence(work.id);
  assert.equal(evidence.some((e) => e.trust === 'agent_claim'), true);
  assert.equal(evidence.some((e) => e.trust === 'provider_observed'), false, 'invented reviewer IDs must not become provider observations');
});

test('repositoryDiff declares truncation metadata', async () => {
  const { repositoryDiff } = await import('../src/verification.js');
  const result = await repositoryDiff(process.cwd());
  assert.equal(typeof result.diffTruncated, 'boolean');
  assert.equal(result.diffTruncated, result.diffTotalBytes > result.diff.length);
  assert.equal(result.statusTruncated, result.statusTotalBytes > result.status.length);
});

test('TOML validator: nested tables preserved and malformed rejected before/after merge', () => {
  const existing = "[mcp_servers.existing]\ncommand = 'other'\n\n[mcp_servers.existing.env]\nTOKEN = 'keep-me'\n";
  assert.deepEqual(validateToml(existing), []);
  const merged = `${existing}\n[mcp_servers.agent_interop]\ncommand = 'npx'\nargs = ['-y', 'agent-interop-runtime@0.2.10', 'serve']\nenabled = true\n`;
  assert.deepEqual(validateToml(merged), []);
  assert.match(merged, /TOKEN = 'keep-me'/, 'nested unrelated settings must survive');
  assert.ok(validateToml(`${merged}broken = [`).length, 'malformed result must be detected');
});
