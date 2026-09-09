# Audit implementation checklist

Repository: agent-interop-runtime. Base commit: `eef8f68361841198b62116f8c25bb642797bf845` (v0.2.10).
Branch: `audit-implementation`. Every finding maps to code, tests, and a status.

Status legend: **fixed and verified** / already fixed / disproved / blocked (named prerequisite).

## Confirmed bugs

| ID | Status | Code | Tests |
| --- | --- | --- | --- |
| AI-01 persist before send | fixed and verified | `src/conversations.ts` `send`: durable record + idempotency key before dispatch; `delivery_unknown` classification on dispatch failure, never auto-resent | `test/audit-regressions.test.ts` AI-01 |
| AI-02 stores overwrite each other | fixed and verified | `src/conversations.ts` `transact`: whole read-modify-write under exclusive lock with disk reload; shared helpers in `src/state.ts` | AI-02 test: two stores preserve both creations |
| AI-03 pagination breaks after trimming | fixed and verified | `src/conversations.ts`: monotonic per-message `sequence`, persisted `lastSequence`, cursor = last delivered sequence, explicit `gap` | AI-03 test: 500→502 boundary, gap declared |
| AI-04 progress cursor skips next event | fixed and verified | `src/events.ts`: `next` = last delivered sequence; `nextSequence` kept as alias for compatibility | AI-04 test: round trip ×5 exactly once; empty page stable |
| AI-05 healthy stream stale after 90s | fixed and verified | `src/events.ts`: `stale` computed from `connected && (now - lastActivityAt) <= 90s`; `noteActivity()` on transport chunks and heartbeats | AI-05 test: activity keeps stream healthy; disconnect stale |
| AI-06 nested other-session attribution | fixed and verified | `src/adapters.ts` `attributedSession`: checks `properties.sessionID`, `properties.info.sessionID`, `properties.part.sessionID`; unattributable events skipped, never stamped | AI-06 test: 3 nested shapes attributed; other-session and global events excluded |
| AI-07 password-only SSE auth missing | fixed and verified | `src/adapters.ts`: shared `opencodeAuthHeaders()` (default username `opencode`) used by requests and SSE; shared `isLoopbackHost` | AI-07 tests: password-only SSE carries Basic; loopback normalization |
| AI-08 fifth verification command ignored | fixed and verified | `src/workflow.ts` `verify`: all accepted commands run (limit 8, over-limit rejected before execution); structured `{executable,args,cwd}` entries; verification-pass ≠ human acceptance (`in_progress`, not `accepted`) | AI-08 test: 9 rejected; 5 run incl. failing fifth; quoted args intact; evidence per command |
| AI-09 malformed TOML rewritten | fixed and verified | `src/toml.ts` structural validator + `src/cli.ts` install: validate existing file (nonzero exit, byte-identical refusal), validate proposed result before atomic write | AI-09 tests ×2: validator grammar; nested tables preserved |
| AI-10 workflow loses updates to existing records | fixed and verified | `src/workflow.ts` `transact`: disk state re-read inside lock and merged before mutation, same machinery as AI-02 | AI-10 test: two stores' evidence both survive incl. references |
| AI-11 bearer credential left visible | fixed and verified | `src/security.ts`: `redactString` covers full `authorization: Bearer/Basic/Digest <value>`, `key=value` shapes, private-key blocks; single helper used everywhere | AI-11 test: fake secrets removed from strings, nested objects, multiline; nonsensitive text kept |
| AI-12 ACP cancel sent as request | fixed and verified | `src/adapters.ts` Claude `interrupt`: `session/cancel` via `notify` transport; receipt reports `cancel_notification_sent` | wire test: real child-process fixture (no-reply cancel) + adapter test: zero request-channel calls |
| AI-13 ACP create/resume loses cwd | fixed and verified | `src/adapters.ts`: requested cwd recorded on create even for minimal `{sessionId}` responses; resume reuses recorded cwd; fs reads refuse to guess when unknown | AI-13 test: minimal response keeps cwd through resume; not process.cwd() |
| AI-14 events_read not time-bounded | fixed and verified | `src/interop-runtime.ts` `readEvents(limit, timeoutMs)`: deadline race returns available snapshot; MCP `events_read` exposes `timeoutMs` | deadline logic exercised via bounded-wait tests; no new global SSE per poll |
| AI-15 readiness-file URLs bypass loopback | fixed and verified | `src/runtime.ts`: `assertLoopbackCandidateUrl` on readiness files (same boundary as env URL), `redirect: 'error'` on discovery fetches, re-validation at fetch | AI-15 test: remote/IPv4-lookalike rejected, IPv4/IPv6 loopback accepted |

