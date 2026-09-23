# Agent Interop Runtime

Agent Interop Runtime is a local MCP server for connecting supported coding agents through their native local interfaces.

It keeps provider sessions separate and adds a safe coordinator for directed messages between them. It does not merge provider accounts. It does not place an agent inside a normal ChatGPT web conversation. It does not bypass a provider login or approval screen.

## What works

The runtime can do the following when the matching provider is installed and available.

* Discover providers and their real capability status
* Discover native sessions without changing their identity
* Create and resume supported native sessions
* Send prompts through the provider protocol
* Cancel work when the provider exposes cancellation
* Read provider events and native diffs when available
* Read approved local project files with traversal and size protection
* Store work evidence and verification results
* Route directed messages through a durable local conversation record

The shared conversation record is not a shared native transcript. Each provider keeps its own context. A message sent through the coordinator is recorded with a sender, recipient, reply link, and delivery receipt. A queued receipt means that transport accepted the message. It does not mean that the provider completed the task.

## Requirements

The runtime supports Windows macOS and Linux.

Use Node 20 through Node 26. The published package includes the native PTY dependency required by Freebuff CLI mode.

Freebuff support requires one of these local installations.

* Freebuff Desktop installed and signed in
* Freebuff CLI installed and signed in
* Both may be installed. Desktop is preferred unless CLI mode is explicitly selected.

The other providers have their own requirements.

* OpenCode requires the OpenCode CLI; the runtime can start and manage a local server automatically
* Codex requires the Codex app server command
* Claude Code requires the Claude ACP executable
* Cursor requires the Cursor agent ACP command

The runtime never fabricates an available provider. Run the doctor command to see the exact reason for an unavailable provider.

## Install from npm

The simplest installation uses pnpm.

```text
pnpm add --global agent-interop-runtime
agent-interop-runtime doctor
```

You can also use the package without a global install.

```text
pnpm dlx agent-interop-runtime@0.3.1 doctor
pnpm dlx agent-interop-runtime@0.3.1 serve
```

The version is pinned in the examples so a host does not silently change behavior during startup. Update the version deliberately after reviewing a release.

## Configure a local MCP client

Build from source when developing the project.

```text
pnpm install
pnpm build
node dist/src/cli.js doctor
```

The local Codex configuration uses this shape.

```toml
[mcp_servers.agent_interop]
command = 'node'
args = ['C:\path\to\agent-interop-runtime\dist\src\cli.js', 'serve']
enabled = true
```

The installer can add or repair this entry.

```text
pnpm dlx agent-interop-runtime@0.3.1 install
pnpm dlx agent-interop-runtime@0.3.1 install --write
```

The write command preserves unrelated Codex configuration, makes one backup, uses an atomic replacement, and refuses malformed existing content. Set `CODEX_HOME` when Codex uses a nonstandard configuration directory.

Restart the local MCP client after changing its configuration.

The installer is explicit by design. npm installation does not change a user configuration through a postinstall hook.

## Freebuff Desktop

Desktop mode is selected automatically when the local orchestrator can be reached.

The runtime discovers the current loopback port from supported readiness files, local logs, and local process data. It then calls the local projects route.

```text
GET /api/projects
```

Writes require the current launch authorization header.

```text
x-freebuff-launch-id
```

The runtime searches local readiness and log locations for the current launch ID. It verifies the ID through the local health route before registering mutation tools. If Desktop rotates the ID, a rejected request triggers a fresh discovery and one safe retry. If the ID cannot be verified the runtime remains read only.

The connection is refreshed before every Desktop write. Capability results are cached only briefly. A restart can therefore change both the loopback port and the launch ID without requiring an MCP restart. The event stream uses the same refreshed connection when it reconnects after an authorization failure.

For a controlled deployment the readiness file can be supplied with `FREEBUFF_DESKTOP_READINESS_FILE`. The file must contain a loopback URL or port and a current launch ID. Records older than ten minutes are ignored.

Desktop messaging uses the local route below.

```text
POST /api/thread/<thread id>/message
```

This is local communication with the running Desktop process. It is not a public relay.

Desktop progress uses the local event stream when the installed Desktop exposes it. Progress is bounded and cursor based. A stale or unavailable stream does not erase the saved thread data.

