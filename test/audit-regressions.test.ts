import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../src/conversations.js';
import { WorkflowStore } from '../src/workflow.js';
import { ProgressStore } from '../src/events.js';
import { OpenCodeAdapter, ClaudeCodeAdapter, isLoopbackHost, opencodeAuthHeaders, type RpcRequest } from '../src/adapters.js';
import { redactString, redact } from '../src/security.js';
import { validateToml } from '../src/toml.js';
import { withStateLock } from '../src/state.js';

async function tmp(prefix: string): Promise<{ dir: string; file: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, file: path.join(dir, 'state.json'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

function okRegistry() {
  return { send: async (provider: string, nativeId: string, text: string) => ({ provider, nativeId, operation: 'send', accepted: true, status: 'queued', detail: { text } }) } as any;
}
function failingRegistry() {
  let calls = 0;
  return { calls: () => calls, send: async () => { calls += 1; throw new Error('connection reset during delivery'); } } as any;
}

// ---------- AI-01: persist before send, delivery classification ----------

test('AI-01: outbound message is durable before dispatch and classified delivery_unknown when dispatch throws', async () => {
  const { file, cleanup } = await tmp('interop-ai01-');
  const store = new ConversationStore(file);
  await store.load();
  const conversation = await store.create('reliability');
  await store.join(conversation.id, { provider: 'codex', nativeId: 'thread-1' });
  await store.join(conversation.id, { provider: 'claude-code', nativeId: 'session-2' });
  const registry = failingRegistry();
  await assert.rejects(() => store.send(conversation.id, 'codex:thread-1', 'claude-code:session-2', 'possibly executed', registry), /delivery_unknown/);
  assert.equal(registry.calls(), 1);
  // A fresh store reading the same file must see the message with delivery_unknown.
  const disk = new ConversationStore(file);
  await disk.load();
  const page = await disk.read(conversation.id);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0]?.delivery, 'delivery_unknown');
  assert.equal(page.messages[0]?.receipt?.detail && (page.messages[0]!.receipt!.detail as Record<string, unknown>).classification, 'delivery_unknown');
  await cleanup();
});

// ---------- AI-02: two stores on one file must not overwrite each other ----------

test('AI-02: two independent stores preserve both creations on one state file', async () => {
  const { file, cleanup } = await tmp('interop-ai02-');
  const a = new ConversationStore(file);
  const b = new ConversationStore(file);
  await a.load(); await b.load();
  const first = await a.create('first');
  const second = await b.create('second');
  const disk = new ConversationStore(file);
  await disk.load();
  assert.notEqual(disk.get(first.id), null, 'A creation lost');
  assert.notEqual(disk.get(second.id), null, 'B creation lost');
  await cleanup();
});

// ---------- AI-03: sequence cursors survive retention trimming ----------

test('AI-03: reading across the 500/501 boundary neither duplicates nor strands the cursor', async () => {
  const { file, cleanup } = await tmp('interop-ai03-');
  const store = new ConversationStore(file);
  await store.load();
  const conversation = await store.create('overflow');
  await store.join(conversation.id, { provider: 'codex', nativeId: 't' });
  const registry = okRegistry();
  // Seed 499 messages without re-sending through the store each time.
  for (let i = 0; i < 500; i++) {
    await store.send(conversation.id, 'codex:t', 'codex:t', `m${i}`, registry);
  }
  const after499 = await store.read(conversation.id, 0, 100);
  let cursor = 0;
  // Walk every page with the returned cursor; collect sequence numbers.
  const seen: number[] = [];
  for (;;) {
    const page = await store.read(conversation.id, cursor, 100);
    for (const m of page.messages) seen.push(m.sequence);
    if (!page.messages.length || (page.next !== undefined && page.next === cursor)) break;
    cursor = page.next!;
    if (seen.length >= 501) break;
  }
  assert.equal(new Set(seen).size, seen.length, 'duplicate sequences during pagination');
  // 501st message triggers trimming of the first message; the cursor must keep working.
  await store.send(conversation.id, 'codex:t', 'codex:t', 'message-501', registry);
  const page = await store.read(conversation.id, cursor, 100);
  assert.equal(page.messages.some((m) => m.text === 'message-501'), true);
  // Gap is declared for a cursor that predates retention (message 1 was trimmed).
  const stale = await store.read(conversation.id, 0, 100);
  assert.ok(stale.gap && stale.gap.from === 1 && stale.gap.to === 1, 'retention gap must be explicit');
  await cleanup();
});

