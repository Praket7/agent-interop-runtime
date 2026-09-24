import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CliPtyRuntime } from '../src/runtime.js';
import { createBackend, createServer } from '../src/mcp.js';

test('MCP file reads redact credential text and refuse credential files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-mcp-secret-'));
  const saved = Object.fromEntries(['FREEBUFF_PROJECT_ROOT', 'INTEROP_STATE_FILE', 'INTEROP_CONVERSATIONS_FILE'].map((key) => [key, process.env[key]]));
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
    const result = await client.callTool({ name: 'read_project_file', arguments: { projectId: root, path: 'notes.txt' } });
    const output = JSON.stringify(result);
    assert.match(output, /token=\[REDACTED\]/);
    assert.doesNotMatch(output, /synthetic-mcp-secret/);
    const credential = await client.callTool({ name: 'read_project_file', arguments: { projectId: root, path: '.npmrc' } });
    assert.equal(credential.isError, true);
    assert.doesNotMatch(JSON.stringify(credential), /fake-npm-token/);
  } finally {
    await client.close();
    await server.close();
    backend.dispose();
    runtime.dispose();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
