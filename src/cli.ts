#!/usr/bin/env node
import { createServer, runHttp, runStdio } from './mcp.js';
import { detectRuntime, localInstallInfo } from './runtime.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createInteropRegistry } from './mcp.js';
import { WorkflowStore } from './workflow.js';
import { VERSION } from './version.js';
const command=process.argv[2] ?? 'serve';
function mergeConfig(existing: string, config: string): string {
  const lines = existing.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\[mcp_servers\.agent_interop(?:\.[^\]]+)?\]\s*$/.test(line.trim()));
  if (start < 0) return `${existing && !existing.endsWith('\n') ? `${existing}\n` : existing}${config}`;
  let end = start + 1;
  while (end < lines.length && !/^\[[^\]]+\]\s*$/.test((lines[end] ?? '').trim())) end++;
  return [...lines.slice(0, start), config.trim(), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}
async function installConfig(write: boolean): Promise<void> {
  const launcher = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const config = `[mcp_servers.agent_interop]\ncommand = '${launcher}'\nargs = ['-y', 'agent-interop-runtime@latest', 'serve']\nenabled = true\n\n# Optional safe read-only entry for analysis sessions:\n# [mcp_servers.agent_interop_readonly]\n# command = '${launcher}'\n# args = ['-y', 'agent-interop-runtime@latest', 'serve']\n# enabled = true\n# [mcp_servers.agent_interop_readonly.env]\n# INTEROP_READ_ONLY = '1'\n\n# Optional trusted local verification authorization:\n# [mcp_servers.agent_interop.env]\n# INTEROP_ALLOW_VERIFICATION = '1'\n`;
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (write) { let existing = ''; try { existing = await fs.readFile(configPath, 'utf8'); } catch { /* create below */ } await fs.mkdir(path.dirname(configPath), { recursive:true }); await fs.writeFile(configPath, mergeConfig(existing, config), 'utf8'); console.log(`Installed or repaired Agent Interop configuration in ${configPath}`); } else { console.log(config); console.log(`Run 'agent-interop-runtime install --write' to add or repair it in ${configPath}, then restart the local MCP client.`); }
}
async function installCursor(write: boolean, project: boolean, readOnly: boolean): Promise<void> {
  const launcher = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const configPath = project ? path.join(process.cwd(), '.cursor', 'mcp.json') : path.join(os.homedir(), '.cursor', 'mcp.json');
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>; } catch { /* create a new Cursor configuration */ }
  const servers = current.mcpServers && typeof current.mcpServers === 'object' && !Array.isArray(current.mcpServers) ? current.mcpServers as Record<string, unknown> : {};
  servers.agentInterop = { command: launcher, args: ['-y', 'agent-interop-runtime@latest', 'serve'], ...(readOnly ? { env: { INTEROP_READ_ONLY: '1' } } : {}) };
  const next = JSON.stringify({ ...current, mcpServers: servers }, null, 2) + '\n';
  if (write) { await fs.mkdir(path.dirname(configPath), { recursive: true }); await fs.writeFile(configPath, next, 'utf8'); console.log(`Installed Agent Interop in ${configPath}`); } else { console.log(next); console.log(`Run agent-interop-runtime cursor-setup --write to update ${configPath}`); }
}
if(command==='install'||command==='setup'){await installConfig(process.argv.includes('--write'));}
else if(command==='cursor-setup'){await installCursor(process.argv.includes('--write'), process.argv.includes('--project'), process.argv.includes('--read-only'));}
else if(command==='doctor'){const r=await detectRuntime();const registry=createInteropRegistry(r);console.log(JSON.stringify({capabilities:await r.capabilities(),providers:await registry.capabilities(),installation:await localInstallInfo()},null,2));registry.dispose();r.dispose?.();}
else if(command==='agents'){const r=await detectRuntime();const registry=createInteropRegistry(r);console.log(JSON.stringify(await registry.capabilities(),null,2));registry.dispose();r.dispose?.();}
else if(command==='sessions'){const r=await detectRuntime();const registry=createInteropRegistry(r);console.log(JSON.stringify(await registry.listSessions(),null,2));registry.dispose();r.dispose?.();}
else if(command==='work'){const store=new WorkflowStore(process.env.INTEROP_STATE_FILE ?? path.join(os.homedir(), '.agent-interop-runtime', 'state.json'));await store.load();const sub=process.argv[3] ?? 'list';if(sub==='list')console.log(JSON.stringify(await store.listWorks(),null,2));else if(sub==='evidence')console.log(JSON.stringify(await store.listEvidence(process.argv[4]),null,2));else if(sub==='verify'){const workId=process.argv[4];const commands=process.argv.slice(5);if(!workId||!commands.length)throw new Error('Usage: agent-interop-runtime work verify <workId> <command> [command...]');console.log(JSON.stringify(await store.verify(workId,process.cwd(),commands),null,2));}else throw new Error('Usage: agent-interop-runtime work [list|evidence <workId>|verify <workId> <command> ...]');}
else if(command==='serve'){await runStdio();}
else if(command==='serve-http'){await runHttp();}
else if(command==='version'){console.log(VERSION);}
else {console.error('Usage: agent-interop-runtime [serve|serve-http|doctor|agents|sessions|work|install|setup [--write]|cursor-setup [--project] [--read-only] [--write]|version]');process.exitCode=2;}
