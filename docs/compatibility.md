# Compatibility

| Provider or surface | Discovery | Create and resume | Send and cancel | Events | Native diff | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Freebuff Desktop | Working | Resume working | Working after launch verification | Working through SSE | Not exposed by current bridge | Read only without launch authorization |
| Freebuff CLI | Working | Managed PTY | Working for bridge owned sessions | PTY progress | Repository fallback | Uses the preserved Freebuff runtime |
| OpenCode | Working when server is reachable | Working | Working through HTTP | Working through event stream | Working | Set `OPENCODE_SERVER_URL` for a non default port |
| Codex App Server | Working when `codex app-server` responds | Working through thread start and resume | Working through turn start and interrupt | Live JSON RPC notifications | Not standardized | Native model and permission operations remain provider dependent |
| Claude ACP | Working when the configured ACP command is available | Working through session new and load | Working through session prompt and cancel | Live JSON RPC notifications | Not standardized | Authentication and provider command remain user environment dependent |
| Cursor | Working when `agent acp` is available | Working through ACP session new and load when advertised | Working through ACP session prompt and cancel | Live JSON RPC notifications | Not standardized | Cursor authentication and model controls remain provider negotiated |

Unavailable providers degrade to an explicit unavailable capability record. A provider executable being present does not imply that authentication or protocol initialization succeeded.

## Verification classes

The repository contains unit tests for normalization and security, mock protocol tests for Codex and Claude, workflow tests, deterministic verifier tests, and graceful degradation checks. Live provider tests are environment dependent and must be run only when the corresponding provider is installed and authenticated.
