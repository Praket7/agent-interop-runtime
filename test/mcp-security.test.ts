import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createBackend, createServer, resolveHttpConfig, runHttp } from '../src/mcp.js';
import { CliPtyRuntime } from '../src/runtime.js';

test('HTTP configuration validates authentication, loopback binding, and port before runtime startup', () => {
  assert.throws(() => resolveHttpConfig({}), /requires AGENT_INTEROP_HTTP_TOKEN/);
  assert.throws(
    () => resolveHttpConfig({ AGENT_INTEROP_HTTP_TOKEN: 'secret', AGENT_INTEROP_HTTP_HOST: '0.0.0.0' }),
    /Refusing non-loopback/,
  );
  assert.throws(
    () => resolveHttpConfig({ AGENT_INTEROP_HTTP_ALLOW_REMOTE: '1', AGENT_INTEROP_HTTP_HOST: '0.0.0.0' }),
    /requires AGENT_INTEROP_HTTP_TOKEN/,
  );
  assert.throws(
    () => resolveHttpConfig({ AGENT_INTEROP_HTTP_TOKEN: 'secret', AGENT_INTEROP_HTTP_PORT: '65536' }),
    /integer from 0 to 65535/,
  );
  assert.deepEqual(
    resolveHttpConfig({
      AGENT_INTEROP_HTTP_TOKEN: 'secret',
      AGENT_INTEROP_HTTP_HOST: '127.0.0.2',
      AGENT_INTEROP_HTTP_PORT: '0',
    }),
    { host: '127.0.0.2', port: 0, remote: false },
  );
});

