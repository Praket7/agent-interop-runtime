// ACP wire fixture: minimal ACP v1 agent side over newline-delimited JSON-RPC on stdio.
// session/cancel is treated strictly as a notification: it is never answered with an id,
// which is the contract the audit found violated. The pending session/prompt is answered
// with stopReason 'cancelled' after a cancellation notification arrives.
import readline from 'node:readline';

const state = { promptOpen: null };

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize' && message.id !== undefined) {
    respond(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    return;
  }
  if (message.method === 'session/new' && message.id !== undefined) {
    respond(message.id, { sessionId: 'acp-fixture-session' });
    return;
  }
  if (message.method === 'session/prompt' && message.id !== undefined) {
    state.promptOpen = { id: message.id, sessionId: message.params?.sessionId ?? 'unknown' };
    return; // answered only when cancellation arrives (or never)
  }
  if (message.method === 'session/cancel') {
    // Notification: no id in the message, and we intentionally send no reply.
    if (state.promptOpen) {
      respond(state.promptOpen.id, { stopReason: 'cancelled' });
      state.promptOpen = null;
    }
    return;
  }
  if (message.id !== undefined) respond(message.id, {});
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
