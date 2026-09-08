# Adapter guide

## Freebuff

Freebuff remains the source adapter. Desktop discovery uses fresh readiness data, platform logs, and listener probing. Desktop writes require a verified launch ID handshake. CLI mode uses a managed PTY and reads persisted visible history.

## OpenCode

Start the native server with `opencode serve` and set `OPENCODE_SERVER_URL` when needed. The adapter uses the documented session routes for list, create, prompt, async prompt, abort, permissions, and diff. It listens to the server event stream and filters events by exact session identity.

## Codex

The adapter starts `codex app-server` when available and initializes through JSON RPC. It uses `thread/list`, `thread/start`, `thread/resume`, `turn/start`, and `turn/interrupt`. Native notifications are returned as provider events. The adapter does not scrape a terminal or expose hidden reasoning.

## Claude Code

The adapter uses a configured ACP command, defaulting to `claude-code-acp`. It initializes ACP and uses `session/new`, `session/load`, `session/prompt`, and `session/cancel`. If the command is absent or initialization fails, capabilities are degraded with the exact reason.

## Configuration

Useful environment settings include `OPENCODE_SERVER_URL`, `CODEX_APP_SERVER_COMMAND`, `CLAUDE_ACP_COMMAND`, `INTEROP_STATE_FILE`, and the existing Freebuff settings documented in the root README.
