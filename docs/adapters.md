# Adapter guide

## Freebuff

Freebuff remains the source adapter. Desktop discovery uses fresh readiness data, platform logs, and listener probing. Desktop writes require a verified launch ID handshake. CLI mode uses a managed PTY and reads persisted visible history.

## OpenCode

Start the native server with `opencode serve` and set `OPENCODE_SERVER_URL` when needed. The adapter uses the documented session routes for list, create, prompt, async prompt, abort, permissions, and diff. It listens to the server event stream and filters events by exact session identity.

## Codex

The adapter starts `codex app-server` when available and initializes through JSON RPC. It uses `thread/list`, `thread/start`, `thread/resume`, `turn/start`, and `turn/interrupt`. Native notifications are returned as provider events. The adapter does not scrape a terminal or expose hidden reasoning.

## Claude Code

The adapter uses a configured ACP command, defaulting to `claude-code-acp`. It initializes ACP with file reading and terminal capabilities, uses `session/new`, `session/list`, `session/load`, `session/prompt`, and `session/cancel`, and applies model and thought level changes through ACP configuration methods when the agent advertises them. ACP history remains provider owned. A session list is available when the configured Claude ACP executable exposes `session/list`.

Run `pnpm pty:probe` when Freebuff CLI startup reports `posix_spawnp failed`. The probe spawns the platform shell equivalent of `/bin/echo` through node pty. The package pins the release containing the macOS spawn helper permission fix. A failure indicates a native runtime or executable permission problem, not a Freebuff login result. Rebuild node pty with `pnpm rebuild node-pty` using the supported Node runtime and retry.

## Cursor

Cursor uses the same Agent Client Protocol family through the `agent acp` command. The adapter performs Cursor login when the initialization response advertises `cursor_login`. It preserves Cursor session identifiers, creates and resumes sessions when the provider advertises those methods, sends prompts, cancels work, and maps the requested agent value to Cursor mode. Model and mode controls remain provider negotiated and failures are returned instead of being simulated.

The setup command writes the Cursor MCP configuration without deleting unrelated servers. Use the global path for all projects or the project path for one workspace.

## Configuration

Useful environment settings include `OPENCODE_SERVER_URL`, `CODEX_APP_SERVER_COMMAND`, `CLAUDE_ACP_COMMAND`, `INTEROP_STATE_FILE`, and the existing Freebuff settings documented in the root README.
