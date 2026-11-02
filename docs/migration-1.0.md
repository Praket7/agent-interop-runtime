# Move from 0.3.x to 1.0

Version 1.0 keeps the previous tools available through the `legacy` profile, and new connections start with a focused nine-tool profile. The modern profiles use names that begin with an action, while the old profile remains available for clients that call a tool by its exact 0.3.x name.

To keep an existing client working while you update its instructions, start the server with the compatibility profile.

```sh
npx -y agent-interop-runtime@1 serve --profile legacy
```

If your client cannot pass command arguments, set `INTEROP_TOOLS_PROFILE=legacy` in the server environment. After updating the tool names in the client, switch to `minimal`, `core`, `freebuff`, or `full` depending on the features it uses.

## Tool name changes

The table lists every 0.3.x tool name and its modern name. Names that are unchanged remain as shown, and the legacy profile continues to expose every original name.

| 0.3.x name | Modern name |
| --- | --- |
| `agent_cancel` | `cancel_session` |
| `agent_send` | `send_session_message` |
| `claim_acquire` | `acquire_claim` |
| `claim_list` | `list_claims` |
| `claim_release` | `release_claim` |
| `conversation_create` | `create_conversation` |
| `conversation_join` | `join_conversation` |
| `conversation_list` | `list_conversations` |
| `conversation_read` | `read_conversation` |
| `conversation_reconcile` | `reconcile_conversation_sends` |
| `conversation_send` | `send_conversation_message` |
| `events_page` | `read_session_events` |
| `events_read` | `read_session_events` |
| `evidence_get` | `get_evidence` |
| `evidence_list` | `list_evidence` |
| `freebuff_status` | `get_runtime_status` |
| `get_active_work` | `get_active_work` |
| `get_agent_diff` | `get_session_diff` |
| `get_thread` | `get_thread` |
| `get_thread_messages` | `get_thread_messages` |
| `get_thread_progress` | `get_thread_progress` |
| `get_thread_progress_summary` | `get_thread_progress_summary` |
| `get_work_graph` | `get_work_graph` |
| `handoff_create` | `create_handoff` |
| `handoff_packet` | `get_handoff_packet` |
| `handoff_update_status` | `update_handoff_status` |
| `list_agent_sessions` | `list_agent_sessions` |
| `list_agents` | `list_providers` |
| `list_models` | `list_models` |
| `list_project_files` | `list_project_files` |
| `list_projects` | `list_projects` |
| `list_threads` | `list_threads` |
| `permission_pending` | `list_pending_permissions` |
| `permission_respond` | `respond_to_permission` |
| `read_project_file` | `read_project_file` |
| `resume_thread` | `resume_thread` |
| `review_create` | `create_review` |
| `review_request` | `request_review` |
| `send_message` | `send_thread_message` |
| `session_create` | `create_session` |
| `session_resume` | `resume_session` |
| `session_set_model` | `set_session_model` |
| `session_set_reasoning` | `set_session_reasoning` |
| `set_model` | `set_thread_model` |
| `set_reasoning` | `set_thread_reasoning` |
| `stop_thread` | `stop_thread` |
| `watch_active_threads` | `get_thread_progress_summary` |
| `watch_thread` | `get_thread_progress` |
| `work_create` | `create_work` |
| `work_get` | `get_work` |
| `work_list` | `list_work` |
| `work_verify` | `verify_work` |

## Combined progress and event tools

Use `get_thread_progress` to read a Freebuff thread's progress, and pass `timeoutMs` when you want it to wait for updates; this replaces `watch_thread` while keeping the same response type. Use `get_thread_progress_summary` with a `threadId` for one thread, or leave that field out to summarize all active threads; this replaces `watch_active_threads`.

Use `read_session_events` for native provider events, and pass the returned sequence cursor on the next request to continue from where you left off. The old `events_read` returned an array, while the modern event tool returns a bounded page with a cursor and information about missed or expired events, so clients should process its cursor fields rather than expecting the older array shape.

Freebuff thread progress and native provider events are separate sources, so use `get_thread_progress` for Freebuff Desktop activity and `read_session_events` for provider event history.

## Choose a profile

| Profile | Tools | Contents |
| --- | ---: | --- |
| `minimal` | 9 | Provider discovery, native sessions, events, and common session actions. |
| `core` | 30 | The minimal surface plus shared conversations, work records, handoffs, evidence, reviews, and claims. |
| `freebuff` | 16 | Freebuff project, thread, file, progress, model, and message controls. |
| `full` | 49 | Every modern tool from the core and Freebuff catalogs. |
| `legacy` | 52 | Every original 0.3.x tool name and operation. |

Read only mode can be used with each profile, and it hides operations that change provider or coordination state. Use `INTEROP_READ_ONLY=1` in the server environment to enable it.