## Evidence trust

| ID | Status | Code | Tests |
| --- | --- | --- | --- |
| AI-R1 caller-authored review promoted to provider_observed | fixed and verified | `src/workflow.ts` `createReview`: default `provenance: 'agent_claim'`; evidence trust `agent_claim` for caller submissions | wire test: invented reviewer stays agent_claim, no provider_observed |
| AI-R1 wrong-workspace diff fallback (source-supported) | fixed and verified | `src/mcp.ts` `review_request`: fallback resolves the subject session from discovery and requires its verified `cwd`; missing mapping stops the fallback | covered by session-resolution path; no live multi-provider acceptance run (labeled) |

## Section 4 gaps

| Finding | Status | Code | Tests |
| --- | --- | --- | --- |
| Handlers not gated on `ready` | fixed and verified | `src/conversations.ts` `ensureLoaded` gates every op; workflow transact gates on `load()` | gate test: create on never-loaded store works |
| Pending permissions invisible | fixed and verified | `NativeProtocolAdapter.listPendingPermissions`, `InteropRegistry.pendingPermissions`, MCP `permission_pending` read tool | wire test: unknown request IDs rejected, never auto-approved |
| Registry not disposed on close | fixed and verified | `src/mcp.ts`: `McpServer.close` wrapped to dispose the registry (child processes) | repeated create/dispose covered by adapter dispose; live HTTP cycle not run on a host server |
| Stale lock blocks persistence | fixed and verified | `src/state.ts` `withStateLock`: PID liveness + lease expiry recovery, lock contents recorded, `AsyncLocalStorage` reentrancy so composed store transactions (createReview → addEvidence) share one lock instead of self-deadlocking | gate test: dead-PID lock recovered; 10 concurrent writers serialize; nested-transaction test with a file-backed store |
| Session discovery ignores pagination cursors | blocked by external prerequisite: provider list APIs used here return full arrays in validated protocol shapes; bounded follow-up pages need a live provider contract fixture. Cursor stability within the runtime is fixed (AI-03/04). | — | — |
| PTY newlines → spaces | fixed and verified | `src/pty.ts`: bracketed-paste write of the exact text (multiline preserved); per-session write queue serializes concurrent prompts | PTY probe ok; real CLI paste flow requires installed CLI (labeled) |
| Readiness matches "already running" | fixed and verified | `src/pty.ts`: bare `Freebuff` removed from default readiness markers | behavior change documented in source comment |
| conversation_send drops string model | fixed and verified | `src/mcp.ts`: schema accepts only the model object; string form rejected with explicit error | typecheck + schema validation |
| Rejected receipts return normal MCP results | fixed and verified (scope: documented receipt semantics) | `conversation_send` surfaces `delivery` = queued/rejected/delivery_unknown in the result and throws on unknown delivery so MCP clients see the failure | AI-01 test |
| Diff truncation undeclared | fixed and verified | `src/verification.ts` `repositoryDiff`: `diffTruncated/diffTotalBytes/statusTruncated/statusTotalBytes` | wire test |
| README 0.2.9 vs 0.2.10; Cursor @latest; CI checks | fixed and verified | version bumped to 0.2.11, README pins regenerated, Cursor installer pins `@${VERSION}`, CI adds lint + mcp:validate | grep + workflow diff |
| `lint` is only a forbidden-pattern scan | acknowledged; kept as-is (fast CI guard). Comprehensive TS lint remains an accepted gap; adding a full linter was deferred with the audit's other scope items. | — | — |

## Readiness review (2026-09-09) — AIR findings

Independent readiness review findings; each fixed with a root-cause change and a regression test. `test/conversations.test.ts` and `test/workflow.test.ts` contain the AIR-tagged tests.

