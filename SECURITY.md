# Security policy

Please report security issues through [GitHub private vulnerability reporting](https://github.com/Praket7/agent-interop-runtime/security/advisories/new). Do not include credentials, tokens, cookies, or private source code in a public issue. Maintainers will coordinate disclosure and publish fixes and advisories when appropriate.

## Security model

- Stdio is the default transport and stays on the local machine.
- Optional HTTP binds to `127.0.0.1` by default.
- Every `/mcp` request requires a bearer token. `AGENT_INTEROP_HTTP_TOKEN` is canonical; `FREEBUFF_MCP_TOKEN` remains a compatibility alias.
- Non-loopback binding is refused unless `AGENT_INTEROP_HTTP_ALLOW_REMOTE=1` (or legacy `FREEBUFF_MCP_ALLOW_REMOTE=1`); when enabled, use trusted HTTPS or a private network.
- `/healthz` is unauthenticated only for loopback health checks; remote health checks require the bearer token.
- Desktop mutations require a dynamically discovered launch ID and successful `/healthz` verification. Otherwise mutation tools are not registered.
- CLI writes use a bridge-owned PTY and do not take over an existing CLI process by default.
- Project paths are confined to the configured root, unsafe identifiers are rejected, and credentials are never returned or logged.
- Local verification is disabled unless `INTEROP_ALLOW_VERIFICATION=1` is explicitly set. Verification requires an explicit or provider-verified workspace, refuses command cwd escapes, runs without a shell, bounds output/time, and removes credential-shaped environment variables. Enable it only for a trusted local MCP client and repository.
- Durable workflow state is written with owner-only permissions on Unix-like systems. It can contain source-derived evidence, so protect the configured state directory.

## Authorization for local verification

The project authorizes the following opt in for trusted Codex work sessions

```toml
[mcp_servers.agent_interop.env]
INTEROP_ALLOW_VERIFICATION = '1'
```

Keep this unset for read-only analysis sessions. This setting authorizes local verification commands only. It does not authorize remote HTTP access, provider mutations, or credential access.

This project has not undergone an independent security audit. Treat remote HTTP exposure as an advanced deployment and review the configuration before enabling it.

## Provider endpoint boundaries

Remote OpenCode endpoints require HTTPS and authentication by default. HTTP is accepted automatically only for loopback. `OPENCODE_ALLOW_INSECURE_REMOTE=1` weakens that boundary and should be used only on a network you control. Provider and Freebuff discovery requests reject HTTP redirects so a loopback credential cannot be forwarded to a redirected host.

## Coordination claims

Resource claims provide atomic coordination state and reject conflicting exclusive claims made through Agent Interop. They are not a kernel or filesystem sandbox. Providers and external processes can still mutate files outside this protocol, so use worktrees, containers, or another filesystem isolation boundary when untrusted or strongly isolated execution is required.
