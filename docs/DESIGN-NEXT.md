# OK Computer: Design for Phases 2–4

This document extends [DESIGN.md](DESIGN.md). Phase 1 is built and running. Everything here adds to it; nothing here replaces a Phase 1 rule unless it says so. The conventions in DESIGN.md section 21 apply to all new code.

Research for this document was done on 2026-10-13. Versions and prices are from that date; check them again before you pin a dependency.

## 0. Goals

1. Connect Computer to everything the owner uses: all Gmail accounts, Google Calendar, Slack DMs in every workspace, web search, a browser for sites without an API, and the owner's Claude history.
2. Keep **full observability**. For every new capability, record exactly what the agent saw, what it decided, which policy allowed it, and what happened. Nothing that reaches the model or leaves the machine is unrecorded.
3. Give the agent more power safely: a permission system with a reviewer model, taint tracking for untrusted content, a real sandbox for code, and sub-agents with fixed limits.
4. Make Telegram pleasant: formatted replies, streaming, reactions, and clear approval cards.

## 1. New principles

These add to DESIGN.md section 2.

1. **The trace is complete.** Each model call stores the exact request (system, messages, and the tool list it offered) and the exact response. Each tool call stores the raw result, the text the model received after wrapping and truncation, the policy decision, and any approval. Each MCP server, browser step, and sandbox command stores its own detail. Large payloads go to the blob store (section 2.1), never get dropped.
2. **The tool list is stable within a session.** Changing the tool list changes the prompt prefix, which breaks prompt caching and invalidates thinking blocks. Integrations are reached through a fixed set of discovery tools (section 3.4), so new servers and tools never change the `tools` parameter in the middle of a session.
3. **Risk comes from our config, not from the server.** MCP tool annotations such as `readOnlyHint` are hints. The policy engine (section 5) decides.
4. **Outside text is tainted.** When a run reads untrusted content (email, Slack, web, calendar invites from others, Claude history), the run is tainted. Tainted runs cannot take outbound actions without the owner's approval.
5. **Least privilege everywhere.** Minimal OAuth scopes, per-session tool profiles, sandboxed code, a dedicated browser profile.
6. **Prefer maintained existing servers, but own the sensitive paths.** Use official or well-maintained MCP servers where they fit. Write our own integration where the data is most sensitive or no server fits (Gmail across 8 accounts, unsubscribe).

## 2. Observability v2 (cross-cutting, built first)

### 2.1 Blob store

- Content-addressed files under `data/blobs/ab/cd/<sha256>` with a `blobs` table: `hash, size, mime, createdAt`.
- Every payload over 8 KB (tool outputs, MCP messages, page snapshots, screenshots, sandbox output, rendered requests) is stored as a blob. Rows hold the hash plus a short preview.
- Redaction runs before hashing, so a secret never reaches a blob.
- Blobs are never deleted automatically. The dashboard shows total size. A later `okc prune` command can remove blobs older than a chosen age that no row references.

### 2.2 New and extended tables

- `tool_catalog_snapshots`: `hash, tools (json), createdAt`. The exact tool list offered to the model. `model_calls` gets a `toolCatalogHash` column, so every call shows which tools existed.
- `tool_calls` gains:
  - `source`: `builtin`, `mcp`, `google`, `browser`, `sandbox`, or `subagent`;
  - `serverId` and `account`;
  - `riskLevel`;
  - `policyDecisionId`;
  - `tainted`: whether the run was tainted at call time;
  - `rawResultBlob`: the result before wrapping and truncation, when it differs from the exact model view in `output` (2.5);
  - `truncated`, `resultHandle`, and `outcome` (2.5).
- `policy_decisions`: `id, toolCallId, decision (allow | review | approve | deny), rule, reviewerModelCallId, reviewerVerdict, reviewerReason, approvalId, createdAt`.
- `mcp_messages`: every JSON-RPC message per server: `serverId, direction (out | in), method, rpcId, payloadBlob, latencyMs, createdAt`. This includes `tools/list` results and notifications. The run id is set when the message belongs to a tool call.
- The tables below are the plan for later milestones. Each one is created by the migration of the milestone that writes it (2.5).
- `browser_steps`: `taskId, runId, toolCallId, action, target, urlBefore, urlAfter, snapshotBlob, screenshotBlob, consoleErrors, blockedRequests, createdAt`. Plus one Playwright trace zip per browser task.
- `sandbox_execs`: `runId, toolCallId, command, cwd, network (none | allowlist), exitCode, stdoutBlob, stderrBlob, filesChanged, durationMs`.
- `integration_events`: polled changes (new mail, calendar changes, Slack DMs) with `source, account, externalId, kind, summary, payloadBlob, seenAt`.
- `subagent_runs`: `parentRunId, childRunId, profile, task, resultSummary`.