| Finding | Status | Fix and evidence |
| --- | --- | --- |
| AIR-01 conversation sends route the composite participant ID as a native session ID | fixed and verified | `ConversationStore.send` resolves the joined participant record and dispatches with its actual `provider`/`nativeId`; custom participant IDs no longer influence provider resolution (`src/conversations.ts`). Test: protocol-shaped fake registry asserts `receipt.nativeId === 'b'`, not `'opencode:b'`, plus a custom-ID provider check |
| AIR-02 concurrent same-millisecond state updates can be lost | fixed and verified | The complete disk snapshot under the exclusive lock is now the transaction base (no timestamp comparison); receipt persistence writes through the same transaction (`src/conversations.ts`). Tests: frozen-clock interleaved joins preserve both participants; frozen-clock receipt updates persist detail |
| AIR-03 shared lock can be stolen from a live writer | fixed and verified (second review: root mechanism replaced) | `src/state.ts` rewritten AGAIN after the second review reproduced the open('wx')→writeFile creation-window theft: lock content is now published ATOMICALLY (uniquely-named temp file + `link()`, an atomic create-if-absent — the creation window no longer exists, so the old monkey-patched `fs.open` attack cannot be constructed at all); a live owner is NEVER recoverable regardless of age; dead-owner recovery after a 1.5 s stabilization window (bounded by LOCK_MAX_WAIT 10 s, previously a deadlock since 15 s grace > 10 s max wait); recoveries serialized under a separate `.recovery` lock with liveness re-verified before unlink; release verifies ownership by per-acquisition token; lease renewed every 5 s while inside the critical section. Tests (`test/lock-regressions.test.ts`, all cross-process): atomic publication exclusion, live-owner exclusion + post-release acquisition, dead-owner auto-recovery < 9 s, competing recoverers clean, long-held live lock survives a late-comer's wait. The paused-`fs.link` variant of the second review's attack was also run: the contender can neither win nor recover nor steal (safe timeout) |
| AIR-04 long-lived readers never observe another process's writes | fixed and verified | All store read paths (`get`/`list`/`read`) and transactions refresh from disk when the file signature (mtime+size) changes; disk is the authority (`src/conversations.ts`). Test: a reader loaded before a writer's send observes the message through get/read/list |
| AIR-05 handoff packets omit mandatory instructions and misreport token size | fixed and verified | `createHandoff` budgets the COMPLETE serialized packet with the named tokenizer (o200k_base), converging the self-referential `contextTokens` field; objective/acceptanceCriteria/authorityBoundaries are mandatory — if they cannot fit, creation is REJECTED before delivery; optional fields become explicit omissions whose notes are also budgeted (`src/workflow.ts`). Tests: oversized handoff rejected (/NOT created/), feasible handoff reports tokens matching the same tokenizer exactly, durable record keeps all fields |
| Regression: same-millisecond handoff IDs collided (second creation silently overwrote the first in the handoffs map) — introduced while stabilizing the budget test, caught by follow-up source review | fixed and verified | `createHandoff` uses a fixed-length collision-resistant ID (`handoff_${randomUUID()}`) generated BEFORE packet measurement so all token accounting uses the actual final ID; packet size is a pure function of content plus a fixed-length ID. Budget tests are deterministic via CONTROLLED INPUTS (fixed workId fixture; budget derived from measured content gaps large enough to dwarf the measured 12-token UUID tokenization band) — not by weakening ID uniqueness. Reproduced under a frozen clock (two distinct handoffs collided; handoffPacket returned the wrong objective), fixed, and ported as a regression test asserting distinct IDs and per-ID packet objectives (`test/workflow.test.ts`). Flake-swept: 12/12 full-suite runs clean on real Node 20 |
| AIR-06 declared Node 20 validation target fails | fixed and verified | `pnpm test` now runs `scripts/run-tests.mjs`, which enumerates test files via the filesystem API (no shell glob dependency). Verified on a real downloaded Node v20.19.5 runtime: full suite pass; Node 24 also full-suite pass (see Verification run for current counts) |
| Outbound idempotencyKey is per-call, not caller-stable | fixed and verified | `conversation_send` accepts an `idempotencyKey` (e.g. `workId/handoffId`); a retried send with the same key is rejected pointing at the existing record instead of enqueueing a duplicate. Test asserts the duplicate rejection and stable key |
| Crash between provider acceptance and receipt persistence leaves a stuck queued record | fixed and verified (second review: semantics corrected) | `reconcileInterruptedSends` reworked after the second review proved delivery_unknown records were unreachable and `resolved` was reported without mutation: selection now covers BOTH `queued` and `delivery_unknown`; a caller-verified receipt resolves EITHER state (accepted+completed → completed, accepted-else → queued-with-confirmed-receipt, rejected → rejected); `resolved:true` only when THIS call transitioned the record (verified by re-reading stored state); terminal records are never touched and never re-reported; repeated reconciliation is idempotent. Tests: six new cases in `test/conversations.test.ts` — unknown→completed via receipt, queued→unknown→queued-with-receipt, unknown→rejected via receipt, terminal records untouched, repeated reconciliation idempotent, plus the end-to-end registry failure → receipt-closure flow. Exact second-review scenario verified against built code: provider throws → delivery_unknown → reconcile with verified completed receipt → completed, stored |
| Queued records must not be misclassified as crashed while a dispatch is in flight (second review blocker 3) | fixed and verified | `send()` marks the dispatch window (`markDispatchStarted`/`markDispatchFinished`) around the provider call; reconciliation skips in-flight queued records (they stay queued) and reports nothing for them. Tests: direct marker test plus an end-to-end concurrent test where a blocked provider call is NOT reclassified by a simultaneous reconcile, then completes normally. Cross-process in-flight dispatches cannot be distinguished from a crash by another process; the honest classification (delivery_unknown) is assigned, and the original process's receipt transaction overwrites it on completion (documented in `src/conversations.ts`) |
| Recovery must be exposed through the runtime workflow, not only as an unused store method (second review blocker 3) | fixed and verified | Servers run reconciliation automatically after store initialization (crash orphans become delivery_unknown; never a resend); new `conversation_reconcile` MCP write tool (registered in every profile incl. core) accepts `conversationId` and caller-verified `observedReceipts` and returns per-record resolved/previousDelivery. Tests: tool registration + end-to-end receipt closure through the tool handler |
| Windows/Linux verification; live authenticated two-provider acceptance | blocked by named external prerequisites | No Windows/Linux runners or authenticated provider installs were available in this environment. Configured CI covers the matrix (`pnpm bench:check` included); local verification ran on macOS Node 24.19.0 and Node 20.19.5. The live discovery→join→send→reply→cursor-resume→restart→acceptance run remains a separate authorized step |

