# Changelog

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