### 2.3 Dashboard additions

- **Run timeline, nested.** A model call leads to its tool calls. Each tool call opens to show:
  - the policy decision and reviewer verdict;
  - the approval;
  - the execution detail: MCP messages, browser steps with a screenshot filmstrip, or sandbox output;
  - child sub-agent runs.
- **"What the model saw" per tool result.** Show the raw result next to the exact wrapped and truncated text that the model received.
- **Integrations page.** Each server and account with:
  - status and last error;
  - tool list and the catalog snapshot history;
  - auth state and token expiry;
  - polling status;
  - buttons to connect, reconnect, and pause.
- **Browser page.** Tasks with replay (screenshots and snapshots per step) and a download link for the Playwright trace.
- **Policy page.** Recent decisions, holds, denials, and the rules file.
- **Signals page.** Integration events and what the heartbeat did with them.

### 2.4 Acceptance

For any run, the dashboard can reconstruct, byte for byte, every input the model received and every action the system took, including actions inside MCP servers (as far as the protocol shows them), the browser, and the sandbox.

### 2.5 Decisions from phase 2 M1

- **Blob store.** `src/observability/blobs.ts` stores text only. `put` redacts and hashes the text. It writes the file to a temporary name and renames it, so a crash never leaves a short file under the hash, and it writes the file again when it is missing or damaged. The row is one `INSERT ... ON CONFLICT (hash) DO NOTHING`, so several processes can put the same text at the same time. There is no `refCount` (it counted puts, not references, and nothing read it); a later prune finds the blobs that no row names. A read checks the hash of the bytes and throws when it does not match, so a damaged file is an explicit error and never wrong text. There is no fsync: a hash check on read already turns a torn file into an error, and fsync costs 3 to 4 ms per put. A hash must match `^[0-9a-f]{64}$` before a read, so a URL cannot reach a path outside the store. Binary blobs (screenshots) come with the milestone that needs them.
- **The row keeps the model view.** `tool_calls.output` is the single exact model view, as JSON. It is always short (a long result becomes a preview), so it needs no blob. `rawResultBlob` holds the text the tool gave only when the model got other text: a preview, or a wrapped untrusted text. The read rule is **raw result = `rawResultBlob ?? output.content`**. Both texts go through the same redaction. Migration 006 drops `modelViewBlob`, which was a byte-for-byte copy of `output`. In the seeded test database this makes 1 blob file instead of 6. The 8 KB rule of 2.1 applies to the later payloads (MCP messages, snapshots). Every call gets a row, also an unknown tool, invalid input, a denied call, and a call that waits for approval.
- **Model calls.** `model_calls.request` keeps the full request, tool list included. The tool list also goes to `tool_catalog_snapshots` (hash of the JSON of the `ToolSpec` list), and `toolCatalogHash` links the call to it. Rendered requests do not move to blobs yet.
- **Tables for later milestones.** A table comes with the milestone that writes it. Migration 004 created the other tables of 2.2 early, and M2 had to rebuild `mcp_messages` (migration 005). Migration 006 drops `browser_steps`, `sandbox_execs`, `integration_events`, and `subagent_runs`, which no code writes, and `tool_calls.costUsd`, because no tool costs money now (search runs through Chrome). `mcp_messages` has a `toolCallId`. `policy_decisions` also has `runId`, `toolName`, and `reason` (the text the agent gets). `tool_calls` also has `untrustedSource`.
- **One tool caller.** `src/tools/caller.ts` is the only path that runs a tool for the model: resolve, policy, review or approval, execute, model view, record. The registry no longer has an approval gate, and it has no method that runs a tool without the policy (the old `registry.run` skipped deny rules); unit tests use `runTool` from `test/run-tool.ts`. An approved call runs through `callApproved`, gets the `policyDecisionId` of the original decision, and is recorded on the original run.
- **Policy order.** A deny rule always wins. A tool with `needsApproval` always asks the owner. In a tainted session an `external` call always asks the owner, also when a rule allows it. Otherwise the last matching allow rule wins, and without a rule the risk level decides. The taint rule for `write` is the default review of `write`; an allow rule for a `write` tool also holds in a tainted session, so give such a rule only to tools that keep data on the PC.
- **Rules.** Code has built-in allow rules for the Phase 1 tools that change only local data (goals, automations, memory, heartbeat, consolidation, `message_owner`). `okc.policy.json` (optional, next to `okc.config.json`) adds rules after them: `{ "rules": [{ "tool", "session"?, "args"?, "effect": "allow" | "deny", "note"? }] }`. Patterns use `*` and ignore case; an `args` key matches a top-level input field, and an object value matches against its JSON text. When the value is a list, an `allow` rule must match every item, and a `deny` rule matches when any item (or the JSON text of the list) matches, so one good recipient cannot carry a bad one. The matcher is linear (it goes back only to the last `*`), because a regular expression with several stars took 18 s on an 800-character argument that the model controls; it folds case like a regular expression with the `i` flag, so a non-ASCII character such as the Kelvin sign never matches an ASCII letter. A rule with an unknown key (for example `arg`) is invalid. An invalid file stops the process at start. The rule id is `builtin:<tool>` or `okc.policy.json#<n>`.
- **Reviewer.** `Reviewer` is a type; the engine takes it as an optional dependency. Until Phase 3 M3 there is none, so a `review` decision becomes an owner approval, and the decision row says so in `reason`.
- **Taint scope.** Taint covers the session since its last `session_reset`, not only the run, because the model still sees untrusted text in later runs of the same session. The sources come from `tool_calls.untrustedSource`. A tool marks its output as untrusted with `ToolOutput.untrustedSource`; the caller then wraps it with `wrapUntrusted`. Calls in the same model turn are decided before any of them runs, which is correct: the model wrote them before it saw any result.
- **Handles.** A raw result over 4,000 characters becomes its first and last 1,500 characters (never cutting a surrogate pair), wrapped when untrusted, then a note outside the wrapper with a handle `res_` plus 12 hex characters. `result_read { handle, query?, from?, length? }` pages by character offset or finds passages around each query word, at most 3,500 characters, so its own output never needs a handle; it wraps text again when the source was untrusted, so reading it taints the session too. `result_read` is in the main and automation tool lists, not in heartbeat or consolidation sessions. A result that compaction clears keeps its handle, and summary validation counts handles as identifiers.
- **Dashboard.** The run timeline nests each tool call inside the model call that asked for it. A tool call shows its decision, rule, risk, taint, and handle, and it opens to the raw result (from the blob) next to the exact model view, and to the policy decision with the reviewer verdict and approval. A model call shows the tool count and opens to its catalog snapshot. New routes: `/api/blobs/:hash` and `/api/tool-catalogs/:hash`. The overview shows the blob store size.