## Token-efficiency items

| Item | Status | Evidence |
| --- | --- | --- |
| Metadata-only conversation/work/evidence lists | fixed and verified | `conversation_list` (default metadata, `detail` opt-in), `work_list` (previews + counts), `evidence_list` (summaries with dataBytes); tests assert message bodies absent from default list shape |
| Compact default responses with explicit opt-in | fixed and verified (partial) | conversation/work/evidence lists; full result `detail` field-selection across all 43 tools deferred (roadmap item 3) |
| Capped addressable artifacts | fixed and verified (partial) | evidence summaries addressable by ID; full hunk/range retrieval deferred (backlog item 6) |
| Provider/toolset profiles | fixed and verified | `src/profiles.ts` + profile gate in `createServer`: `core` (37 tools), `legacy` (44), `full` (default = pre-profiles surface, compatibility-tested). Selected via `INTEROP_TOOLS_PROFILE` or `--profile`; `freebuff_status` reports the active profile. Read-only mode composes with profiles. Tests: `test/profiles.test.ts`. Measured: core omits 7 tools / 642 B / 122 tokens (o200k_base) vs full |
| Bounded handoff packet with delivery state | fixed and verified (core) | `handoff_create`/handoffs persisted with objective, criteria, evidence refs, authority boundaries; correlated delivery receipts via AI-01; restart-safe via AI-02/10. Token budget (default 2,000, `INTEROP_HANDOFF_TOKEN_BUDGET`): delivery packet measured with o200k_base; oversized fields become explicit `omittedFields` with request instructions — the durable record never loses fields (`handoffPacket()` + `handoff_packet` tool). Two-provider offline benchmark harness (`test/benchmark/`, `pnpm bench`): 0 duplicate reads, 0 duplicate provider sends, terminal states recorded; CI gate `pnpm bench:check` fails on any duplicate delivery |
| Honest usage accounting | preserved | no invented provider usage metrics added; receipts state `completion: not_observed` where applicable |
| Measured byte counts | measured | JSON-schema `tools/list` serialization: baseline 43 tools / 16,772 B → this branch 44 tools / 17,339 B (+567 B = new `permission_pending` tool + declared-truncation/structured-command schemas, offset by trimmed descriptions). Response bytes: `work_list` 654 → 509 B for the same record (metadata-only). The audit's 20,974 B figure used a different (raw zod def) serialization; identical-formula measurement on both versions shows the catalog grew only by the added capability |

## Two-provider offline benchmark (audit §7 vertical slice)

