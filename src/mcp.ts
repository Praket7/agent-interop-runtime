import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { detectRuntime, Runtime } from './runtime.js';
import { OpenCodeAdapter, CodexAdapter, ClaudeCodeAdapter, CursorAdapter } from './adapters.js';
import { FreebuffAdapter } from './freebuff-adapter.js';
import { InteropRegistry } from './interop-runtime.js';
import type { ProviderId } from './interop.js';
import type { Json } from './types.js';
import { WorkflowStore } from './workflow.js';
import { repositoryDiff } from './verification.js';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from './version.js';
import { ConversationStore } from './conversations.js';
import { profileToolset, activeProfile, profileDescription, type ProfileId } from './profiles.js';
const providers = z.enum(['freebuff','opencode','codex','claude-code','cursor']);
// Compact union schema: strings keep the legacy form; objects preserve quoted arguments.
const verificationCommand = z.union([z.string().min(1), z.object({ executable: z.string().min(1), args: z.array(z.string()).optional(), cwd: z.string().optional(), label: z.string().optional() })]);
const modelSelection = z.union([z.string().min(1), z.object({providerID:z.string().min(1),modelID:z.string().min(1),variant:z.string().min(1).optional()})]);

export function createInteropRegistry(runtime: Runtime): InteropRegistry { return new InteropRegistry().register(new FreebuffAdapter(runtime)).register(new OpenCodeAdapter()).register(new CodexAdapter()).register(new ClaudeCodeAdapter()).register(new CursorAdapter()); }
export function createServer(runtime: Runtime, includeWrites = true, profile: ProfileId = activeProfile()): McpServer { const s=new McpServer({name:'agent-interop-runtime',version:VERSION}); const interop=createInteropRegistry(runtime);
  // Section 4 gap: dispose the registry (and its native child processes) with the server.
  const originalClose = s.close.bind(s); s.close = async () => { try { interop.dispose(); } finally { await originalClose(); } };  const workflow=new WorkflowStore(process.env.INTEROP_STATE_FILE ?? path.join(os.homedir(), '.agent-interop-runtime', 'state.json')); const conversations=new ConversationStore(process.env.INTEROP_CONVERSATIONS_FILE ?? path.join(os.homedir(), '.agent-interop-runtime', 'conversations.json')); const ready=Promise.all([workflow.load(), conversations.load()]);
  // Second readiness review blocker 3: crash recovery is part of the runtime workflow, not
  // an unused store method. After initialization, queued outbound records from a previous
  // crash are reclassified as delivery_unknown (never resent); their receipt transactions
  // still close normally if the dispatch is actually still in flight in another process.
  ready.then(() => conversations.reconcileInterruptedSends()).catch(() => undefined); // recovery must never block serving
  const withWorkflow = <T>(fn: () => Promise<T>) => ready.then(fn);
  // Profile gate (audit backlog item 5): profiles trim only the write surface; read tools
  // stay available in every profile. The default profile registers every write tool, so
  // existing clients see no change. Read-only mode still strips mutation tools on top.
  const enabledFor = (name: string) => {
    if (!profileToolset('full').has(name)) return true; // read tools: never profile-gated
    return includeWrites && profileToolset(profile).has(name);
  };
  const read=(name:string,description:string,schema:Record<string,z.ZodType>,fn:(a:any)=>Promise<unknown>)=>{ if (!enabledFor(name)) return; s.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:true,openWorldHint:false}},async(a)=>({content:[{type:'text',text:JSON.stringify(await fn(a),null,2)}]})); };
  read('freebuff_status','Detect Freebuff and bridge capabilities.',{},()=>runtime.capabilities().then((caps)=>({ ...caps, toolsetProfile: profile, toolsetProfileDescription: profileDescription(profile) })));
  read('list_projects','List discovered Freebuff projects.',{},()=>runtime.listProjects());
  read('list_threads','List Freebuff Desktop threads.',{projectId:z.string().optional()},(a)=>runtime.listThreads(a.projectId));
  read('get_thread','Read thread metadata.',{threadId:z.string()},(a)=>runtime.getThread(a.threadId));
  read('get_thread_messages','Read visible messages for a thread.',{threadId:z.string()},(a)=>runtime.getMessages(a.threadId));
  read('get_active_work','Read visible active work.',{threadId:z.string().optional()},(a)=>runtime.activeWork(a.threadId));
  read('get_thread_progress','Read live Desktop progress events for a thread. Results are bounded and read-only.',{threadId:z.string(),afterSequence:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()},(a)=>runtime.getThreadProgress(a.threadId,a.afterSequence,a.limit));
  read('watch_thread','Wait up to 30 seconds for live progress events, then return the bounded read-only snapshot.',{threadId:z.string(),afterSequence:z.number().int().nonnegative().optional(),timeoutMs:z.number().int().min(0).max(30000).optional(),limit:z.number().int().min(1).max(100).optional()},(a)=>runtime.watchThread(a.threadId,a.afterSequence,a.timeoutMs,a.limit));
  read('get_thread_progress_summary','Return a simple user-facing live progress summary without raw event details.',{threadId:z.string()},(a)=>runtime.getThreadProgressSummary(a.threadId));
  read('watch_active_threads','Return the latest live progress summary for each active Desktop thread.',{},()=>runtime.watchActiveThreads());
  read('list_project_files','List safe project files.',{projectId:z.string(),relative:z.string().optional()},(a)=>runtime.listFiles(a.projectId,a.relative));
  read('read_project_file','Read one safe project file.',{projectId:z.string(),path:z.string()},(a)=>runtime.readFile(a.projectId,a.path));
  read('list_models','List models exposed by the installed bridge.',{},()=>runtime.listModels());
  read('list_agents','List provider adapters and their real capability grades.',{},()=>interop.capabilities());
  read('list_agent_sessions','Discover native sessions across configured providers. Provider failures are returned separately from an empty session list.',{provider:providers.optional()},async(a)=>({sessions:await interop.listSessions(a.provider as ProviderId|undefined),providerErrors:interop.getSessionErrors()}));
  read('get_work_graph','Return the provider independent session and evidence graph, including any durable state recovery warning.',{},()=>withWorkflow(async()=>({...(await workflow.graph(await interop.listSessions())),stateRecoveryRequired:workflow.recoveryStatus()})));
  read('get_agent_diff','Read native diff evidence while preserving provider identity.',{provider:providers,nativeId:z.string()},(a)=>interop.diff(a.provider as ProviderId,a.nativeId));
  read('events_read','Read bounded native events from one shared per-session stream. Count- and deadline-bounded; pass the last event sequence back as afterSequence for exactly-once continuation.',{provider:providers,nativeId:z.string(),afterSequence:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional(),timeoutMs:z.number().int().min(0).max(30000).optional()},(a)=>interop.readEvents(a.provider as ProviderId,a.nativeId,a.limit ?? 50,a.timeoutMs ?? 5_000,a.afterSequence ?? 0));
  read('evidence_list','List evidence captured by the runtime. Metadata only: contents are addressable by evidence ID.',{workId:z.string().optional()},(a)=>withWorkflow(()=>workflow.listEvidenceSummaries(a.workId)));
  read('work_list','List durable work records with objective previews and criteria counts.',{},()=>withWorkflow(()=>workflow.listWorks()));
  read('work_get','Read a durable work record and its evidence.',{workId:z.string()},(a)=>withWorkflow(async()=>({work:await workflow.getWork(a.workId),evidence:await workflow.listEvidence(a.workId),handoffs:await workflow.listHandoffs(a.workId),reviews:await workflow.listReviews(a.workId)})));
  read('handoff_packet','Read the bounded delivery packet for a handoff: fields kept within the token budget plus explicit omissions and how to request them.',{handoffId:z.string()},(a)=>withWorkflow(()=>workflow.handoffPacket(a.handoffId)));
  read('conversation_list','List shared conversations; metadata only unless detail:true.',{detail:z.boolean().optional()},async(a)=>conversations.list({detail:a?.detail===true}));
  read('conversation_read','Read a cursor-paged transcript page; pass next back for exactly-once reads.',{conversationId:z.string(),after:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()},(a)=>conversations.read(a.conversationId,a.after ?? 0,a.limit ?? 100));
  read('permission_pending','List provider permission requests awaiting an explicit human decision. Never auto-approved.',{},async()=>({pending:interop.pendingPermissions()}));
  if (!includeWrites) return s;
  const write=(name:string,description:string,schema:Record<string,z.ZodType>,fn:(a:any)=>Promise<unknown>)=>{ if (!enabledFor(name)) return; s.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},async(a)=>({content:[{type:'text',text:JSON.stringify(await fn(a),null,2)}]})); };
  write('send_message','Send a text prompt to an existing Freebuff thread.',{threadId:z.string(),text:z.string().min(1).max(100000)},(a)=>runtime.sendMessage(a.threadId,a.text));
  write('stop_thread','Stop a running Freebuff turn.',{threadId:z.string()},(a)=>runtime.stop(a.threadId));
  write('resume_thread','Resume a paused Freebuff thread.',{threadId:z.string()},(a)=>runtime.resume(a.threadId));
  write('set_model','Set the model for an existing thread when supported.',{threadId:z.string(),model:z.string().min(1),harnessId:z.string().optional()},(a)=>runtime.setModel(a.threadId,a.model,a.harnessId));
  write('set_reasoning','Set the reasoning effort for an existing thread when supported.',{threadId:z.string(),effort:z.string().nullable()},(a)=>runtime.setReasoning(a.threadId,a.effort));
  write('agent_send','Send a message to a provider native session. Model, agent, and reasoning are separate controls. For OpenCode, accepted means transport queued the prompt and does not mean completion.',{provider:providers,nativeId:z.string(),text:z.string().min(1).max(100000),mode:z.enum(['send','steer']).optional(),model:z.object({providerID:z.string().min(1),modelID:z.string().min(1),variant:z.string().min(1).optional()}).optional(),agent:z.string().min(1).optional(),reasoning:z.string().min(1).optional()},(a)=>interop.send(a.provider as ProviderId,a.nativeId,a.text,a.mode ?? 'send',{model:a.model,agent:a.agent,reasoning:a.reasoning}));
  write('agent_cancel','Cancel work in a provider native session.',{provider:providers,nativeId:z.string()},(a)=>interop.cancel(a.provider as ProviderId,a.nativeId));
  write('session_create','Create a native provider session when supported.',{provider:providers,cwd:z.string().optional(),title:z.string().optional()},(a)=>interop.create(a.provider as ProviderId,{cwd:a.cwd,title:a.title}));
  write('session_resume','Resume or reattach to an exact native session.',{provider:providers,nativeId:z.string()},(a)=>interop.resume(a.provider as ProviderId,a.nativeId));
  write('permission_respond','Respond to a provider permission request when supported.',{provider:providers,nativeId:z.string(),requestId:z.string(),decision:z.string()},(a)=>interop.permission(a.provider as ProviderId,a.nativeId,a.requestId,a.decision));
  write('session_set_model','Change the model for an exact native session when supported. OpenCode accepts providerID and modelID.',{provider:providers,nativeId:z.string(),model:modelSelection},(a)=>interop.model(a.provider as ProviderId,a.nativeId,a.model));
  write('session_set_reasoning','Change reasoning effort for an exact native session when supported.',{provider:providers,nativeId:z.string(),effort:z.string()},(a)=>interop.reasoning(a.provider as ProviderId,a.nativeId,a.effort));
  write('conversation_create','Create a local shared conversation coordinator record.',{title:z.string().min(1).max(300)},(a)=>conversations.create(a.title));
  write('conversation_reconcile','Recover interrupted outbound sends after a crash: reclassify stuck queued/unknown records and close them with caller-verified provider receipts (never auto-resends).',{conversationId:z.string().optional(),observedReceipts:z.array(z.object({idempotencyKey:z.string().min(1),receipt:z.object({provider:providers,nativeId:z.string(),operation:z.string(),accepted:z.boolean(),status:z.string(),detail:z.unknown().optional()})})).optional()},(a)=>withWorkflow(()=>conversations.reconcileInterruptedSends(a.conversationId,a.observedReceipts)));
  write('conversation_join','Attach an exact native provider session to a shared conversation.',{conversationId:z.string(),provider:providers,nativeId:z.string(),workspaceId:z.string().optional(),role:z.enum(['sender','reviewer','editor']).optional()},(a)=>conversations.join(a.conversationId,{provider:a.provider as ProviderId,nativeId:a.nativeId,workspaceId:a.workspaceId,role:a.role}));
  write('conversation_send','Persist before delivery; receipt distinguishes queued/rejected/delivery_unknown. Pass idempotencyKey (e.g. workId/handoffId) to make retries safe. Replies need another explicit send.',{conversationId:z.string(),sender:z.string(),recipient:z.string(),text:z.string().min(1).max(100000),replyTo:z.string().optional(),idempotencyKey:z.string().min(1).max(200).optional(),model:z.object({providerID:z.string().min(1),modelID:z.string().min(1),variant:z.string().min(1).optional()}).optional(),reasoning:z.string().optional()},(a)=>{ if (typeof a.model === 'string') throw new Error('conversation_send requires the structured model object {providerID, modelID}; a bare string would be silently discarded'); return conversations.send(a.conversationId,a.sender,a.recipient,a.text,interop,{model:a.model,reasoning:a.reasoning},a.replyTo,a.idempotencyKey); });
  write('work_create','Create a durable work item with acceptance criteria.',{objective:z.string().min(1),acceptanceCriteria:z.array(z.string()).min(1),sourceSession:z.string().optional(),risks:z.array(z.string()).optional(),unresolvedQuestions:z.array(z.string()).optional()},(a)=>withWorkflow(()=>workflow.createWork(a)));
  write('handoff_create','Create a structured work handoff between exact native sessions. The durable record keeps every field; the response reports the delivery packet size against the token budget and any explicit omissions.',{workId:z.string(),sourceSession:z.string(),destinationSession:z.string().optional(),objective:z.string(),acceptanceCriteria:z.array(z.string()),evidenceIds:z.array(z.string()),changedFiles:z.array(z.string()),risks:z.array(z.string()),unresolvedQuestions:z.array(z.string()),authorityBoundaries:z.array(z.string())},(a)=>withWorkflow(()=>workflow.createHandoff(a)));
  write('review_create','Record a review; caller submissions are agent_claim, never provider observations.',{workId:z.string(),subjectEvidenceIds:z.array(z.string()),reviewerSessionId:z.string(),independence:z.object({differentSession:z.boolean(),differentProvider:z.boolean(),freshContext:z.boolean(),writeAccess:z.boolean()}),findings:z.array(z.object({id:z.string(),severity:z.enum(['blocking','major','minor','note']),title:z.string(),detail:z.string(),file:z.string().optional(),line:z.number().int().optional()})),verdict:z.enum(['approve','changes_requested','blocked'])},(a)=>withWorkflow(()=>workflow.createReview(a)));
  write('review_request','Send an evidence-backed review request; the repository-diff fallback requires the subject session workspace and never guesses process.cwd().',{workId:z.string(),subjectProvider:providers,subjectNativeId:z.string(),reviewerProvider:providers,reviewerNativeId:z.string(),objective:z.string(),acceptanceCriteria:z.array(z.string())},(a)=>withWorkflow(async()=>{ let diff: Json; let trust: 'provider_observed' | 'repository_verified' = 'provider_observed'; try { diff=await interop.diff(a.subjectProvider as ProviderId,a.subjectNativeId) ?? null; } catch { const sessions=await interop.listSessions(); const subject=sessions.find((s)=>s.provider===a.subjectProvider&&s.nativeId===a.subjectNativeId); if (!subject?.cwd) throw new Error(`No verified workspace is recorded for ${a.subjectProvider}:${a.subjectNativeId}; refusing the repository-diff fallback because it could review the wrong workspace`); diff=await repositoryDiff(subject.cwd) as unknown as Json; trust='repository_verified'; } const evidence=await workflow.addEvidence({workId:a.workId,sessionId:`${a.subjectProvider}:${a.subjectNativeId}`,kind:'diff',trust,source:{adapter:a.subjectProvider},summary:trust === 'provider_observed' ? 'Subject native diff for review' : 'Repository diff fallback for review (workspace verified from session discovery)',data:diff}); const handoff=await workflow.createHandoff({workId:a.workId,sourceSession:`${a.subjectProvider}:${a.subjectNativeId}`,destinationSession:`${a.reviewerProvider}:${a.reviewerNativeId}`,objective:a.objective,acceptanceCriteria:a.acceptanceCriteria,evidenceIds:[evidence.id],changedFiles:[],risks:[],unresolvedQuestions:[],authorityBoundaries:['Reviewer may report findings but may not mutate the subject session']}); const receipt=await interop.send(a.reviewerProvider as ProviderId,a.reviewerNativeId,`Review work ${a.workId}. Objective ${a.objective}. Acceptance criteria ${JSON.stringify(a.acceptanceCriteria)}. Evidence ${JSON.stringify({evidenceId:evidence.id,diff})}`); return {handoff,evidence,receipt}; }));
  write('work_verify','Run all accepted verification commands (max 8). Entries are strings or {executable,args,cwd}. Requires INTEROP_ALLOW_VERIFICATION=1.',{workId:z.string(),cwd:z.string().optional(),commands:z.array(verificationCommand).min(1).max(8)},(a)=>withWorkflow(()=>{ if (process.env.INTEROP_ALLOW_VERIFICATION !== '1') throw new Error('Verification is disabled by default; set INTEROP_ALLOW_VERIFICATION=1 only for a trusted local MCP client'); return workflow.verify(a.workId,a.cwd ?? process.cwd(),a.commands); }));
  return s; }