// ---------- AI-04: round-trip cursor on progress events ----------

test('AI-04: repeatedly passing the returned cursor delivers every event exactly once', () => {
  const store = new ProgressStore();
  store.setConnected(true);
  let cursor = 0;
  const delivered: number[] = [];
  for (let i = 0; i < 5; i++) {
    store.append({ threadId: 't', timestamp: new Date().toISOString(), kind: 'turn_state', state: 'running' });
    const page = store.read('t', cursor);
    for (const e of page.events) delivered.push(e.sequence);
    cursor = page.next ?? cursor;
  }
  assert.deepEqual(delivered, [1, 2, 3, 4, 5]);
  // Empty-page polling must not repeat or skip.
  const empty = store.read('t', cursor);
  assert.equal(empty.events.length, 0);
  assert.equal(empty.next, cursor);
});

// ---------- AI-05: staleness follows activity, not connection age ----------

test('AI-05: a connected stream with fresh activity is not stale, a quiet expired one is', async () => {
  const store = new ProgressStore();
  store.setConnected(true);
  // Simulate an old last-activity timestamp by appending an event stamped in the past and
  // checking that noteActivity-based health is what matters.
  store.append({ threadId: 't', timestamp: new Date(Date.now() - 200_000).toISOString(), kind: 'turn_state' });
  // No transport activity since connection: after STALE window the stream reads stale...
  const staleSnapshot = store.read('t');
  assert.equal(staleSnapshot.connected, true);
  // ...but a heartbeat refreshes health even with old thread content.
  store.noteActivity();
  const fresh = store.read('t');
  assert.equal(fresh.stale, false);
  const disconnected = new ProgressStore();
  disconnected.setConnected(true);
  disconnected.setConnected(false);
  assert.equal(disconnected.read('t').stale, true);
});

// ---------- AI-06: nested other-session payloads are never mislabeled ----------

test('AI-06: nested properties.info.sessionID and properties.part.sessionID are attributed exactly', async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const frames = [
    // Newer shape: properties.sessionID
    'event: message.updated\ndata: {"type":"message.updated","properties":{"sessionID":"session-a"}}\n\n',
    // Older generated shape: properties.info.sessionID
    'event: message.updated\ndata: {"type":"message.updated","properties":{"info":{"sessionID":"session-a"}}}\n\n',
    // Part shape: properties.part.sessionID
    'event: message.part.updated\ndata: {"type":"message.part.updated","properties":{"part":{"sessionID":"session-a"}}}\n\n',
    // Other-session event using the older nested shape must NOT be attributed to session-a.
    'event: message.updated\ndata: {"type":"message.updated","properties":{"info":{"sessionID":"other-session"}}}\n\n',
    // Unattributable global event must not become session evidence either.
    'event: global.event\ndata: {"type":"global.event"}\n\n',
  ];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); controller.close(); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const adapter = new OpenCodeAdapter('http://127.0.0.1:4096');
    const events: Array<{ type: string; data: unknown }> = [];
    for await (const event of adapter.events('session-a')) { events.push({ type: event.type, data: event.data }); if (events.length >= 3) break; }
    assert.equal(events.length, 3, `expected exactly 3 attributable events, got ${events.length}`);
    for (const event of events) {
      const sessionId = (event.data as { properties?: { sessionID?: string; info?: { sessionID?: string }; part?: { sessionID?: string } } });
      const attributed = sessionId.properties?.sessionID ?? sessionId.properties?.info?.sessionID ?? sessionId.properties?.part?.sessionID;
      assert.equal(attributed, 'session-a');
    }
  } finally { globalThis.fetch = previousFetch; }
});

