# Changelog

## 0.3.0

This release turns Agent Interop Runtime into a stronger coordination and reliability layer for heterogeneous native coding-agent sessions.

- Make caller idempotency atomic across processes and add renewable durable dispatch leases so recovery cannot casually duplicate or misclassify live provider work.
- Fix native permission request identity, provider event-stream restart behavior, cross-process workflow freshness, participant-ID collisions, redirect handling, IPv6 loopback classification, and remote OpenCode transport security.
- Share one provider backend across HTTP MCP sessions instead of spawning independent native adapters per client.
- Add capability-oriented `minimal`, `core`, `freebuff`, `legacy`, and `full` tool profiles that gate both reads and writes.
- Add content-addressed evidence lookup, referential integrity for work/evidence/handoffs/reviews, work dependencies, resource claim leases, structured continuation metadata, and an explicit handoff lifecycle.
- Keep review delivery within the handoff token budget by sending compact packets plus evidence references rather than duplicating full diffs.
- Add reconnect-safe event pages with monotonic runtime cursors, epochs, and retention-gap metadata.
- Constrain verification commands to a declared or provider-verified workspace and strip credential-shaped environment variables.
- Restore executable cross-platform CI, align all release metadata, and add a catalog-size regression gate.

Research informing the design included recent work on handoff debt, delegation reliability, explicit multi-agent coding coordination, structured communication, and transactional validation. Resource claims coordinate cooperative clients but do not sandbox arbitrary provider filesystem writes, and live provider interoperability remains dependent on installed/authenticated provider versions.
## 0.2.9

This release refreshes Freebuff Desktop launch authorization after rejected requests and searches the documented local readiness and log locations for the current launch ID. Desktop writes remain disabled until the live header is accepted.

Freebuff CLI startup now strips terminal control sequences and accepts current full screen readiness markers, with an explicit `FREEBUFF_CLI_READY_PATTERN` escape hatch for future CLI changes.

The native PTY dependency is now `1.2.0-beta.15`. CI covers Ubuntu macOS and Windows with Node 20 22 24 and 26. The README now separates verified runtime behavior from provider installation and authentication requirements.

## 0.2.8

Freebuff CLI control now requires a successful PTY startup probe. The managed CLI reports queued and running progress, preserves exact conversation identifiers for model and reasoning commands, and forwards unified send controls instead of silently ignoring them.

The runtime pins the node pty beta release containing the macOS spawn helper permission fix and reports the actual PTY version in diagnostics.

OpenCode model requests use modelID first and retry the compatible id shape only for a model related HTTP 400. Provider error responses are returned with bounded redacted diagnostics. OpenCode reasoning maps to the active model variant.

## 0.2.7

Cursor Agent Client Protocol support is now available through the Cursor agent executable. The runtime can install a safe read only Cursor MCP entry globally or in the current project, authenticate when Cursor requests it, create and resume sessions, send prompts, cancel work, and pass model and mode selections when the session advertises those controls.

OpenCode model requests now use the provider model identity expected by its HTTP API. OpenCode session model changes are supported and prompt acceptance remains clearly separate from completion.

ACP optional methods are checked against advertised capabilities. Native process diagnostics are retained with secrets redacted so missing executables, failed authentication, and startup failures are easier to diagnose.

## 0.2.6

Freebuff CLI mode now has executable checks, a real node-pty probe, explicit runtime diagnostics, and JSONL history support. Explicit CLI mode remains authoritative over Desktop discovery.

OpenCode now sends structured model identities and keeps agent selection separate. Claude ACP now negotiates file and terminal access, discovers persisted sessions when supported, and applies model and thought level configuration through ACP methods.

## 0.2.5

This release completes the audit hardening pass.

OpenCode now handles empty successful responses, authenticates remote servers, validates discovery payloads, reconnects event streams, preserves monotonic event sequences, and reports prompt delivery as queued rather than completed.

Provider failures now remain visible beside successful session discovery. HTTP MCP sessions persist across requests and support clean deletion. Configuration installation is safe to repeat and repairs existing entries. Corrupt workflow state is preserved for recovery instead of being silently discarded.

## 0.2.4

- Keep healthy provider sessions discoverable when another provider is unavailable.

## 0.2.3

- Add an explicit setup alias that registers the published package in Codex config.
- Avoid writing ephemeral local package cache paths into MCP configuration.

## 0.2.1

- Prepare the first public npm and MCP Registry release.

## 0.2.2

- Keep the CLI and MCP protocol version aligned with the published package.

## 0.2.0

- Add npm and official MCP Registry metadata for universal pnpm and npx installation.
- Add package metadata validation to the release checks.
- Disable MCP verification commands by default unless explicitly authorized.
- Restrict configured Freebuff discovery URLs to loopback addresses.
- Protect durable workflow state with owner-only permissions on Unix-like systems.

## 0.1.5

- Add normalized, redacted, bounded live Desktop progress via `/api/events`.
- Add `get_thread_progress` polling and bounded `watch_thread` long-polling.
- Add phase labels, progress summaries, active-thread watching, fresh readiness metadata discovery, and a safe Codex install helper.
- Omit detailed reasoning deltas from normalized live progress by default.
- Keep live event history in memory and stop the event client on runtime disposal.

## 0.1.4

- Document cross-platform Codex, CLI, and HTTP setup.
- Correct the HTTP security policy and explain optional Cloudflare use.

## 0.1.3

- Add readiness metadata discovery for Desktop port and launch ID.
- Verify the launch ID through `/healthz` before enabling Desktop mutations.
- Send `x-freebuff-launch-id` on authenticated Desktop requests.

## 0.1.2

- Add native listener probing as a Desktop dynamic-port discovery fallback.
- Omit mutation tools when the active runtime is read-only.
- Validate project and thread payload fields at the API boundary.
- Use deterministic path-derived CLI history keys while retaining legacy lookup.

## 0.1.1

- Discover Freebuff Desktop on Windows, macOS, and Linux from dynamic-port logs.
- Prefer Desktop by default, with explicit CLI PTY mode and CLI fallback.
- Keep Desktop mutations disabled until Freebuff's launch authorization contract is verified.
- Improve CLI executable discovery, project-key overrides, cleanup, and safe file listings.
- Exclude test files from published build output and add runtime coverage.

## 0.1.0

- Initial secure stdio MCP bridge with capability probing, project and thread reads, safe file access, and guarded Desktop actions.
