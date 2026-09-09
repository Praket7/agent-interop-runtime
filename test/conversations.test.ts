import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../src/conversations.js';

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
  const page = await store.read(conversation.id);
  assert.equal(page.conversation.messages[0]?.recipient, 'claude-code:session-b');
  assert.equal(page.conversation.messages[0]?.receipt?.provider, 'claude-code');
  await fs.rm(dir, { recursive: true, force: true });
});