## 3. Integration layer

### 3.1 MCP client

- Use `@modelcontextprotocol/client` v2 (2.3.x), the stable TypeScript SDK line for MCP spec 2026-07-28. Do not use the v1 `@modelcontextprotocol/sdk`.
- Transports: `StdioClientTransport` for local servers (it uses cross-spawn, so `npx` works on Windows) and `StreamableHTTPClientTransport` for remote servers.
- One `McpConnection` per configured server. It handles:
  - start and stop;
  - health checks with `ping`;
  - restart with backoff;
  - stderr capture to the log;
  - a `listChanged` handler that marks the catalog as stale.
- Every request and response goes through one wrapper that writes `mcp_messages`.
- Support elicitation: form mode becomes a Telegram or dashboard prompt, and url mode becomes a link to open. Do not implement sampling (deprecated in the 2026-07-28 spec).

### 3.2 Integration registry

`okc.integrations.json` (non-secret, committed with safe defaults) lists each integration:

```json
{
  "id": "slack-work",
  "kind": "mcp-http",
  "url": "https://mcp.slack.com/mcp",
  "auth": { "type": "oauth", "clientRef": "slack-work-app" },
  "tools": { "allow": ["search_messages", "read_conversation", "send_message"] },
  "risk": { "send_message": "external" },
  "untrustedOutput": true,
  "sessions": ["main", "auto", "sub:inbox"]
}
```