## Freebuff CLI

Use explicit CLI mode when you want the bridge to own a managed Freebuff terminal session.

Set these variables in the MCP server environment.

```text
FREEBUFF_MCP_CLI_MODE=pty
FREEBUFF_CLI_PATH=/absolute/path/to/freebuff
FREEBUFF_PROJECT_ROOT=/absolute/path/to/project
```

The CLI mode requires the native `node-pty` dependency. Recent npm versions block dependency install scripts until explicitly allowed; when using npm to install the package, approve this dependency with `npm install --global --allow-scripts=node-pty agent-interop-runtime`.

On Windows the path may point to `freebuff.exe`. On macOS and Linux it must point to an executable file. The runtime also checks the normal user local installation locations for each operating system.

CLI mode always wins over Desktop discovery.

The startup probe uses the same native PTY library as real sessions. It reports the Node version, operating system, and node pty version. A failed probe disables CLI writes and explains the failure. It never reports fake success.

The current package uses node pty `1.2.0-beta.15`. If a machine reports a PTY startup failure, run the following from the project or reinstall the package so the native dependency is rebuilt for the active Node runtime.

```text
pnpm rebuild node-pty
pnpm pty:probe
```

Freebuff CLI readiness accepts current full screen terminal markers after removing terminal control sequences. A future CLI can provide a custom regular expression through `FREEBUFF_CLI_READY_PATTERN`.

CLI history is read from the local Freebuff history directory. A selected conversation ID is passed back to Freebuff when the bridge resumes it. The bridge never substitutes the newest conversation for a requested ID.

## Provider setup

Use the doctor command before testing messages.

```text
agent-interop-runtime doctor
```

OpenCode connects to an existing local server when one is running. If none is reachable, Agent Interop starts `opencode serve` automatically on a free loopback port, waits for `/global/health`, and reuses the managed server. If that server exits or is disconnected, the next request starts a replacement and rediscoveries sessions. Set `OPENCODE_AUTO_START=false` to disable this behavior.

You can still start it manually:

```text
opencode serve --hostname 127.0.0.1 --port 4096
```

Set `OPENCODE_SERVER_URL` for another local port. Remote OpenCode requires HTTPS plus `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`. The default username is `opencode` when only a password is configured. Plain HTTP on a non-loopback endpoint is refused unless `OPENCODE_ALLOW_INSECURE_REMOTE=1` is deliberately set for a trusted private network.

Codex requires its app server to be installed and discoverable. Claude requires `claude-code-acp`. Cursor requires the `agent` command with ACP support. Provider credentials and client approvals remain user actions.

Model selection, agent selection, and reasoning selection are separate controls. A provider capability report identifies which controls are real. OpenCode model selection is a next prompt override using `providerID` and `modelID`. OpenCode native session model mutation is not advertised because the validated server API does not provide that operation.

## Toolset profiles

Profiles now gate both read and write schemas. This keeps irrelevant MCP definitions out of the model context instead of merely hiding mutation tools.

```text
INTEROP_TOOLS_PROFILE=minimal  # native provider discovery/control/events only
INTEROP_TOOLS_PROFILE=core     # minimal + work, evidence, handoffs, claims, reviews, conversations
INTEROP_TOOLS_PROFILE=freebuff # Freebuff project/thread/file/model tools only
INTEROP_TOOLS_PROFILE=legacy   # core + the complete Freebuff-specific surface
INTEROP_TOOLS_PROFILE=full     # every tool (default, compatibility surface)
```

The stdio server accepts the same values through `--profile`. Read-only mode (`INTEROP_READ_ONLY=1`) composes with every profile. CI includes a catalog-budget check so narrow profiles cannot silently grow back toward the full schema surface.

## Coordination and resumable handoffs

Version 0.3 adds durable coordination primitives above the native provider transports.

