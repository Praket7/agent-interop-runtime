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

* OpenCode requires a running local OpenCode server
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
pnpm dlx agent-interop-runtime@0.2.9 doctor
pnpm dlx agent-interop-runtime@0.2.9 serve
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
pnpm dlx agent-interop-runtime@0.2.9 install
pnpm dlx agent-interop-runtime@0.2.9 install --write
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

OpenCode needs its local server.

```text
opencode serve --hostname 127.0.0.1 --port 4096
```

Set `OPENCODE_SERVER_URL` for another local port. Remote OpenCode requires `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`. The default username is `opencode` when only a password is configured.

Codex requires its app server to be installed and discoverable. Claude requires `claude-code-acp`. Cursor requires the `agent` command with ACP support. Provider credentials and client approvals remain user actions.

Model selection, agent selection, and reasoning selection are separate controls. A provider capability report identifies which controls are real. OpenCode model selection is a next prompt override using `providerID` and `modelID`. OpenCode native session model mutation is not advertised because the validated server API does not provide that operation.

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

The runtime redacts credential shaped fields and bounds diagnostic output. File access is restricted to approved project roots. Protected credential files are denied. Large files are rejected. Local verification is disabled unless `INTEROP_ALLOW_VERIFICATION=1` is explicitly set.

HTTP mode binds to loopback by default and requires a bearer token. Remote binding requires an explicit opt in and trusted network protection. Origin checks, request limits, idle session cleanup, and MCP session cleanup are enabled.

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

GitHub Actions runs the same checks on Ubuntu macOS and Windows. The matrix also tests Node 20 22 24 and 26. The PTY probe is an environment check. It proves that the native PTY can start on that runner. It does not prove that Freebuff is installed or signed in on that runner.

## What is not promised

This package does not promise a single native chat transcript across providers. It does not wake an idle provider application without host support. It does not install provider applications or create provider credentials. It does not claim live four provider cooperation until that exact combination has been run with authenticated providers and recorded evidence.

## Project status

The repository is private while compatibility evidence is collected. The package is designed for local use and safe degradation. Freebuff Desktop and CLI are both supported paths when installed and authenticated. The correct test is `doctor`, followed by provider session discovery, followed by a unique nonce message in the selected native session.