- `kind`: `mcp-stdio` (with a pinned `command` and `args`; never `@latest`), `mcp-http`, or `builtin` (our own in-process integrations such as Google).
- Tools not in `allow` are invisible. Every exposed tool gets a risk level from this file. Its default is `write` when the server says `readOnlyHint` and `external` otherwise.

### 3.3 Secrets and OAuth

- Store tokens and API keys in the Windows Credential Manager through `@napi-rs/keyring`. It ships prebuilt binaries and needs no build tools. The database stores only a reference.
- OAuth flows use a loopback callback server on `127.0.0.1:4318/oauth/callback`. Start a flow from the dashboard Integrations page. Validate `state` (the MCP SDK does not) and finish with `transport.finishAuth`.
- The owner completes OAuth on the PC itself, or over a remote desktop. A phone cannot reach the loopback callback.
- Expiry and revocation are visible. Warn the owner in Telegram when a refresh fails, with a link to reconnect.

### 3.4 Tool exposure: stable list plus discovery

The model sees three groups of tools:

1. **Core tools**, always present: the Phase 1 tools plus `result_read`, `delegate`, and the discovery pair below.
2. **Pinned integration tools**, chosen per session profile in config and namespaced as `<integration>__<tool>` (for example `google__gmail_search`). A short list of the tools the profile uses most. They are fixed for the life of a session.
3. **Discovery**, for everything else:
   - `tool_search { query, limit }` returns matching tools with name, description, and input schema, within a budget (16 KB total, 1 KB per description).
   - `tool_call { name, arguments }` validates the arguments against the stored schema, runs the tool through the policy engine, and returns its result.

The `tools` parameter therefore never changes inside a session. A changed server catalog takes effect at the next session or the next run start, and is recorded as a new catalog snapshot.

**Schema normalization.** Translate each schema to what the provider accepts:
- Anthropic takes JSON Schema almost unchanged.
- The OpenAI-compatible adapter dereferences `$ref` and simplifies `oneOf` and `anyOf` for local models.
- Tool names must match `^[a-zA-Z0-9_-]{1,64}$`. Keep a map from each name back to its server and tool.

### 3.5 Large results and handles

- When a result is over 4,000 characters, the model gets a preview (head and tail) and a handle such as `res_7f3a`.
- `result_read { handle, query? , from?, length? }` searches or pages through the stored result.
- Results that compaction cleared keep their handles, so the agent can look up old detail without stale content in context.

### 3.6 Polling and signals

- Integrations poll on schedules (Gmail and Calendar every 15 minutes, Slack DMs every 15 minutes) as system automations. Polling is code, not a model call.
- New items become `integration_events`. A cheap classification pass on the `utility` slot labels each one: `needs_reply`, `deadline`, `event_change`, `newsletter`, `noise`.
- The heartbeat gets a bounded digest of unhandled signals (at most 20, newest first) instead of raw tool access. It decides whether to tell the owner and marks signals handled.
- Detectors written in code, each with tests:
  - "an email mentions a date and it is not on the calendar";
  - "a calendar event starts in under 2 hours";
  - "a DM has been unread for over 4 hours".

## 4. Integrations

### 4.1 Google: Gmail (all accounts) and Calendar

**Decision:** a built-in integration that uses the `googleapis` npm package. Gmail is the most sensitive data, no maintained server handles 8 accounts with the scopes and tools we want, and none has a real unsubscribe tool.

- **One OAuth client.** One Google Cloud project with one OAuth client of type "Desktop app". Set the consent screen to "In production" without verification; for personal use the owner clicks "Advanced → continue" once per account. This avoids the 7-day refresh-token expiry of Testing mode. Verify that a token still works after 8 days.
- **Scopes:**
  - `gmail.readonly` and `gmail.modify`;
  - `gmail.send` only when the owner turns on sending;
  - `calendar.events` and `calendar.readonly`;
  - never the full `https://mail.google.com/` scope.
- **Accounts.** Each account has an alias (`personal`, `school`, `work1`…). Every tool takes `account` (an alias, or `all` for read tools).
- **Gmail tools:**

  | Tool | Risk |
  |---|---|
  | `gmail_search` | read |
  | `gmail_read_thread` | read |
  | `gmail_list_labels` | read |
  | `gmail_draft` | write |
  | `gmail_archive`, `gmail_label`, `gmail_mark_read` | write; the reviewer checks them |
  | `gmail_send` | external; approval |
  | `gmail_unsubscribe` | external; approval. Uses the `List-Unsubscribe` header: RFC 8058 one-click POST, or mailto through `gmail_send` |