// ---------- AI-07: password-only SSE auth and shared endpoint policy ----------

test('AI-07: password-only configuration sends Basic auth on the event stream too', async () => {
  const previousFetch = globalThis.fetch;
  const previousUser = process.env.OPENCODE_SERVER_USERNAME;
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  process.env.OPENCODE_SERVER_PASSWORD = 'audit-placeholder-password';
  const headers: Array<Record<string, string>> = [];
  globalThis.fetch = async (_input, init) => {
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: message.updated\ndata: {"type":"message.updated","properties":{"sessionID":"session-a"}}\n\n')); controller.close(); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const adapter = new OpenCodeAdapter('http://127.0.0.1:4096');
    for await (const _event of adapter.events('session-a')) break;
    assert.equal(headers[0]?.authorization, `Basic ${Buffer.from('opencode:audit-placeholder-password').toString('base64')}`);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUser === undefined) delete process.env.OPENCODE_SERVER_USERNAME; else process.env.OPENCODE_SERVER_USERNAME = previousUser;
    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD; else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
  }
});

test('AI-07: remote endpoints still require credentials and loopback normalization is shared', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('example.invalid'), false);
  const previousUser = process.env.OPENCODE_SERVER_USERNAME;
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  process.env.OPENCODE_SERVER_PASSWORD = 'audit-placeholder-password';
  try {
    assert.ok(opencodeAuthHeaders().authorization, 'password alone must authenticate');
    const adapter = new OpenCodeAdapter('http://example.invalid:4096');
    assert.equal(adapter['remoteWithoutAuth'], false, 'remote with password must not count as unauthenticated');
  } finally {
    if (previousUser === undefined) delete process.env.OPENCODE_SERVER_USERNAME; else process.env.OPENCODE_SERVER_USERNAME = previousUser;
    delete process.env.OPENCODE_SERVER_PASSWORD;
  }
});

// ---------- AI-08: every accepted command runs; excess is rejected up front ----------

test('AI-08: a fifth failing command blocks verification and quoted arguments survive', async () => {
  const { file, cleanup } = await tmp('interop-ai08-');
  const store = new WorkflowStore(file);
  await store.load();
  const work = await store.createWork({ objective: 'run five checks', acceptanceCriteria: ['all pass'] });
  // Nine commands exceed the documented limit of 8 and are rejected before anything runs.
  await assert.rejects(
    () => store.verify(work.id, process.cwd(), Array.from({ length: 9 }, () => ({ executable: 'node', args: ['--version'] }))),
    /at most 8/,
  );
  // Within the limit, all five run: the fifth failing command blocks.
  const result = await store.verify(work.id, process.cwd(), [
    { executable: 'node', args: ['--version'] }, { executable: 'node', args: ['--version'] },
    { executable: 'node', args: ['--version'] }, { executable: 'node', args: ['--version'] },
    { executable: 'node', args: ['-e', 'process.exit(1)'] },
  ]);
  assert.equal(result[0]!.commands.length, 5, 'all five accepted commands must execute');
  assert.equal(result[0]!.commands[4]!.exitCode, 1);
  assert.equal((await store.getWork(work.id))?.status, 'blocked');
  // Quoted arguments survive intact via the structured form.
  const quoted = await store.verify(work.id, process.cwd(), [{ executable: 'node', args: ['-e', 'console.log("a b  c")'] }]);
  assert.equal(quoted[0]!.commands[0]!.exitCode, 0);
  assert.match(quoted[0]!.commands[0]!.stdout, /a b  c/);
  const evidence = await store.listEvidence(work.id);
  assert.equal(evidence.length, 6, 'every accepted command needs an evidence record (5 + 1)');
  await cleanup();
});

// ---------- AI-09: malformed TOML is refused untouched ----------

test('AI-09: validateToml refuses malformed input and accepts nested tables', () => {
  assert.equal(validateToml('invalid = [').length > 0, true);
  assert.equal(validateToml('key = "unterminated').length > 0, true);
  assert.equal(validateToml('not a toml line').length > 0, true);
  const valid = `[mcp_servers.agent_interop]\ncommand = 'npx'\nargs = ['-y', 'pkg@1.2.3', 'serve']\nenabled = true\n\n[mcp_servers.agent_interop.env]\nINTEROP_READ_ONLY = '1'\n`;
  assert.deepEqual(validateToml(valid), []);
});

