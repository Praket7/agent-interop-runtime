#!/usr/bin/env node
import { createServer, runHttp, runStdio } from './mcp.js';
import { detectRuntime, localInstallInfo } from './runtime.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createInteropRegistry } from './mcp.js';
import { WorkflowStore } from './workflow.js';
const command=process.argv[2] ?? 'serve';
async function installConfig(write: boolean): Promise<void> {
  const executable = path.resolve(process.argv[1] ?? 'freebuff-mcp');
  const config = `[mcp_servers.freebuff]\ncommand = '${process.execPath.replace(/\\/g, '\\\\')}'\nargs = ['${executable.replace(/\\/g, '\\\\')}', 'serve']\nenabled = true\n\n# Optional CLI PTY mode (use this as a separate entry when needed):\n# [mcp_servers.freebuff_cli]\n# command = '${process.execPath.replace(/\\/g, '\\\\')}'\n# args = ['${executable.replace(/\\/g, '\\\\')}', 'serve']\n# enabled = true\n# [mcp_servers.freebuff_cli.env]\n# FREEBUFF_MCP_CLI_MODE = 'pty'\n`;
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (write) { let existing = ''; try { existing = await fs.readFile(configPath, 'utf8'); } catch { /* create below */ } if (/^\[mcp_servers\.freebuff\]/m.test(existing)) throw new Error(`MCP entry already exists in ${configPath}; no changes made`); await fs.mkdir(path.dirname(configPath), { recursive:true }); await fs.appendFile(configPath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${config}`, 'utf8'); console.log(`Added Desktop-first Freebuff configuration to ${configPath}`); } else { console.log(config); console.log(`Run 'freebuff-mcp install --write' to add it to ${configPath}, then run 'freebuff-mcp doctor'.`); }
}
if(command==='install'){await installConfig(process.argv.includes('--write'));}
else if(command==='doctor'){const r=await detectRuntime();const registry=createInteropRegistry(r);console.log(JSON.stringify({capabilities:await r.capabilities(),providers:await registry.capabilities(),installation:await localInstallInfo()},null,2));r.dispose?.();}
else if(command==='agents'){const r=await detectRuntime();console.log(JSON.stringify(await createInteropRegistry(r).capabilities(),null,2));r.dispose?.();}
else if(command==='sessions'){const r=await detectRuntime();console.log(JSON.stringify(await createInteropRegistry(r).listSessions(),null,2));r.dispose?.();}
else if(command==='work'){const store=new WorkflowStore(process.env.INTEROP_STATE_FILE ?? path.join(os.homedir(), '.agent-interop-runtime', 'state.json'));await store.load();const sub=process.argv[3] ?? 'list';if(sub==='list')console.log(JSON.stringify(await store.listWorks(),null,2));else if(sub==='evidence')console.log(JSON.stringify(await store.listEvidence(process.argv[4]),null,2));else if(sub==='verify'){const workId=process.argv[4];const commands=process.argv.slice(5);if(!workId||!commands.length)throw new Error('Usage: agent-interop-runtime work verify <workId> <command> [command...]');console.log(JSON.stringify(await store.verify(workId,process.cwd(),commands),null,2));}else throw new Error('Usage: agent-interop-runtime work [list|evidence <workId>|verify <workId> <command> ...]');}
else if(command==='serve'){await runStdio();}
else if(command==='serve-http'){await runHttp();}
else if(command==='version'){console.log('0.1.0');}
else {console.error('Usage: agent-interop-runtime [serve|serve-http|doctor|agents|sessions|work|install [--write]|version]');process.exitCode=2;}