- **Calendar tools:**

  | Tool | Risk |
  |---|---|
  | `calendar_list_events` | read; all accounts merged |
  | `calendar_freebusy` | read |
  | `calendar_create_event` | write; external with approval if it invites other people |
  | `calendar_update_event`, `calendar_delete_event` | external; approval |

- **Sync.** Gmail uses the `history.list` API with a stored `historyId` per account, so each poll fetches only changes. Calendar uses `syncToken`.
- **Token health.** A token can die when the account password changes, after 6 months unused, or when more than 100 tokens exist per client. Detect the failure, alert the owner, and never re-authorize in a loop.
- **Alternatives** if a built-in path becomes too much work:
  - `nspady/google-calendar-mcp` (TypeScript, multi-account);
  - `taylorwilsdon/google_workspace_mcp` (broad, Python);
  - Google's official Workspace MCP servers (developer preview, no send tool).

### 4.2 Slack (every workspace, including DMs)

- **Primary:** the official remote server at `https://mcp.slack.com/mcp`. For each workspace, the owner creates an internal Slack app and authorizes it as a **user**, which gives a user token. A bot token cannot read the owner's DMs. Pre-register each app's client id and secret in our OAuth provider (the server has no dynamic registration).
- **Scopes:** `im:history`, `mpim:history`, `im:read`, `channels:history` (only if wanted), `search:read`, `users:read`, and `chat:write`.
- **Internal apps** are exempt from the 2025 history rate limits for non-Marketplace apps.
- **Fallback:** `korotovsky/slack-mcp-server` with a user token from the same internal app. Its send tool is off by default.
- **Risk:** sending is `external` and needs approval. Reading is `read` and taints the run.

### 4.3 Web search and fetch

No paid search API. The owner has Chrome on this PC, and search runs through it.

- `web_search { query, engine? }`: the browser worker (section 4.4) opens the engine's results page in the agent's Chrome profile and extracts the result list (title, URL, snippet) from the page. The default engine is Google. DuckDuckGo's HTML results page is the fallback when Google shows a CAPTCHA or a consent wall. Keep the volume personal-scale (a few searches per task), and back off when an engine shows a CAPTCHA. A self-hosted SearXNG container is an optional extra later; it is also free.
- `web_fetch`: a local fetch with readability extraction, a 20,000-character limit, results through handles, and `wrapUntrusted`. Pages that need JavaScript or a login go through the browser instead.
- **Exfiltration guard.** In a tainted run, a fetch URL that contains data from the run (long query strings, encoded text) goes to the reviewer.

### 4.4 Browser

**Decision:** Playwright as a library, in-process (`playwright` 1.64.x). It runs the installed Chrome (`channel: 'chrome'`) with a dedicated persistent profile at `data/browser/profile`. This is the owner's real Chrome program with a separate profile, so pages, search engines, and logins behave like normal browsing. The owner's everyday profile, with banking and every other session, stays out of reach. The library gives the hard controls we need: a route-level domain allowlist, a screenshot and accessibility snapshot after every action, and Playwright tracing. These are things the MCP server flags do not enforce as a security boundary.

- **Tools**, shaped like the snapshot-based browser tools models already know:
  - `browser_open(url)`
  - `browser_snapshot`
  - `browser_click(ref)`
  - `browser_type(ref, text)`
  - `browser_select(ref, value)`
  - `browser_back`
  - `browser_screenshot`
  - `browser_extract(instructions)`: returns text through a handle.
- **Browser worker.** Browser work runs in a sub-agent with the `browser` profile (section 6), so page content never floods the main conversation. The worker returns a summary.
- **Allowlist.** Each task gets a domain allowlist: the start domain plus domains the owner approved. Navigation outside it is blocked, and the block is recorded.
- **Profile hardening:**
  - password saving and every kind of autofill are off;
  - downloads go to `data/browser/downloads`;
  - the owner logs in to the sites the agent may use by running the browser in headed mode (`okc browser login`).
- **Risk:** navigation and reading are `read` (they taint the run). Typing into fields and clicking are `write` (the reviewer checks them). Submitting a form that sends, buys, or posts is `external`, with approval and a screenshot in the approval card.
- **Later:** a supervised "use my real Chrome" mode through `chrome-devtools-mcp --autoConnect`. Chrome then asks the owner to allow each session, so this mode needs the owner at the PC.

