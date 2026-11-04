import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { createMcpHandler, isLegacyRequest, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { ClaudeCodeAdapter, CodexAdapter, CursorAdapter, OpenCodeAdapter } from './adapters.js';
import { ConversationStore } from './conversations.js';
import { FreebuffAdapter } from './freebuff-adapter.js';
import type { ProviderId } from './interop.js';
import { InteropRegistry } from './interop-runtime.js';
import { isLoopbackHost } from './network.js';
import {
  activeProfile,
  exposedToolName,
  MODERN_TOOL_NAMES,
  type ProfileId,
  profileDescription,
  profileToolset,
} from './profiles.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { detectRuntime, type Runtime } from './runtime.js';
import type { Json } from './types.js';
import { repositoryDiff } from './verification.js';
import { VERSION } from './version.js';
import { WorkflowStore } from './workflow.js';

const providers = z.enum(['freebuff', 'opencode', 'codex', 'claude-code', 'cursor']);
const OPEN_WORLD_READ_TOOLS = new Set([
  'freebuff_status',
  'list_projects',
  'list_threads',
  'get_thread',
  'get_thread_messages',
  'get_active_work',
  'get_thread_progress',
  'watch_thread',
  'get_thread_progress_summary',
  'watch_active_threads',
  'list_project_files',
  'read_project_file',
  'list_models',
  'list_agents',
  'list_agent_sessions',
  'get_work_graph',
  'get_agent_diff',
  'events_read',
  'events_page',
  'permission_pending',
]);
const OPEN_WORLD_WRITE_TOOLS = new Set([
  'send_message',
  'stop_thread',
  'resume_thread',
  'set_model',
  'set_reasoning',
  'agent_send',
  'agent_cancel',
  'session_create',
  'session_resume',
  'permission_respond',
  'session_set_model',
  'session_set_reasoning',
  'conversation_send',
  'review_request',
  'work_verify',
]);
const DESTRUCTIVE_WRITE_TOOLS = new Set([
  'stop_thread',
  'resume_thread',
  'set_model',
  'set_reasoning',
  'agent_cancel',
  'session_resume',
  'permission_respond',
  'session_set_model',
  'session_set_reasoning',
  'conversation_reconcile',
  'handoff_update_status',
  'claim_release',
  'work_verify',
]);
// Compact union schema: strings keep the legacy form; objects preserve quoted arguments.
const verificationCommand = z.union([
  z.string().min(1),
  z.object({
    executable: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    label: z.string().optional(),
  }),
]);
const modelSelection = z.union([
  z.string().min(1),
  z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    variant: z.string().min(1).optional(),
  }),
]);
const toolOutputSchema = z.object({ result: z.unknown() });
type ToolShape = z.ZodRawShape;
type ToolArguments<T extends ToolShape> = z.output<z.ZodObject<T>>;
const MAX_HTTP_SESSIONS = 1_024;
const MAX_CONCURRENT_HTTP_REQUESTS = 1_024;
function toolResult(value: unknown) {
  const result = value ?? null;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: { result },
  };
}

export function createInteropRegistry(runtime: Runtime): InteropRegistry {
  return new InteropRegistry()
    .register(new FreebuffAdapter(runtime))
    .register(new OpenCodeAdapter())
    .register(new CodexAdapter())
    .register(new ClaudeCodeAdapter())
    .register(new CursorAdapter());
}

export interface InteropBackend {
  interop: InteropRegistry;
  workflow: WorkflowStore;
  conversations: ConversationStore;
  ready: Promise<unknown>;
  dispose(): void;
}

/** Process-wide coordination backend. HTTP MCP sessions share this backend so they do not
 * spawn duplicate native provider processes or maintain divergent event subscriptions. */
export function createBackend(runtime: Runtime): InteropBackend {
  const interop = createInteropRegistry(runtime);
  const workflow = new WorkflowStore(
    process.env.INTEROP_STATE_FILE ?? path.join(os.homedir(), '.agent-interop-runtime', 'state.json'),
  );
  const conversations = new ConversationStore(
    process.env.INTEROP_CONVERSATIONS_FILE ??
      path.join(os.homedir(), '.agent-interop-runtime', 'conversations.json'),
  );
  const ready = Promise.all([workflow.load(), conversations.load()]).then(async (loaded) => {
    try {
      await conversations.reconcileInterruptedSends();
    } catch {
      /* best-effort startup recovery */
    }
    return loaded;
  });
  return { interop, workflow, conversations, ready, dispose: () => interop.dispose() };
}

