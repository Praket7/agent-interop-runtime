# Provider guide

Each provider keeps its own login and permissions. The runtime uses the provider interface available on the local computer. Run `agent-interop-runtime doctor` to see what is available on your machine.

## Freebuff Desktop

The runtime connects to the running Desktop app through its local interface. It checks the current launch identifier before adding write tools. If the check fails, the connection stays read only.

## Freebuff CLI

CLI mode starts a managed terminal session. Set `FREEBUFF_MCP_CLI_MODE=pty`, `FREEBUFF_CLI_PATH`, and `FREEBUFF_PROJECT_ROOT` in the MCP server environment. The native `node-pty` package must work with your Node version. Run `pnpm pty:probe` from a source checkout when startup fails.

CLI mode takes priority when selected. It does not use a Desktop session as a substitute.

## OpenCode

OpenCode uses its server API. A local server can be started automatically on loopback. Set `OPENCODE_SERVER_URL` to select another endpoint. Set `OPENCODE_AUTO_START=false` to turn off managed startup.

Remote servers require HTTPS plus `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`. Plain HTTP on a remote address is refused unless `OPENCODE_ALLOW_INSECURE_REMOTE=1` is set on a trusted private network.

The runtime can list sessions, create a session, send a prompt, request cancellation, read events, collect a diff, and answer a permission request. The server must support the requested action. A lost response to a change request is reported as `delivery_unknown`. The runtime does not retry that request.

## Codex

The runtime starts `codex app-server` when available. It can list, create, resume, prompt, and interrupt threads through the app server protocol. Native events are available while the process remains connected.

## Claude Code

The runtime uses `claude-code-acp` by default. Set `CLAUDE_ACP_COMMAND` to use another executable. Session listing, loading, cancellation, model selection, and reasoning controls depend on features advertised by that executable.

## Cursor

The runtime uses the Cursor `agent acp` command. It can sign in when Cursor advertises its login method. Session actions and model controls depend on the installed command.

## Readiness

Discovery only confirms that a provider answered a discovery request. It does not prove that the account is authenticated, that every operation works, or that a model completed a task.

The local automated tests use simulated provider responses. The project has seen a Freebuff GLM 5.3 Flash response. An OpenCode Big Pickle prompt was accepted, but its completion was not observed. These results describe those individual sessions only.