### 4.5 Claude history

There is no official API or MCP server for claude.ai history.

- **Claude Code.** A watcher tails `~/.claude/projects/**/*.jsonl`, including `subagents/`. It stores the byte offset per file, parses complete lines only, dedupes by `uuid`, redacts secrets, and indexes text, tool names, and titles into an FTS5 `history` index. `@anthropic-ai/claude-agent-sdk` (`listSessions`, `getSessionMessages`) can backfill. Unknown entry types are kept but not indexed.
- **claude.ai.** The owner requests the data export (Settings → Privacy → Export data) and drops the ZIP into `data/inbox/`. A job unzips it, parses `conversations.json` (plus `projects.json` and `memories.json` when present), and upserts by uuid.
- **Tools:** `history_search { query, source?, since? }` and `history_get { id }`. Results are wrapped as untrusted, because old transcripts contain web and tool output.
- **Retention.** Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). The owner should raise it in `~/.claude/settings.json`. The index keeps its own copy either way.

### 4.6 Later integrations

GitHub (official server, read-only toolsets first), Notion (official remote server with OAuth), Google Drive (built-in Google integration, `drive.readonly`). Banking is out of scope until there is a safe read-only path.

## 5. Permissions, review, and sandboxing

### 5.1 Policy engine

Every tool call, built-in or integration, goes through `decide(call, ctx)`, which returns one of four decisions:

| Decision | Effect |
|---|---|
| `allow` | Runs now |
| `review` | A reviewer model checks the exact action first |
| `approve` | The owner must approve with a button (Phase 1 approvals) |
| `deny` | Does not run; the agent gets the reason |

The decision depends on:

1. **Static rules** in `okc.policy.json`: patterns on tool name and arguments, with allow or deny. The last matching rule wins. Example: allow `google__gmail_archive` for senders in a newsletter list.
2. **Risk level**:
   - `read`: allow;
   - `write`: review;
   - `external`: approve.
3. **Taint.** If the run is tainted, `external` always needs approval, and `write` actions that carry run data outward go to review.
4. **Session profile.** A heartbeat or sub-agent can be stricter than the main session.

### 5.2 Reviewer model

The reviewer is a separate call on the `utility` slot. It sees:
- the exact tool call;
- the owner's last request in this run;
- a list of untrusted sources that entered the run;
- the policy reason.

It returns `allow` or `hold` with a reason. A hold does not run the tool. The agent gets the reason and can change course or ask the owner. Every review is a `model_calls` row linked from `policy_decisions`.

### 5.3 Comparison with fx, and what we take

| | fx | OK Computer |
|---|---|---|
| Default mode | `auto`: routine actions run, others go to a reviewer model | Risk levels plus static rules, reviewer for `write`, owner approval for `external` |
| What the reviewer catches | Prompt injection and malicious actions; the action is held | Same, plus our taint rule: outbound actions after untrusted input always need the owner |
| OS isolation | None; commands run in the owner's login shell | Code runs in a Docker sandbox; no host shell by default |
| MCP | Lazy schemas through capability search | Same idea: `tool_search` and `tool_call`, with a stable tool list for caching |
| Large outputs | Stored out of context; preview plus a read tool | Same: handles and `result_read` |
| Sub-agents | Inherit permissions; cannot spawn further | Same rules, plus explicit tool profiles and their own trace |
| Owner in the loop | Rarely; holds go back to the agent | Approvals by Telegram button for anything that leaves the machine |

We take fx's reviewer, lazy MCP schemas, output handles, and sub-agent limits. We do not embed fx itself: on Windows its library runs only as WebAssembly, without process or filesystem access, and it lacks our scheduler, channels, and tracing.

### 5.4 Sandbox for code and shell

**Decision:** one long-lived Docker container, `okc-sandbox`, through Docker Desktop (on Windows it runs through WSL2).

- **Container settings:**
  - non-root user;
  - `--cap-drop ALL` and `--security-opt no-new-privileges`;
  - memory, CPU, and process limits;
  - read-only root filesystem;
  - a Linux-side volume `okc-work` mounted at `/work`;
  - no host folders mounted.