export function createServer(
  runtime: Runtime,
  includeWrites = true,
  profile: ProfileId = activeProfile(),
  backend?: InteropBackend,
): McpServer {
  const s = new McpServer(
    { name: 'agent-interop-runtime', version: VERSION },
    { capabilities: { tools: {} } },
  );
  const ownsBackend = !backend;
  const activeBackend = backend ?? createBackend(runtime);
  const { interop, workflow, conversations, ready } = activeBackend;
  if (ownsBackend) {
    const originalClose = s.close.bind(s);
    s.close = async () => {
      try {
        activeBackend.dispose();
      } finally {
        await originalClose();
      }
    };
  }
  const withWorkflow = <T>(fn: () => Promise<T>) => ready.then(fn);
  // Capability profiles gate the entire catalog, including reads. MCP clients commonly
  // serialize every visible tool schema into model context, so hiding irrelevant read tools
  // is as important as hiding writes. Read-only mode still strips writes independently.
  const enabledFor = (name: string) => profileToolset(profile).has(name);
  const exposedName = (name: string) => exposedToolName(profile, name);
  const titleFor = (name: string) =>
    exposedName(name)
      .split('_')
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(' ');
  const describe = (value: string) =>
    profile === 'legacy'
      ? value
      : value.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (name) => MODERN_TOOL_NAMES[name] ?? name);
  const read = <T extends ToolShape>(
    name: string,
    description: string,
    schema: T,
    fn: (a: ToolArguments<T>, signal?: AbortSignal) => Promise<unknown>,
  ) => {
    if (!enabledFor(name)) return;
    s.registerTool(
      exposedName(name),
      {
        title: titleFor(name),
        description: describe(description),
        inputSchema: z.object(schema),
        outputSchema: toolOutputSchema,
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: OPEN_WORLD_READ_TOOLS.has(name),
        },
      },
      async (a, ctx) => toolResult(await fn(a, ctx?.mcpReq.signal)),
    );
  };
  read(
    'freebuff_status',
    profile === 'freebuff'
      ? 'Report detected Freebuff Desktop and CLI capabilities and the active tool profile. Use the Freebuff project and thread tools in this profile to inspect local work.'
      : 'Report installed provider capabilities and the active tool profile. Use list_agents for per-provider capabilities and list_agent_sessions to inspect available sessions.',
    {},
    () =>
      runtime.capabilities().then((caps) => ({
        ...caps,
        toolsetProfile: profile,
        toolsetProfileDescription: profileDescription(profile),
      })),
  );
  read('list_projects', 'List discovered Freebuff projects.', {}, () => runtime.listProjects());
  read('list_threads', 'List Freebuff Desktop threads.', { projectId: z.string().optional() }, (a) =>
    runtime.listThreads(a.projectId),
  );
  read('get_thread', 'Read thread metadata.', { threadId: z.string() }, (a) => runtime.getThread(a.threadId));
  read('get_thread_messages', 'Read visible messages for a thread.', { threadId: z.string() }, (a) =>
    runtime.getMessages(a.threadId),
  );
  read('get_active_work', 'Read visible active work.', { threadId: z.string().optional() }, (a) =>
    runtime.activeWork(a.threadId),
  );
  read(
    'get_thread_progress',
    profile === 'freebuff'
      ? 'Read bounded raw progress for one Freebuff Desktop thread. Returns immediately by default; set timeoutMs to wait for activity. Use get_thread_progress_summary for a readable summary.'
      : 'Read bounded raw progress for one Freebuff Desktop thread. Returns immediately by default; set timeoutMs to wait for activity. Use get_thread_progress_summary for a readable summary, or events_page for native provider event cursors.',
    {
      threadId: z.string(),
      afterSequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      timeoutMs: z.number().int().min(0).max(30000).optional(),
    },
    (a, signal) =>
      a.timeoutMs
        ? runtime.watchThread(a.threadId, a.afterSequence, a.timeoutMs, a.limit, signal)
        : runtime.getThreadProgress(a.threadId, a.afterSequence, a.limit),
  );
  read(
    'watch_thread',
    'Legacy 0.3.x operation. New clients should call get_thread_progress and set timeoutMs when they need to wait for activity.',
    {
      threadId: z.string(),
      afterSequence: z.number().int().nonnegative().optional(),
      timeoutMs: z.number().int().min(0).max(30000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    (a, signal) => runtime.watchThread(a.threadId, a.afterSequence, a.timeoutMs, a.limit, signal),
  );
  read(
    'get_thread_progress_summary',
    'Return a readable summary without raw event details. Set threadId for one thread, or omit it to summarize all active threads. Use get_thread_progress for raw events or a cursor.',
    { threadId: z.string().optional() },
    (a) =>
      a.threadId === undefined ? runtime.watchActiveThreads() : runtime.getThreadProgressSummary(a.threadId),
  );
  read(
    'watch_active_threads',
    'Legacy 0.3.x operation. New clients should call get_thread_progress_summary without threadId to see summaries for all active threads.',
    {},
    () => runtime.watchActiveThreads(),
  );
  read(
    'list_project_files',
    'List safe project files.',
    { projectId: z.string(), relative: z.string().optional() },
    (a) => runtime.listFiles(a.projectId, a.relative),
  );
  read('read_project_file', 'Read one safe project file.', { projectId: z.string(), path: z.string() }, (a) =>
    runtime.readFile(a.projectId, a.path),
  );
  read('list_models', 'List models exposed by the installed bridge.', {}, () => runtime.listModels());
  read(
    'list_agents',
    'List configured provider adapters and their supported actions. Use list_agent_sessions to find actual native sessions; discovery does not confirm sign in or readiness.',
    {},
    () => interop.capabilities(),
  );
  read(
    'list_agent_sessions',
    'Find actual native sessions from installed providers, optionally filtered by provider. Provider errors are returned separately from an empty result. Use list_agents to inspect adapter capabilities.',
    { provider: providers.optional() },
    async (a) => ({
      sessions: await interop.listSessions(a.provider as ProviderId | undefined),
      providerErrors: interop.getSessionErrors(),
    }),
  );
  read(
    'get_work_graph',
    'Return the provider independent session and evidence graph, including any durable state recovery warning.',
    {},
    () =>
      withWorkflow(async () => ({
        ...(await workflow.graph(await interop.listSessions())),
        stateRecoveryRequired: workflow.recoveryStatus(),
      })),
  );
  read(
    'get_agent_diff',
    'Read file change evidence for one exact native provider session. Use events_page for its progress history; this tool returns file changes only.',
    { provider: providers, nativeId: z.string() },
    (a) => interop.diff(a.provider as ProviderId, a.nativeId),
  );
  read(
    'events_read',
    'Legacy array response for native provider events. New clients should use events_page, which includes a resumable cursor, stream epoch, and retention-gap metadata.',
    {
      provider: providers,
      nativeId: z.string(),
      afterSequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      timeoutMs: z.number().int().min(0).max(30000).optional(),
    },
    (a, signal) =>
      interop.readEvents(
        a.provider as ProviderId,
        a.nativeId,
        a.limit ?? 50,
        a.timeoutMs ?? 5_000,
        a.afterSequence ?? 0,
        signal,
      ),
  );
  read(
    'events_page',
    profile === 'legacy'
      ? 'Read a bounded page of native provider events with a resumable cursor, stream epoch, and retention-gap metadata. Use events_read only when a legacy array response is required.'
      : profile === 'full'
        ? 'Read a bounded page of native provider events with a resumable cursor, stream epoch, and retention-gap metadata. Use this for provider event history; get_thread_progress reads Freebuff Desktop progress instead.'
        : 'Read a bounded page of native provider events with a resumable cursor, stream epoch, and retention-gap metadata.',
    {
      provider: providers,
      nativeId: z.string(),
      afterSequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      timeoutMs: z.number().int().min(0).max(30000).optional(),
    },
    (a, signal) =>
      interop.readEventPage(
        a.provider as ProviderId,
        a.nativeId,
        a.limit ?? 50,
        a.timeoutMs ?? 5_000,
        a.afterSequence ?? 0,
        signal,
      ),
  );
  read(
    'evidence_list',
    'List evidence captured by the runtime. Metadata only: contents are addressable by evidence ID.',
    { workId: z.string().optional() },
    (a) => withWorkflow(() => workflow.listEvidenceSummaries(a.workId)),
  );
  read(
    'evidence_get',
    'Read one exact evidence record by ID. Use this after handoffs/reviews instead of inlining large diffs or logs.',
    { evidenceId: z.string().min(1) },
    (a) => withWorkflow(() => workflow.getEvidence(a.evidenceId)),
  );
  read(
    'work_list',
    'List durable work records with objective previews and criteria counts. Use work_get after you have a workId to read its evidence, handoffs, and reviews.',
    {},
    () => withWorkflow(() => workflow.listWorks()),
  );
  read(
    'work_get',
    'Read one durable work record and its evidence, handoffs, and reviews. Use work_list to find work IDs, or handoff_packet when you need only the bounded packet for delivery.',
    { workId: z.string() },
    (a) =>
      withWorkflow(async () => ({
        work: await workflow.getWork(a.workId),
        evidence: await workflow.listEvidence(a.workId),
        handoffs: await workflow.listHandoffs(a.workId),
        reviews: await workflow.listReviews(a.workId),
      })),
  );
  read(
    'handoff_packet',
    'Read the bounded delivery packet for a handoff: fields kept within the token budget plus explicit omissions and how to request them.',
    { handoffId: z.string() },
    (a) => withWorkflow(() => workflow.handoffPacket(a.handoffId)),
  );
  read(
    'conversation_list',
    'List shared conversation metadata, or include details with detail:true. Use conversation_read to fetch a transcript page for one conversation.',
    { detail: z.boolean().optional() },
    async (a) => conversations.list({ detail: a?.detail === true }),
  );
  read(
    'conversation_read',
    'Read one cursor-paged transcript page; pass the returned next cursor to continue without repeating messages. Use conversation_list to find conversation IDs.',
    {
      conversationId: z.string(),
      after: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    (a) => conversations.read(a.conversationId, a.after ?? 0, a.limit ?? 100),
  );
  read(
    'claim_list',
    'List durable resource ownership claims. Active claims are runtime-enforced coordination state, not chat suggestions.',
    { workId: z.string().optional(), activeOnly: z.boolean().optional() },
    (a) => withWorkflow(() => workflow.listClaims(a.workId, a.activeOnly ?? false)),
  );
  read(
    'permission_pending',
    'List provider permission requests awaiting an explicit human decision. Never auto-approved.',
    {},
    async () => ({ pending: interop.pendingPermissions() }),
  );
  if (!includeWrites) return s;
  const write = <T extends ToolShape>(
    name: string,
    description: string,
    schema: T,
    fn: (a: ToolArguments<T>, signal?: AbortSignal) => Promise<unknown>,
  ) => {
    if (!enabledFor(name)) return;
    const safetyNote =
      name === 'work_verify'
        ? ' Configured commands may modify or delete files; run only commands you trust in the intended workspace.'
        : '';
    s.registerTool(
      exposedName(name),
      {
        title: titleFor(name),
        description: describe(description + safetyNote),
        inputSchema: z.object(schema),
        outputSchema: toolOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: DESTRUCTIVE_WRITE_TOOLS.has(name),
          idempotentHint: false,
          openWorldHint: OPEN_WORLD_WRITE_TOOLS.has(name),
        },
      },
      async (a, ctx) => toolResult(await fn(a, ctx?.mcpReq.signal)),
    );
  };
  write(
    'send_message',
    profile === 'freebuff'
      ? 'Send a text prompt to an existing Freebuff Desktop thread.'
      : 'Send a text prompt to an existing Freebuff Desktop thread. Use agent_send for a native session from any configured provider.',
    { threadId: z.string(), text: z.string().min(1).max(100000) },
    (a) => runtime.sendMessage(a.threadId, a.text),
  );
  write('stop_thread', 'Stop a running Freebuff turn.', { threadId: z.string() }, (a) =>
    runtime.stop(a.threadId),
  );
  write('resume_thread', 'Resume a paused Freebuff thread.', { threadId: z.string() }, (a) =>
    runtime.resume(a.threadId),
  );
  write(
    'set_model',
    'Set the model for an existing thread when supported.',
    { threadId: z.string(), model: z.string().min(1), harnessId: z.string().optional() },
    (a) => runtime.setModel(a.threadId, a.model, a.harnessId),
  );
  write(
    'set_reasoning',
    'Set the reasoning effort for an existing thread when supported.',
    { threadId: z.string(), effort: z.string().nullable() },
    (a) => runtime.setReasoning(a.threadId, a.effort),
  );
  write(
    'agent_send',
    profile === 'minimal'
      ? 'Send one prompt to an exact native provider session. Model, agent, and reasoning are separate controls. For OpenCode, accepted means queued by transport and does not mean completed.'
      : profile === 'core'
        ? 'Send one prompt to an exact native provider session. Use conversation_send when you need a durable shared transcript. Model, agent, and reasoning are separate controls. For OpenCode, accepted means queued by transport and does not mean completed.'
        : 'Send one prompt to an exact native provider session. Use send_message only for a Freebuff Desktop thread, or conversation_send when you need a durable shared transcript. Model, agent, and reasoning are separate controls. For OpenCode, accepted means queued by transport and does not mean completed.',
    {
      provider: providers,
      nativeId: z.string(),
      text: z.string().min(1).max(100000),
      mode: z.enum(['send', 'steer']).optional(),
      model: z
        .object({
          providerID: z.string().min(1),
          modelID: z.string().min(1),
          variant: z.string().min(1).optional(),
        })
        .optional(),
      agent: z.string().min(1).optional(),
      reasoning: z.string().min(1).optional(),
    },
    (a) =>
      interop.send(a.provider as ProviderId, a.nativeId, a.text, a.mode ?? 'send', {
        model: a.model,
        agent: a.agent,
        reasoning: a.reasoning,
      }),
  );
  write(
    'agent_cancel',
    'Cancel work in a provider native session.',
    { provider: providers, nativeId: z.string() },
    (a) => interop.cancel(a.provider as ProviderId, a.nativeId),
  );
  write(
    'session_create',
    'Create a native provider session when supported.',
    { provider: providers, cwd: z.string().optional(), title: z.string().optional() },
    (a) => interop.create(a.provider as ProviderId, { cwd: a.cwd, title: a.title }),
  );
  write(
    'session_resume',
    'Resume or reattach to an exact native session.',
    { provider: providers, nativeId: z.string() },
    (a) => interop.resume(a.provider as ProviderId, a.nativeId),
  );
  write(
    'permission_respond',
    'Respond to a provider permission request when supported.',
    { provider: providers, nativeId: z.string(), requestId: z.string(), decision: z.string() },
    (a) => interop.permission(a.provider as ProviderId, a.nativeId, a.requestId, a.decision),
  );
  write(
    'session_set_model',
    'Change the model for an exact native session when supported. OpenCode accepts providerID and modelID.',
    { provider: providers, nativeId: z.string(), model: modelSelection },
    (a) => interop.model(a.provider as ProviderId, a.nativeId, a.model),
  );
  write(
    'session_set_reasoning',
    'Change reasoning effort for an exact native session when supported.',
    { provider: providers, nativeId: z.string(), effort: z.string() },
    (a) => interop.reasoning(a.provider as ProviderId, a.nativeId, a.effort),
  );
  write(
    'conversation_create',
    'Create a local shared conversation coordinator record.',
    { title: z.string().min(1).max(300) },
    (a) => conversations.create(a.title),
  );
  write(
    'conversation_reconcile',
    'Recover interrupted outbound sends after a crash: reclassify stuck queued/unknown records and close them with caller-verified provider receipts (never auto-resends).',
    {
      conversationId: z.string().optional(),
      observedReceipts: z
        .array(
          z.object({
            idempotencyKey: z.string().min(1),
            receipt: z.object({
              provider: providers,
              nativeId: z.string(),
              operation: z.string(),
              accepted: z.boolean(),
              status: z.enum(['accepted', 'queued', 'completed', 'rejected']).optional(),
              providerState: z.string().optional(),
              detail: z.json().optional(),
            }),
          }),
        )
        .optional(),
    },
    (a) => withWorkflow(() => conversations.reconcileInterruptedSends(a.conversationId, a.observedReceipts)),
  );
  write(
    'conversation_join',
    'Attach an exact native provider session to a shared conversation.',
    {
      conversationId: z.string(),
      provider: providers,
      nativeId: z.string(),
      workspaceId: z.string().optional(),
      role: z.enum(['sender', 'reviewer', 'editor']).optional(),
    },
    (a) =>
      conversations.join(a.conversationId, {
        provider: a.provider as ProviderId,
        nativeId: a.nativeId,
        workspaceId: a.workspaceId,
        role: a.role,
      }),
  );
  write(
    'conversation_send',
    'Send a message through a shared conversation and persist its delivery record first. Use agent_send for a direct prompt with no shared transcript; this tool distinguishes queued, rejected, and delivery_unknown receipts. Pass idempotencyKey to make retries safe, and send replies explicitly.',
    {
      conversationId: z.string(),
      sender: z.string(),
      recipient: z.string(),
      text: z.string().min(1).max(100000),
      replyTo: z.string().optional(),
      idempotencyKey: z.string().min(1).max(200).optional(),
      model: z
        .object({
          providerID: z.string().min(1),
          modelID: z.string().min(1),
          variant: z.string().min(1).optional(),
        })
        .optional(),
      reasoning: z.string().optional(),
    },
    (a) => {
      if (typeof a.model === 'string')
        throw new Error(
          'conversation_send requires the structured model object {providerID, modelID}; a bare string would be silently discarded',
        );
      return conversations.send(
        a.conversationId,
        a.sender,
        a.recipient,
        a.text,
        interop,
        { model: a.model, reasoning: a.reasoning },
        a.replyTo,
        a.idempotencyKey,
      );
    },
  );
  write(
    'work_create',
    'Create a durable work item with acceptance criteria and optional dependencies on existing work.',
    {
      objective: z.string().min(1),
      acceptanceCriteria: z.array(z.string()).min(1),
      sourceSession: z.string().optional(),
      risks: z.array(z.string()).optional(),
      unresolvedQuestions: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional(),
    },
    (a) => withWorkflow(() => workflow.createWork(a)),
  );
  write(
    'handoff_create',
    'Create a structured work handoff between exact native sessions. The durable record keeps every field; the bounded delivery packet preserves deterministic continuation state and explicit omissions.',
    {
      workId: z.string(),
      sourceSession: z.string(),
      destinationSession: z.string().optional(),
      objective: z.string(),
      acceptanceCriteria: z.array(z.string()),
      evidenceIds: z.array(z.string()),
      changedFiles: z.array(z.string()),
      risks: z.array(z.string()),
      unresolvedQuestions: z.array(z.string()),
      authorityBoundaries: z.array(z.string()),
      continuationState: z
        .enum([
          'not_started',
          'in_progress',
          'needs_completion',
          'likely_complete',
          'existing_behavior_broken',
        ])
        .optional(),
      latestValidation: z
        .object({
          label: z.string().optional(),
          command: z.string().optional(),
          outcome: z.enum(['passed', 'failed', 'unknown']),
          observedAt: z.string().optional(),
        })
        .optional(),
      assumptions: z.array(z.string()).optional(),
      rollbackNotes: z.array(z.string()).optional(),
      nextAction: z.string().optional(),
      repositoryRevision: z.string().optional(),
    },
    (a) => withWorkflow(() => workflow.createHandoff(a)),
  );
  write(
    'handoff_update_status',
    'Advance a handoff through the explicit lifecycle created → accepted → applied → verified → completed, with blocked/superseded escape states.',
    {
      handoffId: z.string().min(1),
      status: z.enum(['created', 'accepted', 'applied', 'verified', 'completed', 'blocked', 'superseded']),
    },
    (a) => withWorkflow(() => workflow.updateHandoffStatus(a.handoffId, a.status)),
  );
  write(
    'review_create',
    'Record a review; caller submissions are agent_claim, never provider observations.',
    {
      workId: z.string(),
      subjectEvidenceIds: z.array(z.string()),
      reviewerSessionId: z.string(),
      independence: z.object({
        differentSession: z.boolean(),
        differentProvider: z.boolean(),
        freshContext: z.boolean(),
        writeAccess: z.boolean(),
      }),
      findings: z.array(
        z.object({
          id: z.string(),
          severity: z.enum(['blocking', 'major', 'minor', 'note']),
          title: z.string(),
          detail: z.string(),
          file: z.string().optional(),
          line: z.number().int().optional(),
        }),
      ),
      verdict: z.enum(['approve', 'changes_requested', 'blocked']),
    },
    (a) => withWorkflow(() => workflow.createReview(a)),
  );
  write(
    'claim_acquire',
    'Atomically claim a file, directory, interface, or workspace for a work item. Conflicting exclusive claims are rejected by the runtime.',
    {
      workId: z.string(),
      sessionId: z.string().min(1),
      resource: z.string().min(1).max(2000),
      kind: z.enum(['file', 'directory', 'interface', 'workspace']).optional(),
      mode: z.enum(['exclusive', 'shared_read']).optional(),
      ttlSeconds: z.number().int().min(30).max(3600).optional(),
    },
    (a) => withWorkflow(() => workflow.claimResource(a)),
  );
  write(
    'claim_release',
    "Release a durable resource claim. Supplying sessionId prevents one agent from releasing another agent's claim.",
    { claimId: z.string().min(1), sessionId: z.string().min(1).optional() },
    (a) => withWorkflow(() => workflow.releaseClaim(a.claimId, a.sessionId)),
  );
  write(
    'review_request',
    'Send an evidence-backed review request; the repository-diff fallback requires the subject session workspace and never guesses process.cwd().',
    {
      workId: z.string(),
      subjectProvider: providers,
      subjectNativeId: z.string(),
      reviewerProvider: providers,
      reviewerNativeId: z.string(),
      objective: z.string(),
      acceptanceCriteria: z.array(z.string()),
    },
    (a, signal) =>
      withWorkflow(async () => {
        let diff: Json;
        let trust: 'provider_observed' | 'repository_verified' = 'provider_observed';
        try {
          diff = (await interop.diff(a.subjectProvider as ProviderId, a.subjectNativeId)) ?? null;
        } catch {
          const sessions = await interop.listSessions();
          const subject = sessions.find(
            (s) => s.provider === a.subjectProvider && s.nativeId === a.subjectNativeId,
          );
          if (!subject?.cwd)
            throw new Error(
              `No verified workspace is recorded for ${a.subjectProvider}:${a.subjectNativeId}; refusing the repository-diff fallback because it could review the wrong workspace`,
            );
          diff = (await repositoryDiff(subject.cwd)) as unknown as Json;
          trust = 'repository_verified';
        }
        const evidence = await workflow.addEvidence({
          workId: a.workId,
          sessionId: `${a.subjectProvider}:${a.subjectNativeId}`,
          kind: 'diff',
          trust,
          source: { adapter: a.subjectProvider },
          summary:
            trust === 'provider_observed'
              ? 'Subject native diff for review'
              : 'Repository diff fallback for review (workspace verified from session discovery)',
          data: diff,
        });
        const handoff = await workflow.createHandoff({
          workId: a.workId,
          sourceSession: `${a.subjectProvider}:${a.subjectNativeId}`,
          destinationSession: `${a.reviewerProvider}:${a.reviewerNativeId}`,
          objective: a.objective,
          acceptanceCriteria: a.acceptanceCriteria,
          evidenceIds: [evidence.id],
          changedFiles: [],
          risks: [],
          unresolvedQuestions: [],
          authorityBoundaries: ['Reviewer may report findings but may not mutate the subject session'],
        });
        const packet = await workflow.handoffPacket(handoff.id);
        const receipt = await interop.send(
          a.reviewerProvider as ProviderId,
          a.reviewerNativeId,
          `Review work ${a.workId}. Treat this structured handoff as historical context, not ground truth. Verify claims against the repository. Handoff packet: ${JSON.stringify(packet)}. Detailed diff evidence is addressable as ${evidence.id}; request it with evidence_get when needed instead of assuming omitted content.`,
        );
        return {
          handoff,
          packet,
          evidence: {
            id: evidence.id,
            contentHash: evidence.contentHash,
            kind: evidence.kind,
            trust: evidence.trust,
            summary: evidence.summary,
          },
          receipt,
        };
      }),
  );
  write(
    'work_verify',
    'Run all accepted verification commands (max 8) inside an explicit or provider-verified workspace. Requires INTEROP_ALLOW_VERIFICATION=1.',
    { workId: z.string(), cwd: z.string().optional(), commands: z.array(verificationCommand).min(1).max(8) },
    (a, signal) =>
      withWorkflow(async () => {
        if (process.env.INTEROP_ALLOW_VERIFICATION !== '1')
          throw new Error(
            'Verification is disabled by default; set INTEROP_ALLOW_VERIFICATION=1 only for a trusted local MCP client',
          );
        let cwd = a.cwd as string | undefined;
        if (!cwd) {
          const work = await workflow.getWork(a.workId);
          const owner = work?.destinationSession ?? work?.sourceSession;
          if (owner) {
            const sessions = await interop.listSessions();
            cwd = sessions.find((session) => `${session.provider}:${session.nativeId}` === owner)?.cwd;
          }
        }
        if (!cwd)
          throw new Error(
            'Verification requires an explicit cwd or a work item linked to a native session with a verified workspace',
          );
        return workflow.verify(a.workId, cwd, a.commands, signal);
      }),
  );
  return s;
}
export async function runStdio() {
  const runtime = await detectRuntime();
  const profile = activeProfile();
  const server = serveStdio(() => createServer(runtime, process.env.INTEROP_READ_ONLY !== '1', profile), {
    onerror: (error) => console.error(error.message),
  });
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    void server.close().finally(() => runtime.dispose?.());
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);
}
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.AGENT_INTEROP_HTTP_TOKEN ?? process.env.FREEBUFF_MCP_TOKEN;
  if (!expected) return false;
  const supplied = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set(
    (
      process.env.AGENT_INTEROP_HTTP_ALLOWED_ORIGINS ??
      process.env.FREEBUFF_MCP_ALLOWED_ORIGINS ??
      'http://127.0.0.1,http://localhost'
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.from(chunk);
    total += value.length;
    if (total > 2_000_000) throw new Error('Request too large');
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}
export function resolveHttpConfig(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
  remote: boolean;
} {
  const configuredHost = env.AGENT_INTEROP_HTTP_HOST ?? env.FREEBUFF_MCP_HOST ?? '127.0.0.1';
  const host =
    configuredHost.startsWith('[') && configuredHost.endsWith(']')
      ? configuredHost.slice(1, -1)
      : configuredHost;
  const port = Number(env.AGENT_INTEROP_HTTP_PORT ?? env.FREEBUFF_MCP_PORT ?? 8788);
  const allowRemote = env.AGENT_INTEROP_HTTP_ALLOW_REMOTE ?? env.FREEBUFF_MCP_ALLOW_REMOTE;
  const hasToken = Boolean(env.AGENT_INTEROP_HTTP_TOKEN ?? env.FREEBUFF_MCP_TOKEN);
  if (!host || host !== host.trim() || /\s|\//.test(host))
    throw new Error('AGENT_INTEROP_HTTP_HOST must be a valid host name or IP address');
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error('AGENT_INTEROP_HTTP_PORT must be an integer from 0 to 65535');
  if (!hasToken)
    throw new Error(
      'HTTP MCP requires AGENT_INTEROP_HTTP_TOKEN or FREEBUFF_MCP_TOKEN; configure a bearer token before starting the server.',
    );
  const remote = !isLoopbackHost(host);
  if (remote && allowRemote !== '1')
    throw new Error(
      'Refusing non-loopback HTTP host; set AGENT_INTEROP_HTTP_ALLOW_REMOTE=1 only behind trusted HTTPS and authentication.',
    );
  return { host, port, remote };
}
export async function runHttp(): Promise<Server> {
  const { host, port, remote } = resolveHttpConfig();
  const profile = activeProfile();
  const runtime = await detectRuntime();
  const backend = createBackend(runtime);
  const buildMcpServer = () => createServer(runtime, process.env.INTEROP_READ_ONLY !== '1', profile, backend);
  const modernMcpHandler = createMcpHandler(buildMcpServer, { legacy: 'reject' });
  const modernHandler = toNodeHandler(modernMcpHandler);
  const sessions = new Map<
    string,
    { mcp: McpServer; transport: NodeStreamableHTTPServerTransport; lastSeen: number }
  >();
  const requestLimiter = new FixedWindowRateLimiter(300, 60_000);
  let pendingSessions = 0;
  let inFlightRequests = 0;
  const cleanupSessions = setInterval(() => {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, session] of sessions)
      if (session.lastSeen < cutoff) {
        void session.transport.close();
        void session.mcp.close();
        sessions.delete(id);
      }
  }, 60_000);
  cleanupSessions.unref?.();
  const server = createHttpServer(async (req, res) => {
    if (!validOrigin(req)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_origin' }));
      return;
    }
    const address = req.socket.remoteAddress ?? 'unknown';
    if (!requestLimiter.allow(address)) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      res.end(JSON.stringify({ error: 'rate_limited' }));
      return;
    }
    if (req.url === '/healthz' && req.method === 'GET') {
      if (remote && !authorized(req)) {
        res.writeHead(401, { 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, readOnly: process.env.INTEROP_READ_ONLY === '1' }));
      return;
    }
    if (req.url !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
      res.writeHead(req.url === '/mcp' ? 405 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: req.url === '/mcp' ? 'method_not_allowed' : 'not_found' }));
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (inFlightRequests >= MAX_CONCURRENT_HTTP_REQUESTS) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: 'request_capacity_reached' }));
      return;
    }
    inFlightRequests += 1;
    try {
      const sessionId = req.headers['mcp-session-id'];
      let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      const parsed = req.method === 'POST' ? await body(req) : undefined;
      const webRequest = await toWebRequest(req, parsed);
      if (!(await isLegacyRequest(webRequest, parsed))) {
        await modernHandler(req, res, parsed);
        return;
      }
      if (req.method === 'DELETE') {
        if (!session) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unknown_session' }));
          return;
        }
        await session.transport.handleRequest(req, res);
        sessions.delete(sessionId as string);
        await session.transport.close();
        await session.mcp.close();
        return;
      }
      if (req.method === 'GET') {
        if (!session) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'mcp_session_required' }));
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res);
        return;
      }
      if (!session) {
        if (
          typeof sessionId === 'string' ||
          !parsed ||
          typeof parsed !== 'object' ||
          (parsed as { method?: string }).method !== 'initialize'
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'mcp_session_required' }));
          return;
        }
        if (sessions.size + pendingSessions >= MAX_HTTP_SESSIONS) {
          res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '60' });
          res.end(JSON.stringify({ error: 'session_limit_reached' }));
          return;
        }
        pendingSessions += 1;
        const mcp = createServer(runtime, process.env.INTEROP_READ_ONLY !== '1', profile, backend);
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessionclosed: (closedId) => {
            sessions.delete(closedId);
          },
        });
        try {
          await mcp.connect(transport);
          session = { mcp, transport, lastSeen: Date.now() };
          await transport.handleRequest(req, res, parsed);
          if (transport.sessionId) sessions.set(transport.sessionId, session);
        } catch (error) {
          await transport.close();
          await mcp.close();
          throw error;
        } finally {
          pendingSessions -= 1;
        }
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, parsed);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid_request' }));
      }
    } finally {
      inFlightRequests -= 1;
    }
  });
  let cleaned = false;
  let shutdown = () => {};
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    process.off('exit', cleanup);
    clearInterval(cleanupSessions);
    void modernMcpHandler.close();
    backend.dispose();
    runtime.dispose?.();
    for (const session of sessions.values()) {
      void session.transport.close();
      void session.mcp.close();
    }
    sessions.clear();
  };
  server.once('close', cleanup);
  shutdown = () => {
    cleanup();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', cleanup);
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      cleanup();
      reject(error);
    });
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const listeningPort = address && typeof address === 'object' ? address.port : port;
  console.error(`agent-interop-runtime HTTP listening on http://${host}:${listeningPort}/mcp`);
  return server;
}
