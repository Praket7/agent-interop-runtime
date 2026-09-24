# How the pieces fit

Agent Interop Runtime is a small local service between an MCP client and coding agents installed on the same computer.

The MCP client asks the runtime to find a provider session or send it work. The runtime uses that provider's own local interface. The provider still owns its account, conversation, permissions, and project access.

The runtime stores shared work notes separately. These notes can name an owner, record a handoff, link evidence, or show a check result. They do not become part of a provider's private conversation unless the runtime sends them there.

## A message has a clear outcome

The runtime saves a message before sending it. It records whether the provider accepted it. Acceptance does not mean the agent completed the task.

If a connection fails after a request may have reached the provider, the result is marked `delivery_unknown`. The runtime does not send the message again on its own. You can inspect the provider session before deciding what to do.

## Sessions keep their provider identity

Each session keeps the provider's own identifier. OpenCode sessions remain tied to the server that exposed them. The runtime does not silently move a session to another server after a failed request.

One provider can be unavailable while another still works. The doctor report shows each provider separately.

## Shared notes are cooperative

Work records can track dependencies. Resource claims can help agents avoid editing the same file at once. A claim only coordinates tools that use this runtime. Another program can still change the file.

Handoffs can include a goal, checks, assumptions, rollback notes, and a next step. The receiver should confirm important claims against the current project.

## Verification runs trusted commands

Verification is off by default. When enabled, each command runs without a shell. The runtime resolves the workspace and requested working folder through the filesystem, then refuses a symlink that escapes the workspace.

The working folder check is not a sandbox. A configured program can start other programs or change files. Only run checks from a source you trust.

## Local files

File reads stay within the selected project folder. Common credential files are blocked. Small text files are checked for common credential patterns. Binary content is refused. Secret detection is based on patterns, so it cannot find every possible secret.