- **Network** is off by default (`--network none`). A call can ask for network. That request goes to review, and the container then reaches the internet only through a host-side proxy with a domain allowlist.
- **Tools:**
  - `sandbox_exec { command, timeout?, network? }`: output through handles;
  - `sandbox_write_file` and `sandbox_read_file` (inside `/work` only);
  - `sandbox_put_file`, which copies a file the owner shares into `/work`.
- **For pure computation on Claude models**, the adapter can offer Anthropic's server-side code execution tool instead. It has no internet, runs on Anthropic's servers, and is free when web search is in the same request. It is a per-slot option, off by default.
- **No host shell by default.** A `host_exec` tool for PowerShell exists only behind a config switch, and every call needs approval.
- **Tradeoffs considered:**
  - A WSL2 distro would be faster but mounts the C: drive and runs Windows programs unless hardened.
  - Windows Sandbox is not available on Windows Home.
  - Anthropic's `sandbox-runtime` on native Windows is still alpha.
  - Remote sandboxes (E2B, Daytona, Modal) are strong but cost money and send data off the PC.
  - Docker is the best balance for one PC.

## 6. Sub-agents

- `delegate { profile, task, budget? }` starts a child run in a fresh session `sub:<runId>`.
- Profiles in config define the tool set, the model slot, the iteration limit, and the domain allowlist. The first profiles:
  - `browser`: browser tools, `web_fetch`, `result_read`.
  - `research`: `web_search`, `web_fetch`, `history_search`, `memory_search`.
  - `inbox`: Gmail read tools, labeling with review, and the `batch` slot for bulk triage.
  - `code`: sandbox tools.
- Children cannot delegate (depth 1). They inherit the parent's taint and are stricter where their profile says so.
- The child's final text is the tool result, through a handle when long. The full child trace links to the parent in `subagent_runs` and in the dashboard timeline.
- At most 3 children run at once per parent. A child that hits its budget stops and reports what it has.

## 7. Telegram v2

- **Formatted replies.** Send with `sendRichMessage` and a `markdown` field (Bot API 10.1+, up to 32,768 characters). Telegram then renders the model's normal Markdown: bold, lists, headings, code blocks, tables, and quotes.
  - If grammY has no typed method yet, call it through `bot.api.raw`.
  - Fallback for errors: convert Markdown to Telegram HTML with a small mdast walker and `parse_mode: "HTML"`, and split at 4,096 characters, never inside a tag.
- **Streaming.**
  - Start each reply with `sendMessageDraft` and empty text, which shows "Thinking…".
  - Update the draft as text arrives, with `can_stop: true` so the owner can stop a reply.
  - Finish with `sendRichMessage`.
  - Handle the `stopped_message_generation` update by stopping the run.
- **Acknowledgement.** Put a 👀 reaction on each owner message when the run starts and change it to ✅ at the end. Send a `typing` action every 4 seconds during long tool work.
- **Approval cards.**
  - a one-line summary;
  - an expandable blockquote with the exact arguments;
  - a screenshot for browser actions;
  - Approve and Deny buttons, plus "Always allow this" (adds a static rule, after a second confirmation).
- **Commands menu** (`setMyCommands`): `/new`, `/status`, `/goals`, `/approvals`, `/dashboard`, `/stop`.
- **Later, a Mini App.** The dashboard opens inside Telegram through a Tailscale Serve URL, which works only while the phone's Tailscale is connected. The server must verify `initData` with the bot token and the owner id.

## 8. Remote access

- **Dashboard over Tailscale.** Share the dashboard through Tailscale Serve, keep it bound to `127.0.0.1`, and set `DASHBOARD_TOKEN`.
- **Owner on another device.** The dashboard checks the token on every API call and on the event stream. A browser session cookie stores the token after one login.
- **OAuth callbacks** stay on loopback (section 3.3).

## 9. Model and context changes

- **Tool catalog hash.** Every request records the hash of the tool list it offered (section 2.2).
- **Reviewer and classifier calls** use the `utility` slot. Cost shows per slot as before.
- **Taint in context.** A run's taint state and its sources go into the `context` event, so the model knows when it is working with untrusted input.
- **Compaction** keeps result handles in its summary's `facts and identifiers` section, so the agent can reopen old results.
- **Local models.** The `batch` slot can point to an Ollama model for inbox triage once the owner wants that. The schema normalizer (section 3.4) makes the integration tools usable there.