export async function runStdio(){const runtime=await detectRuntime();const profile=activeProfile();const server=createServer(runtime,process.env.INTEROP_READ_ONLY !== '1',profile);const cleanup=()=>runtime.dispose?.();process.once('SIGINT',cleanup);process.once('SIGTERM',cleanup);process.once('exit',cleanup);await server.connect(new StdioServerTransport());}
function isLoopback(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1'; }
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.FREEBUFF_MCP_TOKEN;
  if (!expected) return false;
  const supplied = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validOrigin(req: IncomingMessage): boolean { const origin = req.headers.origin; if (!origin) return true; const allowed = new Set((process.env.FREEBUFF_MCP_ALLOWED_ORIGINS ?? 'http://127.0.0.1,http://localhost').split(',').map((value) => value.trim()).filter(Boolean)); try { return allowed.has(new URL(origin).origin); } catch { return false; } }
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); total += value.length; if (total > 2_000_000) throw new Error('Request too large'); chunks.push(value); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}
export async function runHttp(): Promise<void> {
  const runtime = await detectRuntime();
  const profile = activeProfile();
  const host = process.env.FREEBUFF_MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.FREEBUFF_MCP_PORT ?? 8788);
  if (!isLoopback(host) && process.env.FREEBUFF_MCP_ALLOW_REMOTE !== '1') throw new Error('Refusing non-loopback HTTP host; set FREEBUFF_MCP_ALLOW_REMOTE=1 only behind trusted HTTPS and authentication.');
  const sessions = new Map<string, { mcp: McpServer; transport: StreamableHTTPServerTransport; lastSeen: number }>();
  const requestCounts = new Map<string, { started: number; count: number }>();
  const cleanupSessions = setInterval(() => { const cutoff = Date.now() - 30 * 60_000; for (const [id, session] of sessions) if (session.lastSeen < cutoff) { void session.transport.close(); void session.mcp.close(); sessions.delete(id); } }, 60_000); cleanupSessions.unref?.();
  const server = createHttpServer(async (req, res) => {
    if (!validOrigin(req)) { res.writeHead(403, {'content-type':'application/json'}); res.end(JSON.stringify({error:'invalid_origin'})); return; }
    const address = req.socket.remoteAddress ?? 'unknown'; const bucket = requestCounts.get(address) ?? { started: Date.now(), count: 0 }; if (Date.now() - bucket.started > 60_000) { bucket.started = Date.now(); bucket.count = 0; } if (++bucket.count > 300) { requestCounts.set(address, bucket); res.writeHead(429, {'content-type':'application/json','retry-after':'60'}); res.end(JSON.stringify({error:'rate_limited'})); return; } requestCounts.set(address, bucket);
    if (req.url === '/healthz' && req.method === 'GET') { if (!isLoopback(host) && !authorized(req)) { res.writeHead(401, {'www-authenticate':'Bearer'}); res.end(JSON.stringify({error:'unauthorized'})); return; } res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true,readOnly:process.env.INTEROP_READ_ONLY === '1'})); return; }
    if (req.url !== '/mcp' || !['POST', 'DELETE'].includes(req.method ?? '')) { res.writeHead(req.url === '/mcp' ? 405 : 404, {'content-type':'application/json'}); res.end(JSON.stringify({error:req.url === '/mcp' ? 'method_not_allowed' : 'not_found'})); return; }
    if (!authorized(req)) { res.writeHead(401, {'www-authenticate':'Bearer'}); res.end(JSON.stringify({error:'unauthorized'})); return; }
    try {
      const sessionId = req.headers['mcp-session-id'];
      let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (req.method === 'DELETE') { if (!session) { res.writeHead(404, {'content-type':'application/json'}); res.end(JSON.stringify({error:'unknown_session'})); return; } await session.transport.handleRequest(req, res); sessions.delete(sessionId as string); await session.transport.close(); await session.mcp.close(); return; }
      const parsed = await body(req);
      if (!session) {
        if (typeof sessionId === 'string' || !parsed || typeof parsed !== 'object' || (parsed as { method?: string }).method !== 'initialize') { res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error:'mcp_session_required'})); return; }
        const mcp = createServer(runtime,process.env.INTEROP_READ_ONLY !== '1',profile);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessionclosed: (closedId) => { sessions.delete(closedId); } });
        await mcp.connect(transport);
        session = { mcp, transport, lastSeen: Date.now() };
        await transport.handleRequest(req, res, parsed);
        if (transport.sessionId) sessions.set(transport.sessionId, session);
        return;
      }
      session.lastSeen = Date.now(); await session.transport.handleRequest(req, res, parsed);
    } catch (error) {
      if (!res.headersSent) { res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error: error instanceof Error ? error.message : 'invalid_request'})); }
    }
  });
  const cleanup=()=>{ clearInterval(cleanupSessions); runtime.dispose?.(); for (const session of sessions.values()) { void session.transport.close(); void session.mcp.close(); } sessions.clear(); }; server.once('close',cleanup); process.once('SIGINT',()=>{cleanup();server.close()}); process.once('SIGTERM',()=>{cleanup();server.close()}); process.once('exit',cleanup);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
  console.error(`freebuff-mcp HTTP listening on http://${host}:${port}/mcp`);
}