* `work_create` can declare work dependencies.
* `claim_acquire`, `claim_list`, and `claim_release` provide atomic file, directory, interface, and workspace claim state with leases. Conflicting exclusive claims are rejected by the runtime. Claims coordinate cooperative agents; they do not intercept filesystem writes performed outside this runtime.
* `handoff_create` can carry continuation state, latest validation, assumptions, rollback notes, a recommended next action, and a repository revision while still obeying the configured handoff token budget.
* `handoff_update_status` records an explicit created → accepted → applied → verified → completed lifecycle, with blocked and superseded states.
* Evidence records receive SHA-256 content hashes and can be fetched individually with `evidence_get`. Review requests send bounded handoff packets and evidence references instead of re-inlining an arbitrarily large diff.
* `events_page` adds a registry-owned monotonic cursor, reconnect epoch, and retention-gap metadata while `events_read` remains available for compatibility.
* HTTP MCP clients share one process-wide provider backend so multiple client sessions do not spawn duplicate native provider processes.

Structured handoff notes are historical evidence, not ground truth. Successor agents should verify important claims against the repository and current provider state.

## Benchmarks

An offline two-provider benchmark harness measures fixed handoff tasks end to end: payload bytes, token estimates (js-tiktoken `o200k_base` — an offline estimate, not native provider usage), and duplicate-delivery counters for events, messages, and provider sends.

```text
pnpm bench
```

The harness runs entirely in memory against the real store and registry contracts; no live provider is contacted and no usage or dollar savings are claimed.

Handoff packets are measured against a token budget (`INTEROP_HANDOFF_TOKEN_BUDGET`, default 2,000). The durable record keeps every field; the delivery packet lists oversized fields as explicit omissions with instructions for requesting them. CI runs the same harness as a gate (`pnpm bench:check`) and fails on any duplicate event/message delivery or duplicate provider send.

## Shared conversations

Create a local conversation and attach exact provider sessions.

```text
conversation_create
conversation_join
conversation_send
conversation_read
```

Messages are directed. Broadcast is not implicit. The coordinator limits transcript size, stores delivery receipts, and requires an explicit new action for every reply. This prevents accidental recursive agent loops.

The coordinator is local. It does not grant a provider permission to edit a workspace. Provider permissions remain controlled by the provider and the user.

## Safety behavior

Read only mode is used when authorization or provider control is unavailable.

The runtime redacts credential shaped fields and bounds diagnostic output. File access is restricted to approved project roots. Protected credential files are denied. Large files are rejected. Local verification is disabled unless `INTEROP_ALLOW_VERIFICATION=1` is explicitly set. Verification requires an explicit workspace or a work item linked to a native session with a verified workspace, rejects command working directories that escape that root, and removes credential-shaped environment variables before spawning checks.

HTTP mode binds to loopback by default and requires a bearer token. Canonical HTTP settings use `AGENT_INTEROP_HTTP_TOKEN`, `AGENT_INTEROP_HTTP_HOST`, `AGENT_INTEROP_HTTP_PORT`, `AGENT_INTEROP_HTTP_ALLOWED_ORIGINS`, and `AGENT_INTEROP_HTTP_ALLOW_REMOTE`; the older `FREEBUFF_MCP_*` names remain compatibility aliases. Remote binding requires an explicit opt in and trusted HTTPS or private-network protection. Origin checks, request limits, idle session cleanup, and MCP session cleanup are enabled.

## Verification

Run the local checks below.

```text
pnpm typecheck
pnpm test
pnpm lint
pnpm mcp:validate
pnpm audit --prod --audit-level high
pnpm build
pnpm pty:probe
pnpm pack:check
```

GitHub Actions runs lint, type checking, tests, build, MCP metadata validation, catalog-budget checks, benchmark checks, and package creation on Ubuntu, macOS, and Windows with Node 22. The package engine range remains Node 20 through Node 26; broader runtime compatibility can be exercised separately from the release gate. Live provider authentication is environment dependent.

## What is not promised

This package does not promise a single native chat transcript across providers. It does not wake an idle provider application without host support. It does not install provider applications or create provider credentials. It does not claim live four provider cooperation until that exact combination has been run with authenticated providers and recorded evidence.

## Project status

The repository is public and welcomes compatibility reports, provider additions, and reproducible bug reports. The package is designed for local use and safe degradation. Freebuff Desktop and CLI are both supported paths when installed and authenticated. OpenCode Desktop/server discovery, managed server startup, disconnect recovery, session rediscovery, and per-prompt reasoning variants have been exercised locally. The correct test is `doctor`, followed by provider session discovery, followed by a unique nonce message in the selected native session.