## 10. Phases and milestones

Each milestone is one implementer agent, named `phase<N>_milestone<M>_<word>` in `/resume`. Each must meet its acceptance criteria with tests that never call real services; real-service checks are manual smoke scripts.

### Phase 2: foundation and the owner's core accounts

| Milestone | Scope | Done when |
|---|---|---|
| **M1 trace** | Blob store; new tables (2.2); `toolCatalogHash`; `modelViewBlob`; result handles and `result_read`; policy engine with rules, risk, taint, and decisions (reviewer stubbed); nested run timeline and "what the model saw" per tool result | A seeded run with a large tool result shows the preview the model got, the handle, the full blob, and the policy decision, all in the dashboard |
| **M2 mcp** | MCP client v2 wrapper with `mcp_messages`; integration registry; keyring secrets; OAuth loopback flow; `tool_search` and `tool_call`; schema normalization; Integrations page | A test MCP server (in-memory and stdio) can be connected, searched, and called; every JSON-RPC message is in the trace; the `tools` parameter stays byte-stable across a session when the server's catalog changes |
| **M3 google** | Built-in Google integration with Gmail for N accounts and Calendar; history and sync-token polling; signals and detectors; heartbeat digest; send, unsubscribe, and event invites through approvals | With a mocked Google API: polling creates signals, the heartbeat tells the owner about a deadline missing from the calendar, unsubscribe needs approval, and tokens never appear in logs or blobs |
| **M4 telegram** | Rich messages, streaming drafts, reactions, typing, approval cards, commands menu; dashboard token and cookie for Tailscale | With a mocked Bot API: a Markdown reply goes out as a rich message, a long reply streams and then saves, an approval card shows the arguments, and the stop button stops a run |

### Phase 3: more reach

| Milestone | Scope | Done when |
|---|---|---|
| **M1 slack** | Slack through the official MCP server (OAuth with a pre-registered client per workspace); DM polling into signals; send through approval | With a fake MCP server shaped like Slack: DMs become signals, and sends need approval |
| **M2 web** | `web_search` through Chrome (Google, DuckDuckGo fallback), `web_fetch`, the browser worker with Playwright, allowlists, step screenshots, trace zips, and the Browser page | Against a local test site: every step has a screenshot and snapshot, off-list navigation is blocked and recorded, and a form submit needs approval |
| **M3 review** | Reviewer model, taint propagation, exfiltration guard, `delegate` with profiles, sub-agent traces | A tainted run cannot send without approval; the reviewer holds an injected action in a fixture; child runs show in the parent timeline |
| **M4 history** | Claude Code transcript watcher and index, claude.ai export import, `history_search` and `history_get` | Fixture transcripts and an export ZIP are indexed with secrets redacted, and results are wrapped as untrusted |

### Phase 4: power tools

| Milestone | Scope | Done when |
|---|---|---|
| **M1 sandbox** | Docker sandbox container, `sandbox_*` tools, network proxy with allowlist, optional Claude code execution per slot | With Docker available: commands run as non-root with no network, network needs review, and output goes through handles |
| **M2 sweep** | Subscription sweep: the `inbox` sub-agent triages mail across accounts on the `batch` slot, proposes an unsubscribe list, and runs it after one approval of the whole list | With a mocked Gmail: the list is grouped by sender, one approval runs all unsubscribes, and each run is traced |
| **M3 workshop** | Skill Workshop: after long or corrected tasks, a review proposes a new or changed skill, and the owner approves it in Telegram | A fixture task produces a skill draft, and only approval writes it to `skills/` |

## 11. What the owner sets up

These steps need the owner's own accounts. The implementer writes a guide in `docs/setup/` for each one.

1. **Google** (Phase 2 M3): create a Google Cloud project, turn on the Gmail and Calendar APIs, create a "Desktop app" OAuth client, and set the consent screen to "In production". Then connect each Gmail account from the dashboard. Takes about 10 minutes.
2. **Slack** (Phase 3 M1): one internal app per workspace with the user scopes in section 4.2. The owner may need admin approval in a workspace they do not own.
3. **Browser logins** (Phase 3 M2): run `okc browser login` once and sign in to the sites the agent may use, in the agent's own Chrome profile.
4. **Docker Desktop running** (Phase 4 M1).
5. **Tailscale** on the PC, phone, and laptop (any time).
