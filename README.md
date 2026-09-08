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

Everyone can run the published MCP package with pnpm without cloning the repository

```text
pnpm dlx agent-interop-runtime@latest doctor
pnpm dlx agent-interop-runtime@latest serve
```

The package is distributed as a standard npm package and is compatible with pnpm, npm, and npx. The official MCP Registry metadata is included in `server.json`; registry publication still requires the maintainer's authenticated npm and MCP Registry release step.

The original Freebuff project is not modified by this repository.

## MCP configuration

```toml
[mcp_servers.agent_interop]
command = 'node'
args = ['C:\\path\\to\\agent-interop-runtime\\dist\\src\\cli.js', 'serve']
enabled = true
```

The `freebuff-mcp` pattern is a local MCP client pattern. A desktop client such as Codex starts this command over stdio and discovers the tools during session startup. It does not make a local process appear inside ordinary ChatGPT web Plus chats and it does not bypass ChatGPT plan or Developer Mode requirements for remote custom apps.

To install the local registration automatically, run

```text
node dist/src/cli.js install --write
```

Then restart the local MCP client. The installer adds an `agent_interop` entry to the user Codex configuration using the published package, so it does not depend on a temporary npx cache path. `setup` is an alias for `install`. Use the generated configuration output first if you want to review it without writing anything.

```text
npx agent-interop-runtime@latest setup --write
```

The package deliberately does not modify `config.toml` from an npm `postinstall` hook. Configuration changes happen only after this explicit command, which keeps package installation reviewable and safe.

For a storage or repository analysis, enable the read only entry with `INTEROP_READ_ONLY = '1'`. This removes mutation tools from that MCP server process rather than merely asking the model not to use them.

For trusted Codex work sessions that should run repository checks, also add `INTEROP_ALLOW_VERIFICATION = '1'`. Verification remains disabled by default because it launches local commands.

OpenCode uses its local server at `http://127.0.0.1:4096` by default. Start it with `opencode serve --hostname 127.0.0.1 --port 4096` or set `OPENCODE_SERVER_URL` when its port is different. Remote OpenCode servers require `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`. OpenCode model values use `{ providerID, modelID }`. The `agent` field selects an OpenCode agent. It is not a reasoning setting.

## MCP surface

Read tools include `list_agents`, `list_agent_sessions`, `get_work_graph`, `get_agent_diff`, `freebuff_status`, and the existing Freebuff inspection tools.

Write tools include `agent_send` and `agent_cancel` when the runtime is not globally read only and the selected provider reports support. OpenCode reports a successful prompt as queued after the HTTP server accepts it. Completion must be observed through events or a later session read. `agent_send` keeps model, agent, and reasoning as separate fields.

Set `FREEBUFF_MCP_CLI_MODE=pty` to force Freebuff CLI mode. This selection happens before Desktop discovery and cannot be overridden by stale or read only Desktop readiness data. The CLI path may be supplied with `FREEBUFF_CLI_PATH`. Run `pnpm pty:probe` to diagnose node-pty startup independently from Freebuff authentication.

Claude Code uses the ACP executable configured by `CLAUDE_ACP_COMMAND` or `claude-code-acp`. It can create sessions, load or resume provider owned sessions, send prompts, cancel work, and apply model or thought level selections when ACP advertises the corresponding configuration options. The working directory is sent as the ACP session root so Claude can use its own file tools within the same conversation.

The supported Node range is 20 through 26. If node-pty reports `posix_spawnp failed` or a ConPTY startup error, run `pnpm rebuild node-pty` with the active Node version and then run `pnpm pty:probe`. This test uses the same native PTY library and a platform shell probe, so it distinguishes runtime setup from provider authentication.

`list_agent_sessions` returns both `sessions` and `providerErrors`. An unavailable provider is never represented as an empty successful result.

The HTTP transport keeps MCP sessions in memory between requests. It requires a session identifier after initialization and supports the MCP delete request for cleanup.

Run `agent-interop-runtime install --write` repeatedly when needed. The installer replaces only the Agent Interop configuration section and leaves unrelated configuration intact.

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
