# Agent Interop Runtime

Agent Interop Runtime gives MCP clients one careful doorway into live coding agent sessions.

It keeps each provider identity intact. Freebuff remains the first class native bridge. OpenCode can use its local server. Codex and Claude Code are discovered without pretending that a terminal process is a live protocol session.

## What it does

The runtime can discover providers and native sessions, grade their capabilities, send work where a supported transport exists, cancel active work, read native diffs, and retain evidence about where every result came from.

The first version includes

* Freebuff Desktop and CLI through the preserved native bridge
* OpenCode server discovery with sessions, prompts, cancellation, and diffs
* Codex App Server readiness discovery
* Claude Code and ACP readiness discovery
* A provider neutral session and evidence graph
* MCP tools for discovery, messaging, cancellation, capability review, and evidence
* Read only degradation when authorization or a native transport is unavailable

## Install

```text
pnpm install
pnpm build
node dist/src/cli.js doctor
node dist/src/cli.js serve
```

The original Freebuff project is not modified by this repository.

## MCP configuration

```toml
[mcp_servers.agent_interop]
command = 'node'
args = ['C:\\path\\to\\agent-interop-runtime\\dist\\src\\cli.js', 'serve']
enabled = true
```

OpenCode can be found at its local server URL. Set `OPENCODE_SERVER_URL` when its port is different from the default.

## MCP surface

Read tools include `list_agents`, `list_agent_sessions`, `get_work_graph`, `get_agent_diff`, `freebuff_status`, and the existing Freebuff inspection tools.

Write tools include `agent_send` and `agent_cancel` when the selected provider reports support. Provider capability output is the source of truth.

## Design

The runtime uses a small common contract for sessions, operations, events, diffs, permissions, and model controls. The common layer is intentionally narrower than any provider. Native identifiers and provenance stay attached to every normalized session and evidence record.

The evidence model separates native facts from observations and independent verification. It never treats a message that says a file changed as proof that the file changed.

## Useful commands

```text
node dist/src/cli.js doctor
node dist/src/cli.js agents
node dist/src/cli.js sessions
node dist/src/cli.js work list
node dist/src/cli.js work evidence WORK_ID
node dist/src/cli.js work verify WORK_ID pnpm test pnpm typecheck pnpm build
```

The MCP surface includes discovery, exact session control, bounded event reads, native diffs, structured work creation, handoffs, review requests, durable evidence, and deterministic verification.

## Verification

```text
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

## Security

Local HTTP binds to loopback by default and requires a bearer token. Remote binding requires an explicit opt in. Credentials and authorization headers are redacted from returned data. Provider adapters do not upload local files or copy secrets into the repository.

## Status

Freebuff and OpenCode have working local control paths. Codex and Claude Code report honest readiness until their supported native session transport is connected. Cursor is intentionally reserved for a later adapter.