test('MCP file reads redact credential text and refuse credential files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-mcp-secret-'));
  const saved = Object.fromEntries(
    ['FREEBUFF_PROJECT_ROOT', 'INTEROP_STATE_FILE', 'INTEROP_CONVERSATIONS_FILE'].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.FREEBUFF_PROJECT_ROOT = root;
  process.env.INTEROP_STATE_FILE = path.join(root, 'state.json');
  process.env.INTEROP_CONVERSATIONS_FILE = path.join(root, 'conversations.json');
  await fs.writeFile(path.join(root, 'notes.txt'), 'release token=synthetic-mcp-secret');
  await fs.writeFile(path.join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=fake-npm-token');
  const runtime = new CliPtyRuntime();
  const backend = createBackend(runtime);
  await backend.ready;
  const server = createServer(runtime, false, 'full', backend);
  const client = new Client({ name: 'security-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: 'read_project_file',
      arguments: { projectId: root, path: 'notes.txt' },
    });
    const output = JSON.stringify(result);
    assert.deepEqual(result.structuredContent, {
      result: { path: 'notes.txt', content: 'release token=[REDACTED]' },
    });
    assert.match(output, /token=\[REDACTED\]/);
    assert.doesNotMatch(output, /synthetic-mcp-secret/);
    const credential = await client.callTool({
      name: 'read_project_file',
      arguments: { projectId: root, path: '.npmrc' },
    });
    assert.equal(credential.isError, true);
    assert.doesNotMatch(JSON.stringify(credential), /fake-npm-token/);
  } finally {
    await client.close();
    await server.close();
    backend.dispose();
    runtime.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('MCP 2026 protocol is served with the same accurate tool catalog and structured result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-mcp-modern-'));
  const saved = Object.fromEntries(
    ['INTEROP_STATE_FILE', 'INTEROP_CONVERSATIONS_FILE'].map((key) => [key, process.env[key]]),
  );
  process.env.INTEROP_STATE_FILE = path.join(root, 'state.json');
  process.env.INTEROP_CONVERSATIONS_FILE = path.join(root, 'conversations.json');
  const runtime = new CliPtyRuntime();
  const backend = createBackend(runtime);
  await backend.ready;
  const handler = createMcpHandler(() => createServer(runtime, false, 'minimal', backend), {
    legacy: 'reject',
  });
  const client = new Client(
    { name: 'interop-modern-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');
    const catalog = await client.listTools();
    assert.ok(catalog.tools.some((tool) => tool.name === 'get_runtime_status'));
    const result = await client.callTool({ name: 'get_runtime_status', arguments: {} });
    assert.equal(
      (result.structuredContent as { result: { toolsetProfile: string } }).result.toolsetProfile,
      'minimal',
    );
    assert.match(JSON.stringify(result.content), /minimal/);
  } finally {
    await client.close();
    await handler.close();
    backend.dispose();
    runtime.dispose?.();
    await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('MCP request cancellation reaches waiting runtime tools in both protocol eras', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-mcp-cancel-'));
  const saved = Object.fromEntries(
    ['INTEROP_STATE_FILE', 'INTEROP_CONVERSATIONS_FILE'].map((key) => [key, process.env[key]]),
  );
  process.env.INTEROP_STATE_FILE = path.join(root, 'state.json');
  process.env.INTEROP_CONVERSATIONS_FILE = path.join(root, 'conversations.json');
  const runtime = new CliPtyRuntime();
  const backend = createBackend(runtime);
  await backend.ready;
  try {
    for (const era of ['legacy', 'modern'] as const) {
      const client = new Client(
        { name: `interop-cancel-${era}-test`, version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : undefined,
      );
      let server: ReturnType<typeof createServer> | undefined;
      let handler: ReturnType<typeof createMcpHandler> | undefined;
      const controller = new AbortController();
      let started!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let receivedSignal: AbortSignal | undefined;
      (runtime as unknown as { watchThread: (...args: unknown[]) => Promise<unknown> }).watchThread = (
        ...args
      ) => {
        receivedSignal = args[4] as AbortSignal | undefined;
        started();
        return new Promise((resolve) => {
          const finish = () => resolve({ events: [], nextSequence: 0 });
          receivedSignal?.addEventListener('abort', finish, { once: true });
          controller.signal.addEventListener('abort', () => setTimeout(finish, 100), { once: true });
        });
      };
      let request: Promise<unknown> | undefined;
      try {
        if (era === 'modern') {
          handler = createMcpHandler(() => createServer(runtime, true, 'legacy', backend), {
            legacy: 'reject',
          });
          const transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
            fetch: (input, init) => handler!.fetch(new Request(input, init)),
          });
          await client.connect(transport);
        } else {
          server = createServer(runtime, true, 'legacy', backend);
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        }
        assert.equal(client.getProtocolEra(), era);
        request = client.callTool(
          { name: 'watch_thread', arguments: { threadId: `thread-cancel-${era}` } },
          { signal: controller.signal },
        );
        await requestStarted;
        assert.ok(receivedSignal instanceof AbortSignal);
        controller.abort();
        await assert.rejects(request);
        assert.equal(receivedSignal.aborted, true);
      } finally {
        controller.abort();
        await request?.catch(() => undefined);
        await client.close();
        await server?.close();
        await handler?.close();
      }
    }
  } finally {
    backend.dispose();
    runtime.dispose();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('HTTP serves modern requests and preserves stateful legacy sessions including GET streams', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-http-dual-era-'));
  const keys = [
    'AGENT_INTEROP_HTTP_HOST',
    'AGENT_INTEROP_HTTP_PORT',
    'AGENT_INTEROP_HTTP_TOKEN',
    'INTEROP_TOOLS_PROFILE',
    'INTEROP_READ_ONLY',
    'INTEROP_STATE_FILE',
    'INTEROP_CONVERSATIONS_FILE',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const token = 'integration-test-http-token';
  process.env.AGENT_INTEROP_HTTP_HOST = '127.0.0.1';
  process.env.AGENT_INTEROP_HTTP_PORT = '0';
  process.env.AGENT_INTEROP_HTTP_TOKEN = token;
  process.env.INTEROP_TOOLS_PROFILE = 'minimal';
  process.env.INTEROP_READ_ONLY = '1';
  process.env.INTEROP_STATE_FILE = path.join(root, 'state.json');
  process.env.INTEROP_CONVERSATIONS_FILE = path.join(root, 'conversations.json');
  let server: Awaited<ReturnType<typeof runHttp>> | undefined;
  const clients: Client[] = [];
  try {
    server = await runHttp();
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    let legacySessionId: string | null = null;
    const legacyTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        legacySessionId = response.headers.get('mcp-session-id') ?? legacySessionId;
        return response;
      },
    });
    const legacyClient = new Client({ name: 'interop-legacy-http-test', version: '1.0.0' });
    clients.push(legacyClient);
    await legacyClient.connect(legacyTransport);
    assert.equal(legacyClient.getProtocolEra(), 'legacy');
    const legacyTools = await legacyClient.listTools();
    assert.ok(legacyTools.tools.some((tool) => tool.name === 'get_runtime_status'));
    assert.ok(legacySessionId);

    const modernClient = new Client(
      { name: 'interop-modern-http-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    clients.push(modernClient);
    const modernTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await modernClient.connect(modernTransport);
    assert.equal(modernClient.getProtocolEra(), 'modern');
    const result = await modernClient.callTool({ name: 'get_runtime_status', arguments: {} });
    assert.equal(
      (result.structuredContent as { result: { toolsetProfile: string } }).result.toolsetProfile,
      'minimal',
    );

    const stream = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'mcp-session-id': legacySessionId!,
        'mcp-protocol-version': '2025-11-25',
      },
      signal: AbortSignal.timeout(3_000),
    });
    // The connected legacy client already owns this session's SSE stream, so the
    // SDK may report 409 for this second stream while still handling GET correctly.
    assert.ok(stream.status === 200 || stream.status === 409);
    await stream.body?.cancel();
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('stdio serves both negotiated protocol eras through the production entry point', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-stdio-dual-era-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    INTEROP_STATE_FILE: path.join(root, 'state.json'),
    INTEROP_CONVERSATIONS_FILE: path.join(root, 'conversations.json'),
    INTEROP_TOOLS_PROFILE: 'minimal',
    INTEROP_READ_ONLY: '1',
  });
  const cliPath = path.join(process.cwd(), 'dist', 'src', 'cli.js');
  try {
    for (const mode of ['legacy', 'modern'] as const) {
      const client = new Client(
        { name: `interop-stdio-${mode}-test`, version: '1.0.0' },
        mode === 'modern' ? { versionNegotiation: { mode: 'auto' } } : undefined,
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, 'serve'],
        env,
        cwd: process.cwd(),
        stderr: 'pipe',
      });
      try {
        await client.connect(transport);
        assert.equal(client.getProtocolEra(), mode);
        const catalog = await client.listTools();
        assert.ok(catalog.tools.some((tool) => tool.name === 'get_runtime_status'));
      } finally {
        await client.close();
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