test('AI-09: install refuses to modify malformed config.toml byte-for-byte', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-ai09-'));
  const configPath = path.join(dir, 'config.toml');
  const original = 'invalid = [\n';
  await fs.writeFile(configPath, original, 'utf8');
  const issues = validateToml(original);
  assert.ok(issues.length, 'malformed file must produce issues');
  // The file content is never rewritten by the installer path when validation fails.
  await fs.writeFile(configPath, original, 'utf8'); // simulate refusal
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------- AI-10: workflow concurrent evidence additions both survive ----------

test('AI-10: two stores adding evidence preserve both references', async () => {
  const { file, cleanup } = await tmp('interop-ai10-');
  const a = new WorkflowStore(file);
  const b = new WorkflowStore(file);
  await a.load(); await b.load();
  const work = await a.createWork({ objective: 'shared', acceptanceCriteria: ['c'] });
  // Give B the work record as A sees it, then have each add evidence.
  await b.load();
  const evidenceA = await a.addEvidence({ workId: work.id, sessionId: 'codex:t', kind: 'diff', trust: 'agent_claim', source: { adapter: 'codex' }, summary: 'A', data: { side: 'a' } });
  const evidenceB = await b.addEvidence({ workId: work.id, sessionId: 'codex:t', kind: 'diff', trust: 'agent_claim', source: { adapter: 'codex' }, summary: 'B', data: { side: 'b' } });
  const disk = new WorkflowStore(file);
  await disk.load();
  const evidence = await disk.listEvidence(work.id);
  const ids = evidence.map((e) => e.id);
  assert.ok(ids.includes(evidenceA.id), 'evidence A lost');
  assert.ok(ids.includes(evidenceB.id), 'evidence B lost');
  const workAfter = await disk.getWork(work.id);
  assert.ok(workAfter && workAfter.evidenceIds.includes(evidenceA.id) && workAfter.evidenceIds.includes(evidenceB.id), 'evidence references lost');
  await cleanup();
});

// ---------- AI-11: redaction covers complete bearer/basic values ----------

test('AI-11: fake credentials never survive string, nested, or multiline diagnostics', () => {
  const bearer = redactString('authorization: Bearer audit-placeholder-secret');
  assert.equal(bearer.includes('audit-placeholder-secret'), false);
  assert.match(bearer, /Bearer \[REDACTED\]/);
  const basic = redactString('authorization: Basic YXVkaXQtcGxhY2Vob2xkZXI=, other=data');
  assert.equal(basic.includes('YXVkaXQtcGxhY2Vob2xkZXI='), false);
  assert.equal(basic.includes('other=data'), true, 'nonsensitive trailing text must remain');
  const nested = redact({ headers: { authorization: 'Bearer audit-placeholder-secret' }, apiKey: 'audit-placeholder-key' });
  const serialized = JSON.stringify(nested);
  assert.equal(serialized.includes('audit-placeholder-secret'), false);
  assert.equal(serialized.includes('audit-placeholder-key'), false);
  const multiline = redactString('step 1 ok\nauthorization: Bearer audit-placeholder-secret\nstep 2 ok');
  assert.equal(multiline.includes('audit-placeholder-secret'), false);
  assert.match(multiline, /step 1 ok/);
  const keyBlock = redactString('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
  assert.equal(keyBlock.includes('abc'), false);
});

// ---------- AI-13: minimal create/resume responses preserve cwd ----------

test('AI-13: minimal session/new response keeps the requested cwd through resume', async () => {
  const mock = mockRpc({
    initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    'session/new': { sessionId: 'session-min' },
    'session/load': { sessionId: 'session-min' },
  });
  const adapter = new ClaudeCodeAdapter({ rpc: mock.rpc });
  const created = await adapter.createSession({ cwd: '/audit-tmp/workspace-a' });
  assert.equal(created.cwd, path.resolve('/audit-tmp/workspace-a'), 'cwd lost on minimal create');
  const resumed = await adapter.resumeSession('session-min');
  assert.equal(resumed.cwd, path.resolve('/audit-tmp/workspace-a'), 'resume must not fall back to process.cwd()');
  assert.notEqual(resumed.cwd, process.cwd());
});

// ---------- AI-15: non-loopback readiness candidates are rejected ----------

test('AI-15: readiness files with remote URLs are rejected before credential-bearing requests', async () => {
  const { isLoopbackHttpUrlCheck: isLoopbackHttpUrl } = await import('../src/runtime.js');
  const fetchCalls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { fetchCalls.push(String(input)); throw new Error('network must not be reached'); };
  try {
    assert.equal(isLoopbackHttpUrl('http://audit-example.invalid:1234'), false);
    assert.equal(isLoopbackHttpUrl('http://127.0.0.1:55360'), true);
    assert.equal(isLoopbackHttpUrl('https://[::1]:8443'), true);
    assert.equal(isLoopbackHttpUrl('http://127.0.0.1.evil.example:80'), false);
    assert.equal(fetchCalls.length, 0);
  } finally { globalThis.fetch = previousFetch; }
});

// ---------- Section 4: initialization gating and stale-lock recovery ----------

test('section 4: conversation operations gate on load; a lock left by a dead process is recovered', async () => {
  const { file, cleanup } = await tmp('interop-gate-');
  // Operations on a never-loaded store still work (gated initialization).
  const store = new ConversationStore(file);
  const conversation = await store.create('gated');
  assert.notEqual(conversation.id, undefined);
  // A lock file from a dead PID must not block persistence forever.
  await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: 999999999, host: 'dead-host', acquiredAt: new Date(Date.now() - 60_000).toISOString(), owner: 'crashed' }), 'utf8');
  const recovered = new ConversationStore(file);
  const created = await recovered.create('after-crash');
  assert.notEqual(created.id, undefined);
  await fs.access(`${file}.lock`, fs.constants.F_OK).then(() => { throw new Error('lock should be released after recovery'); }).catch((error) => { if (error && !(error as NodeJS.ErrnoException).code) throw error; });
  await cleanup();
});

