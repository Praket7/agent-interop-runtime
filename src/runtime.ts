import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Capabilities, ProjectSummary, ThreadDetail, ThreadSummary, Json } from './types.js';
import { assertSafeId, blocked, redact, safeProjectPath } from './security.js';

export interface Runtime {
  capabilities(): Promise<Capabilities>;
  listProjects(): Promise<ProjectSummary[]>;
  listThreads(projectId?: string): Promise<ThreadSummary[]>;
  getThread(id: string): Promise<ThreadDetail>;
  getMessages(id: string): Promise<Json>;
  activeWork(id?: string): Promise<Json>;
  listFiles(projectId: string, relative?: string): Promise<string[]>;
  readFile(projectId: string, relative: string): Promise<{ path: string; content: string }>;
  sendMessage(id: string, text: string): Promise<Json>;
  stop(id: string): Promise<Json>;
  resume(id: string): Promise<Json>;
  listModels(): Promise<Json>;
  setModel(id: string, model: string, harnessId?: string): Promise<Json>;
}

async function readJson(file: string): Promise<Json | undefined> { try { return JSON.parse(await fs.readFile(file, 'utf8')) as Json; } catch { return undefined; } }
function envRoot(): string { return process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd(); }
function candidates(): string[] { const home = os.homedir(); return [path.join(home, '.config', 'manicode', 'credentials.json'), path.join(home, 'AppData', 'Roaming', 'manicode', 'credentials.json')]; }

export class DesktopOrchestratorRuntime implements Runtime {
  private base: URL; private caps?: Capabilities;
  constructor(base = process.env.FREEBUFF_ORCHESTRATOR_URL ?? 'http://127.0.0.1:49152') { this.base = new URL(base); }
  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const c = new AbortController(); const timer = setTimeout(() => c.abort(), 5000);
    try { const r = await fetch(new URL(pathname, this.base), { method, signal: c.signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); if (!r.ok) throw new Error(`Freebuff returned HTTP ${r.status}`); return await r.json() as T; } finally { clearTimeout(timer); }
  }
  async capabilities(): Promise<Capabilities> { if (this.caps) return this.caps; try { const info = await this.request<Record<string, Json>>('GET', '/v1/info'); const endpoints = ['/v1/projects','/v1/threads','/v1/models','/v1/threads/:id','/v1/threads/:id/messages','/v1/threads/:id/message','/v1/threads/:id/stop','/v1/threads/:id/resume']; this.caps = { product:'desktop', version: typeof info.version === 'string' ? info.version : undefined, signedIn: info.signedIn === true ? true : 'unknown', orchestrator: true, readOnly: false, endpoints, notes: ['The localhost contract was detected by a safe /v1/info probe. Write capabilities are validated per request.'] }; } catch { this.caps = { product:'unknown', signedIn:'unknown', orchestrator:false, readOnly:true, endpoints:[], notes:['No Freebuff Desktop orchestrator responded on the configured localhost URL.'] }; } return this.caps; }
  async listProjects(): Promise<ProjectSummary[]> { const x = await this.request<{projects?: Array<Record<string, Json>>}>('GET','/v1/projects'); return (x.projects ?? []).map((p) => ({ id: String(p.id ?? p.path), path: String(p.path ?? ''), name: typeof p.name==='string'?p.name:undefined, metadata: redact(p) as Json })); }
  async listThreads(projectId?: string): Promise<ThreadSummary[]> { const x = await this.request<{threads?: Array<Record<string, Json>>}>('GET', projectId ? `/v1/threads?projectId=${encodeURIComponent(assertSafeId(projectId))}` : '/v1/threads'); return (x.threads ?? []).map((t) => ({ id:String(t.id), projectId:typeof t.projectId==='string'?t.projectId:undefined, title:typeof t.title==='string'?t.title:undefined, state:typeof t.turn_state==='string'?t.turn_state:typeof t.state==='string'?t.state:undefined, model:typeof t.model==='string'?t.model:undefined, metadata:redact(t) as Json })); }
  async getThread(id:string):Promise<ThreadDetail>{return redact(await this.request('GET',`/v1/threads/${encodeURIComponent(assertSafeId(id))}`)) as ThreadDetail;}
  async getMessages(id:string):Promise<Json>{return redact(await this.request('GET',`/v1/threads/${encodeURIComponent(assertSafeId(id))}/messages`)) as Json;}
  async activeWork(id?:string):Promise<Json>{return redact(await this.request('GET',id?`/v1/threads/${encodeURIComponent(assertSafeId(id))}`:'/v1/threads')) as Json;}
  async listFiles(projectId:string, relative='.') { const p=(await this.listProjects()).find(x=>x.id===projectId||x.path===projectId); if(!p) throw new Error('Project not found'); const root=await fs.realpath(p.path); const dir=relative==='.'?root:await safeProjectPath(root,relative); const entries=await fs.readdir(dir,{withFileTypes:true}); return entries.filter(e=>!blocked.test(e.name)).map(e=>path.relative(root,path.join(dir,e.name))); }
  async readFile(projectId:string, relative:string){const p=(await this.listProjects()).find(x=>x.id===projectId||x.path===projectId);if(!p)throw new Error('Project not found');const file=await safeProjectPath(p.path,relative);return {path:relative,content:await fs.readFile(file,'utf8')};}
  async sendMessage(id:string,text:string){if(!text||text.length>100000)throw new Error('Message must be 1 to 100000 characters');return redact(await this.request('POST',`/v1/threads/${encodeURIComponent(assertSafeId(id))}/message`,{text})) as Json;}
  async stop(id:string){return redact(await this.request('POST',`/v1/threads/${encodeURIComponent(assertSafeId(id))}/stop`,{})) as Json;}
  async resume(id:string){return redact(await this.request('POST',`/v1/threads/${encodeURIComponent(assertSafeId(id))}/resume`,{})) as Json;}
  async listModels(){return redact(await this.request('GET','/v1/models')) as Json;}
  async setModel(id:string,model:string,harnessId?:string){if(model.length>200)throw new Error('Invalid model');return redact(await this.request('PATCH',`/v1/threads/${encodeURIComponent(assertSafeId(id))}`,{model,harnessId})) as Json;}
}

export class ReadOnlyRuntime extends DesktopOrchestratorRuntime {
  override async sendMessage(_id: string, _text: string): Promise<Json>{throw new Error('Freebuff is unavailable or read-only');}
  override async stop(_id: string): Promise<Json>{throw new Error('Freebuff is unavailable or read-only');}
  override async resume(_id: string): Promise<Json>{throw new Error('Freebuff is unavailable or read-only');}
  override async setModel(_id: string, _model: string, _harnessId?: string): Promise<Json>{throw new Error('Freebuff is unavailable or read-only');}
}
export async function detectRuntime(): Promise<Runtime> { const r=new DesktopOrchestratorRuntime(); if((await r.capabilities()).orchestrator)return r; return new ReadOnlyRuntime(); }
export async function localInstallInfo(): Promise<Json> { const found: Array<{path:string;signedIn:boolean}> = []; for(const c of candidates()){const j=await readJson(c); const o=j&&typeof j==='object'&&!Array.isArray(j)?j as Record<string,Json>:undefined; const d=o?.default&&typeof o.default==='object'&&!Array.isArray(o.default)?o.default as Record<string,Json>:undefined; if(o) found.push({path:c,signedIn:Boolean(d?.authToken||o.authToken)});} return {cli: Boolean(await readJson(path.join(os.homedir(),'.config','manicode','freebuff'))),credentials:found}; }
