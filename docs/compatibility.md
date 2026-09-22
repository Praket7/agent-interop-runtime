# Compatibility

| Provider or surface | Discovery | Create and resume | Send and cancel | Events | Native diff | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Freebuff Desktop | Working | Resume working | Working after launch verification | Working through SSE | Not exposed by current bridge | Read only without launch authorization |
| Freebuff CLI | Working | Managed PTY | Working for bridge owned sessions | PTY progress | Repository fallback | Uses the preserved Freebuff runtime |
| OpenCode | Working when server is reachable | Working | Working through HTTP | Working through event stream | Working | Non-loopback endpoints require HTTPS and credentials by default |
| Codex App Server | Working when `codex app-server` responds | Working through thread start and resume | Working through turn start and interrupt | Live JSON RPC notifications | Not standardized | Model and reasoning can be selected per turn through `turn/start` |
| Claude ACP | Working when the configured ACP command is available | Working through session new and load | Working through session prompt and cancel | Live JSON RPC notifications | Not standardized | Authentication and provider command remain user environment dependent |
| Cursor | Working when `agent acp` is available | Working through ACP session new and load when advertised | Working through ACP session prompt and cancel | Live JSON RPC notifications | Not standardized | Cursor authentication and model controls remain provider negotiated |

Unavailable providers degrade to an explicit unavailable capability record. A provider executable being present does not imply that authentication or protocol initialization succeeded.

## Verification classes

The repository contains unit tests for normalization and security, mock protocol tests for Codex and Claude, workflow tests, deterministic verifier tests, and graceful degradation checks. Live provider tests are environment dependent and must be run only when the corresponding provider is installed and authenticated.

## Coordination runtime

Version 0.3 adds provider-independent coordination above these adapter capabilities: durable work dependencies, atomic resource claim leases, content-addressed evidence, bounded structured handoffs, explicit handoff lifecycle state, reconnect-safe event pages, and workspace-contained verification.

These features do not imply that every provider exposes the same native controls. Capability reports remain authoritative. Resource claims reject conflicting claims made through Agent Interop but do not intercept edits made by an agent or process outside the runtime.