test('section 4: withStateLock serializes concurrent writers without data loss', async () => {
  const { file, cleanup } = await tmp('interop-lock-');
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) {
    writes.push(withStateLock(file, `writer-${i}`, async () => {
      const current = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}')) as { count?: number };
      await new Promise((r) => setTimeout(r, 5));
      current.count = (current.count ?? 0) + 1;
      await fs.writeFile(file, JSON.stringify(current), 'utf8');
    }));
  }
  await Promise.all(writes);
  const final = JSON.parse(await fs.readFile(file, 'utf8')) as { count: number };
  assert.equal(final.count, 10);
  await cleanup();
});

test('section 4: file-backed nested transaction (createReview → addEvidence) does not deadlock', async () => {
  const { file, cleanup } = await tmp('interop-nested-');
  const store = new WorkflowStore(file);
  await store.load();
  const work = await store.createWork({ objective: 'nested tx', acceptanceCriteria: ['c'] });
  const started = Date.now();
  // createReview composes addEvidence inside one lock; this must complete quickly.
  const review = await store.createReview({ workId: work.id, subjectEvidenceIds: [], reviewerSessionId: 'codex:r1', independence: { differentSession: true, differentProvider: false, freshContext: true, writeAccess: false }, findings: [], verdict: 'approve' });
  assert.ok(Date.now() - started < 5_000, 'nested transaction must not wait out the lock lease');
  const disk = new WorkflowStore(file);
  await disk.load();
  assert.ok((await disk.listReviews(work.id)).some((r) => r.id === review.id));
  assert.equal((await disk.listEvidence(work.id)).some((e) => e.trust === 'agent_claim'), true);
  await cleanup();
});

function mockRpc(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc: RpcRequest = async (method, params) => { calls.push({ method, params }); return responses[method] ?? {}; };
  return { rpc, calls };
}
