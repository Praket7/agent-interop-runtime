import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/mcp.js';

process.env.INTEROP_STATE_FILE ??= path.join(os.tmpdir(), `agent-interop-schema-${process.pid}.json`);
process.env.INTEROP_CONVERSATIONS_FILE ??= path.join(
  os.tmpdir(),
  `agent-interop-schema-conversations-${process.pid}.json`,
);

const runtime = {
  capabilities: async () => ({
    product: 'unknown',
    signedIn: 'unknown',
    orchestrator: false,
    readOnly: true,
    endpoints: [],
    notes: [],
  }),
  listProjects: async () => [],
  listThreads: async () => [],
  getThread: async () => ({}),
  getMessages: async () => [],
  activeWork: async () => [],
  getThreadProgress: async () => ({ events: [], connected: false, stale: true }),
  watchThread: async () => ({ events: [], connected: false, stale: true }),
  getThreadProgressSummary: async () => ({ events: [], connected: false, stale: true }),
  watchActiveThreads: async () => [],
  listFiles: async () => [],
  readFile: async () => ({ path: '', content: '' }),
  sendMessage: async () => ({}),
  stop: async () => ({}),
  resume: async () => ({}),
  listModels: async () => ({}),
  setModel: async () => ({}),
  setReasoning: async () => ({}),
};

function tools(profile) {
  return Object.entries(createServer(runtime, true, profile)._registeredTools);
}
function bytes(entries) {
  return entries.reduce(
    (total, tool) => total + JSON.stringify({ title: tool.title, description: tool.description }).length,
    0,
  );
}

const measured = Object.fromEntries(
  ['minimal', 'core', 'freebuff', 'legacy', 'full'].map((profile) => {
    const entries = tools(profile).map(([, tool]) => tool);
    return [profile, { tools: entries.length, descriptionBytes: bytes(entries) }];
  }),
);
const failures = [];
for (const profile of ['minimal', 'core', 'freebuff', 'legacy', 'full']) {
  const entries = tools(profile);
  const names = entries.map(([name]) => name);
  if (new Set(names).size !== names.length) failures.push(`${profile} exposes duplicate tool names`);
  for (const [name, tool] of entries) {
    if (!tool.title?.trim()) failures.push(`${profile}.${name} is missing a display title`);
    if (!tool.description?.trim()) failures.push(`${profile}.${name} is missing a description`);
    if (tool.inputSchema?.type !== 'object')
      failures.push(`${profile}.${name} must advertise an object input schema`);
    if (
      tool.outputSchemaJson?.type !== 'object' ||
      !tool.outputSchemaJson.required?.includes('result') ||
      !tool.outputSchemaJson.properties?.result
    )
      failures.push(`${profile}.${name} must advertise the structured {result: ...} output envelope`);
    const annotations = tool.annotations ?? {};
    if (typeof annotations.readOnlyHint !== 'boolean')
      failures.push(`${profile}.${name} must declare readOnlyHint`);
    if (typeof annotations.idempotentHint !== 'boolean')
      failures.push(`${profile}.${name} must declare idempotentHint`);
    if (typeof annotations.openWorldHint !== 'boolean')
      failures.push(`${profile}.${name} must declare openWorldHint`);
    if (annotations.readOnlyHint === false && typeof annotations.destructiveHint !== 'boolean')
      failures.push(`${profile}.${name} must declare destructiveHint for a write action`);
  }
}
if (measured.minimal.tools > 15)
  failures.push(`minimal profile exceeds the recommended 15-tool ceiling: ${measured.minimal.tools}`);
if (measured.core.tools > 35)
  failures.push(`core profile exceeds its 35-tool budget: ${measured.core.tools}`);
if (measured.freebuff.tools > 20)
  failures.push(`Freebuff profile exceeds its 20-tool budget: ${measured.freebuff.tools}`);
if (measured.legacy.tools !== 52)
  failures.push(`legacy profile must preserve all 52 original tools: ${measured.legacy.tools}`);
if (measured.full.tools > 52)
  failures.push(
    `modern full profile unexpectedly exceeds the 52-tool legacy surface: ${measured.full.tools}`,
  );
const modernNamePattern =
  /^(get|list|read|send|cancel|create|resume|set|stop|respond|reconcile|join|update|acquire|release|request|verify)_[a-z]+(?:_[a-z]+)*$/;
for (const profile of ['minimal', 'core', 'freebuff', 'full']) {
  for (const [name] of tools(profile)) {
    if (!modernNamePattern.test(name)) failures.push(`${profile} contains inconsistent tool name: ${name}`);
  }
}
const modernNames = new Set(tools('full').map(([name]) => name));
const legacyNames = new Set(tools('legacy').map(([name]) => name));
const knownToolNames = new Set([...modernNames, ...legacyNames]);
for (const profile of ['minimal', 'core', 'freebuff', 'legacy', 'full']) {
  const entries = tools(profile);
  const visible = new Set(entries.map(([name]) => name));
  for (const [name, tool] of entries) {
    for (const match of tool.description.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      if (knownToolNames.has(match[0]) && !visible.has(match[0]))
        failures.push(`${profile}.${name} refers to hidden tool ${match[0]}`);
    }
  }
}
const migrationGuide = fs.readFileSync(new URL('../docs/migration-1.0.md', import.meta.url), 'utf8');
const migrationRows = [...migrationGuide.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)].map((match) => [
  match[1],
  match[2],
]);
const migratedLegacyNames = new Set(migrationRows.map(([oldName]) => oldName));
if (migratedLegacyNames.size !== migrationRows.length)
  failures.push('migration guide contains duplicate legacy tool names');
if (
  migratedLegacyNames.size !== legacyNames.size ||
  [...legacyNames].some((name) => !migratedLegacyNames.has(name))
)
  failures.push('migration guide must map every legacy tool exactly once');
for (const [oldName, modernName] of migrationRows) {
  if (!modernNames.has(modernName))
    failures.push(`migration guide maps ${oldName} to unavailable modern tool ${modernName}`);
}
if (!(measured.core.descriptionBytes < measured.full.descriptionBytes * 0.85))
  failures.push('core descriptions must remain at least 15% smaller than full');
if (!(measured.minimal.descriptionBytes < measured.core.descriptionBytes * 0.7))
  failures.push('minimal descriptions must remain materially smaller than core');
console.log(JSON.stringify(measured, null, 2));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