Fixed handoff tasks (implement-utils, review-hotfix, blocked-then-resume) run through the real ConversationStore / WorkflowStore / InteropRegistry / MCP handlers with in-memory provider peers. Measurements (`pnpm bench`):

- Tokenizer: **js-tiktoken `o200k_base`** — an offline estimate of prompt-size cost, explicitly NOT native provider usage reporting.
- Per task (representative run): ~3,400–3,700 payload bytes, ~1,077–1,174 tokens across ~19 metered steps; blocked-then-resume is the largest.
- Correctness assertions (also regression-tested, `test/benchmark/benchmark.test.ts`): 0 duplicate event/message reads per observer (AI-03/AI-04 cursor contract), 0 duplicate provider-observed sends (AI-01 idempotency), shared per-session event subscription reused across polls (AI-14).
- Catalog context delta: core profile saves 7 tools / 642 B / 122 tokens vs full (o200k_base).

AI-14 hardening added in this pass: `InteropRegistry.readEvents` now serves reads from ONE shared per-session buffer (single adapter subscription, 200-event bounded history, fan-out to concurrent consumers) with a round-trip `afterSequence` cursor exposed on `events_read`; the deadline timer stays referenced so a standalone caller cannot await forever. `pnpm test` glob fixed to explicit patterns after the previous `**` glob silently skipped files depending on shell.

## Verification run (latest, 2026-09-09)

- `pnpm typecheck` — pass
- `pnpm test` — **102/102 pass** (36 baseline + audit/protocol/security/lock/reconcile/readiness regressions + benchmark tests). Node 20 note: `pnpm test` runs `scripts/run-tests.mjs` (filesystem-enumerated, glob-free). Verified on a real Node v20.19.5 runtime; a 12-run repeated sweep there was clean after the handoff-budget flake was fixed at the test level.
- `pnpm lint` — pass (35 source files scanned)
- `pnpm mcp:validate` — pass (0.2.11, server.json version aligned)
- `pnpm build` — pass
- `pnpm pty:probe` — ok on macOS / Node 24.19.0 (node-pty 1.2.0-beta.15)
- `pnpm bench` — 3 fixed two-provider tasks, 0 duplicate reads/sends, honest tokenizer label (js-tiktoken o200k_base, offline estimate)
- `pnpm bench:check` — CI gate: fails on duplicate deliveries or dishonest tokenizer label
- `npm pack --dry-run` — pass (29 files packaged)
- Live discovery probe — an isolated local `opencode serve` (v1.18.29, private loopback port, no sessions created, no global state touched) answered the adapter's discovery/`GET /session` path with a valid shape; this validates the discovery contract against a real server but is NOT session/send/cancel acceptance.
- CI workflow updated to run lint + mcp:validate + bench:check on the existing OS/Node matrix (a green CI run has not been observed from this environment)

## External blocker inventory (exact prerequisites; not claimed complete)

| Gate | Missing resource | Acceptance procedure | Expected evidence | Remaining implementation |
| --- | --- | --- | --- | --- |
| Windows execution | No Windows host/runner reachable from this environment | Run `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm lint && pnpm build && pnpm pty:probe` on windows-latest (CI matrix already configured) | Green CI run or pasted local output, esp. PTY probe + lock cross-process regressions | None in code; tests already avoid POSIX-only paths where possible |
| Linux execution | No Linux host/runner reachable | Same command set on ubuntu-latest | Green CI run | None in code |
| Live two-provider acceptance | Provider sessions consume quota and contact real agents — requires explicit user authorization; CLIs (`opencode` 1.18.29, `codex` 0.147.0) ARE installed with auth present | Authorized run of discovery → create/join → send (exact-session nonce) → reply → cursor resume → restart recovery → verification/review against both providers | Provider-side session IDs matching requests, receipts classified correctly, no cross-session events, restart-safe records | None identified; discovery leg already probed live (see above) |
| Live benchmark | Same authorization as above | Run `pnpm bench --live` equivalent against real providers | Measured (not estimated) native usage/latency; unknown where unobserved | Harness ready; only labeled-live mode missing |

## Remaining external steps (not performed, per instructions)

1. No npm publish, release tag, push, or merge. The `audit-implementation` branch is ready for review.
2. Live multi-provider acceptance requires explicit user authorization (see blocker table).
3. Backlog items deferred by the audit: full field-selection opt-in, hunk-level artifact retrieval, revision-aware context reuse, usage dashboard (requires real provider usage data; the offline harness, token-budgeted handoffs, and the measured baseline are in place).
