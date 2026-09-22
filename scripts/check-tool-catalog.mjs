import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/mcp.js';

process.env.INTEROP_STATE_FILE ??= path.join(os.tmpdir(), `agent-interop-schema-${process.pid}.json`);
process.env.INTEROP_CONVERSATIONS_FILE ??= path.join(os.tmpdir(), `agent-interop-schema-conversations-${process.pid}.json`);

const runtime = {
  capabilities: async () => ({ product: 'unknown', signedIn: 'unknown', orchestrator: false, readOnly: true, endpoints: [], notes: [] }),
  listProjects: async () => [], listThreads: async () => [], getThread: async () => ({}), getMessages: async () => [],
  activeWork: async () => [], getThreadProgress: async () => ({ events: [], connected: false, stale: true }), watchThread: async () => ({ events: [], connected: false, stale: true }),
  getThreadProgressSummary: async () => ({ events: [], connected: false, stale: true }), watchActiveThreads: async () => [],
  listFiles: async () => [], readFile: async () => ({ path: '', content: '' }),
  sendMessage: async () => ({}), stop: async () => ({}), resume: async () => ({}), listModels: async () => ({}), setModel: async () => ({}), setReasoning: async () => ({}),
};

function tools(profile) { return Object.values(createServer(runtime, true, profile)._registeredTools); }
function bytes(entries) { return entries.reduce((total, tool) => total + JSON.stringify({ title: tool.title, description: tool.description }).length, 0); }

const measured = Object.fromEntries(['minimal','core','freebuff','legacy','full'].map((profile) => { const entries = tools(profile); return [profile, { tools: entries.length, descriptionBytes: bytes(entries) }]; }));
const failures = [];
if (measured.minimal.tools > 16) failures.push(`minimal tool count regressed: ${measured.minimal.tools} > 16`);
if (measured.core.tools > 38) failures.push(`core tool count regressed: ${measured.core.tools} > 38`);
if (measured.freebuff.tools > 20) failures.push(`freebuff tool count regressed: ${measured.freebuff.tools} > 20`);
if (measured.full.tools > 55) failures.push(`full tool count unexpectedly exceeds 55: ${measured.full.tools}`);
if (!(measured.core.descriptionBytes < measured.full.descriptionBytes * 0.85)) failures.push('core descriptions must remain at least 15% smaller than full');
if (!(measured.minimal.descriptionBytes < measured.core.descriptionBytes * 0.70)) failures.push('minimal descriptions must remain materially smaller than core');
console.log(JSON.stringify(measured, null, 2));
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
