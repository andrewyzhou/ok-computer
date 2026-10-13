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
- **The row keeps the model view.** `tool_calls.output` is the single exact model view, as JSON. It is always short (a long result becomes a preview), so it needs no blob. `rawResultBlob` holds the text the tool gave only when the model got other text: a preview, or a wrapped untrusted text. The read rule is **raw result = `rawResultBlob ?? output.content`**, except that a preview, a wrapped text, or a late result without a blob lost its raw text in a failed blob write (see 2.8). Both texts go through the same redaction. Migration 006 drops `modelViewBlob`, which was a byte-for-byte copy of `output`. In the seeded test database this makes 1 blob file instead of 6. The 8 KB rule of 2.1 applies to the later payloads (MCP messages, snapshots). Every call gets a row, also an unknown tool, invalid input, a denied call, and a call that waits for approval.
- **Model calls.** `model_calls.request` keeps the full request, tool list included. The tool list also goes to `tool_catalog_snapshots` (hash of the JSON of the `ToolSpec` list), and `toolCatalogHash` links the call to it. Rendered requests do not move to blobs yet.
- **Tables for later milestones.** A table comes with the milestone that writes it. Migration 004 created the other tables of 2.2 early, and M2 had to rebuild `mcp_messages` (migration 005). Migration 006 drops `browser_steps`, `sandbox_execs`, `integration_events`, and `subagent_runs`, which no code writes, and `tool_calls.costUsd`, because no tool costs money now (search runs through Chrome). `mcp_messages` has a `toolCallId`. `policy_decisions` also has `runId`, `toolName`, and `reason` (the text the agent gets). `tool_calls` also has `untrustedSource`.
- **One tool caller.** `src/tools/caller.ts` is the only path that runs a tool for the model: resolve, policy, review or approval, execute, model view, record. The registry no longer has an approval gate, and it has no method that runs a tool without the policy (the old `registry.run` skipped deny rules); unit tests use `runTool` from `test/run-tool.ts`. An approved call runs through `callApproved`, gets the `policyDecisionId` of the original decision, and is recorded on the original run.
- **Caller contract.** The provider refuses a `tool_use` without a `tool_result`, so one throw in the caller used to break every later request of the session until `/new`. `call` now never throws, and it follows one rule: **fail closed before the tool acts, fail open after it.**
  1. Before the tool acts: resolve, validate, compute the taint, decide, and write the decision row. If one of these throws, the tool does not run, the model gets "X did not run, because its policy check failed", and the log gets the error with `runId` and `toolCallId`.
  2. The decision row is written before the reviewer or the owner is asked, and their answers update it (`approvalId`, the verdict). So an approval never exists without its decision. If the approval request throws, the model is told that the call did not run, no approval row exists, and the decision's `reason` says why.
  3. A reviewer that throws sends the call to the owner; the turn goes on.
  4. The tool runs under the run's abort signal. If the run stops (timeout or shutdown) while a tool still runs, the call is **abandoned**: the model gets "did not finish … its effect is unknown, check before you try it again", and the row gets `outcome = 'abandoned'`. A stuck tool therefore cannot hold the session queue. If the tool finishes later, the same row gets `outcome = 'late'`, the raw result, a handle, and the source; the model view stays what the model saw. A `system_event` with the late result (and its taint, when untrusted) goes to the session through the queue, so the model does not repeat an action that worked. There are no per-tool timeouts. An approved call has no run, so it runs under the shutdown signal and the background run timeout, and is abandoned in the same way (see 2.6).
  5. After the tool acts: if the blob or row write throws, the error goes to the log with `runId` and `toolCallId`, and the model still gets the output. A gap in the trace is better than a second action. A failed blob write loses only the raw text; the row is still written (see 2.7).
  6. A tool that throws has its stack logged with `runId` and `toolCallId` (`ToolContext.toolCallId`); the model gets only the message.
  7. An approved call runs at most once: `callApproved` claims it with `UPDATE approvals SET startedAt = ? WHERE id = ? AND startedAt IS NULL AND status = 'approved'`, so an expired approval never runs. It does not claim when the signal already stopped, and it returns `started`, so the session note says "did not run" for a call that never started, and an expired claim says "expired", not "already ran". `resolveApproval` is a compare-and-set on `status = 'pending'` too, so a button and the dashboard cannot both win.
- **Session repair.** Each run starts with `repairSession` (`src/agent/recovery.ts`), inside the session queue. It gives each call of the last assistant turn that has no `tool_result` event a result, chosen from the trace: the recorded model view (with its `untrustedSource`) when the row exists; "the app stopped while X ran, it is unknown whether it finished" and a row with `outcome = 'interrupted'` when the decision let the tool start (`allow`, or `review` with a reviewer `allow`) but no row exists; otherwise "X did not run" (or "waits for approval #N"). The decision row is written just before the tool runs, so it serves as the intent record and no journal table is needed. When a user message holds both, tool results render before text: the provider requires this ("tool_result blocks must come FIRST in the content array", verified in the tool-use docs), and only a repaired result can follow a `system_event`. In a log without a repair no result follows text, so no earlier request changes.
- **Stale work.** A sweep runs at the start and on each scheduler tick. It closes only work older than the longest run timeout plus 5 minutes, because a run always ends at its timeout (a stuck tool is abandoned then): such runs become `aborted`; an approved call that never started becomes `expired`, does not run, and the session and the owner get "approved, but the app stopped before it ran, … ask again"; an approved call that started and has no row gets an `interrupted` row and the same two notes. The age test, not "everything from before this start", decides, because `npm run chat` can share the database with the live service, and its start must not close the service's live runs or expire its queued approvals. The sweep also skips the work that its own process holds in memory (the runs in `activeRuns` and the approvals in `flow.active`), whatever its age (see 2.6). The next run of each session repairs it; the sweep repairs only a session that belongs to one stale run (see 2.8). A pending approval that expires after 24 hours also sends a `system_event` to its session. Approved calls never run at start: an approval can be days old.
- **Outcome.** `tool_calls.outcome` stores only the three facts that a later read cannot find: `abandoned`, `late`, `interrupted` (null otherwise). Every other word is derived on read by the pure `outcomeOf` (`src/dashboard/outcome.ts`) from the row, its decision and its approval: `ran`, `failed`, `invalid`, `denied`, `held`, `waiting`, `approved`, `declined`, `expired`. A stored word for every state would need three writers (the caller, the approval flow and the expiry sweep) to stay in step. The run detail shows the word as a chip on each tool call, so a call that waits for the owner no longer looks like a success, and the policy view shows the decision's taint snapshot with a link to the run that read each source. `isError` is unchanged, because it controls what the model sees. `approved` is on the call that asked; the run after the approval is its own row, with its own word.
- **Two processes on one database.** There is no instance lease. Blob upserts and the compare-and-set claims (approvals, the automation claim, and the interrupted row of the sweep, see 2.8) keep the shared writes safe, and the sweep's age test protects live runs. One hazard stays: if both processes run the same session at the same moment, a run start in one can repair a call of a live turn in the other. Do not chat in the main session from `npm run chat` while the service answers there.
- **Known gaps after M1.**
  - A late result reaches the model only at the next run of its session, as a `system_event`, not in the turn that abandoned it.
  - A crash between an approved call's row and its `system_event` leaves the session without that result. The row exists, so the dashboard shows it.
  - Taint does not follow text through memory: a tainted session can write a daily note, and consolidation can lift it into `MEMORY.md`. Track this for Phase 2 M3, when untrusted mail arrives. Goal titles are the same kind of path: `goals_set` in a tainted session writes text that the volatile context of every later run shows. Automations and the heartbeat checklist carry their taint (see 2.6 and 2.7). The heartbeat prompt's "recent notifications" lines repeat old notification text without taint; the heartbeat has no external tools, so the impact is low.
  - `model_calls.request` stores each normalized request inline, so storage grows with the square of a session's length (about 14 MB for a simulated 60-turn session). A manifest of message hashes in the blob store would cut this by about 12 times; it belongs with the `okc prune` work.
  - The repair at run start reads the whole session once per run. The strategy already does this on every model call, so it is not the bottleneck.
- **Policy order.** A deny rule always wins. A tool with `needsApproval` always asks the owner. In a tainted session an `external` call always asks the owner, also when a rule allows it. Otherwise the last matching allow rule wins, and without a rule the risk level decides. The taint rule for `write` is the default review of `write`; an allow rule for a `write` tool also holds in a tainted session, so give such a rule only to tools that keep data on the PC.
- **Rules.** Code has built-in allow rules for the Phase 1 tools that change only local data (goals, automations, memory, heartbeat, consolidation, `message_owner`). `okc.policy.json` (optional, next to `okc.config.json`) adds rules after them: `{ "rules": [{ "tool", "session"?, "args"?, "effect": "allow" | "deny", "note"? }] }`. Patterns use `*` and ignore case; an `args` key matches a top-level input field, and an object value matches against its JSON text. An `allow` pattern must match the whole value, and when the value is a list it must match every item, so one good recipient cannot carry a bad one. This holds only for a list: on one free-text string a `*` also matches a comma or a `..` segment, so an allow pattern there checks only the start and the end, and a recipient or path field must be a list in the tool schema (see 2.9). A `deny` pattern matches anywhere in the value's text (the JSON text for a list or an object), so `*@evil.example` also stops `Eve <eve@evil.example>` and `eve@evil.example, a@home.example` (see 2.7). The matcher is linear (it goes back only to the last `*`), because a regular expression with several stars took 18 s on an 800-character argument that the model controls; it folds case like a regular expression with the `i` flag, so a non-ASCII character such as the Kelvin sign never matches an ASCII letter. A rule with an unknown key (for example `arg`) is invalid. An invalid file stops the process at start. The rule id is `builtin:<tool>` or `okc.policy.json#<n>`.
- **Reviewer.** `Reviewer` is a type; the engine takes it as an optional dependency. Until Phase 3 M3 there is none, so a `review` decision becomes an owner approval, and the decision row says so in `reason`.
- **Taint scope.** Taint covers the session since its last `session_reset`, not only the run, because the model still sees untrusted text in later runs of the same session. A tool marks its output as untrusted with `ToolOutput.untrustedSource`; the caller then wraps it with `wrapUntrusted`, and the `tool_result` event carries `untrustedSource`. Calls in the same model turn are decided before any of them runs, which is correct: the model wrote them before it saw any result.
- **Taint comes from the event log.** `sessionTaint` reads the session's events after the last `session_reset`, ordered by `seq`, never by time: the old query compared `tool_calls.createdAt` with the reset time, so a clock that moved back after `/new` made a tainted session look clean. The taint is what the model saw: `tool_result` events with `untrustedSource`, and `system_event`s with `taint`. A `system_event` that relays text from another session carries the taint of that session: an isolated automation's message to main, a heartbeat notification, the result of an approved call, and a late result (see the caller contract). Without this, untrusted text reached main untainted. Two partial indexes (`events_reset`, `events_taint`) keep the check at 0.03 ms for a 50,000-event session (31 ms without them); it runs before every tool call.
- **Taint provenance.** Each taint source is `{ source, toolName, runId, toolCallId, at }`: the first call that brought that source into the session, or into the session it was relayed from. `policy_decisions.taint` keeps a snapshot of it, so the reason for a decision survives `/new`. The approval message gives the policy reason and names each source with its tool, time, and run, because the taint often comes from an older run that the owner has forgotten.
- **Handles.** A raw result over 4,000 characters becomes its first and last 1,500 characters (never cutting a surrogate pair), wrapped when untrusted, then a note outside the wrapper with a handle `res_` plus 12 hex characters. `result_read { handle, query?, from?, length? }` pages by character offset or finds passages around each query word, at most 3,500 characters with the header, and the query has at most 200 characters, so its own output never needs a handle, also inside the longest wrapper; no cut splits a surrogate pair (see 2.8); it wraps text again when the source was untrusted, so reading it taints the session too. `result_read` is in the main and automation tool lists, not in heartbeat or consolidation sessions. A result that compaction clears keeps its handle, and summary validation counts handles as identifiers.
- **Dashboard.** The run timeline nests each tool call inside the model call that asked for it. A tool call shows its decision, rule, risk, taint, and handle, and it opens to the raw result (from the blob) next to the exact model view, and to the policy decision with the reviewer verdict and approval. A model call shows the tool count and opens to its catalog snapshot. New routes: `/api/blobs/:hash` and `/api/tool-catalogs/:hash`. The overview shows the blob store size.

### 2.6 Decisions from phase 2 M1, verification round 1

Three reviews (acceptance, failure injection, security) gave 18 findings: 14 distinct issues, because four were found twice. All were real, and each is fixed with a permanent test.

- **A deny rule wins in any order.** `decide` took the last matching rule, so a later allow rule cancelled an earlier deny rule, against the policy order above. Now any matching deny rule wins, then the last matching allow rule. The other option, "last match wins" with deny-then-allow exceptions, was rejected: a broad allow rule that the owner adds later must never open a recipient that a deny rule closed. A narrow allow rule without a broad deny gives the same exceptions, because the risk level is the default.
- **The sweep never closes the work of its own process.** The age test alone failed in the live process in three ways: an approved call that waited in its queue behind runs longer than the age limit was expired and then told "already ran"; a slow approved call was called interrupted while it ran, and its real row came second; and a forward clock jump (sleep, an NTP fix) aborted live runs. The options were an instance id with a heartbeat on each run and approval (a migration, a timer, and a lease), or the work that the process holds in memory. The memory sets were chosen: they are exact for the live process, which is the only process that the failures came from, and the age test still guards the work of a second process.
- **An approved call has a timeout.** It runs under `AbortSignal.any([shutdown, AbortSignal.timeout(backgroundTimeoutMs)])`, so a stuck approved tool is abandoned like a run tool and no longer holds its session queue. The timer starts when the call leaves the queue, not at the owner's click.
- **The decision links to its approval at creation.** `createApproval` writes the approval and `policy_decisions.approvalId` in one transaction, before the message to the owner. A crash during a slow message then leaves a decision that the repair reads as "waits for approval #N". `RequestApproval` now gets the decision id in `why` and returns only the output.
- **The owner sees every field.** The approval summary shows each top-level field on its own line. A value over 300 characters keeps its first 200 and last 100 characters with a mark that names the cut and points to the dashboard, so a short field after a long one (a channel, a recipient) is always visible. Values are redacted before the cut. The approvals page shows the full redacted input. Splitting the full input over several Telegram messages was rejected: the owner reads the card on a phone, and the fields that decide (recipients, channels) are short.
- **Taint follows text into automations and the heartbeat checklist.** An automation keeps the taint of the session that wrote its payload (`automations.taint`, migration 007), and a new payload replaces it. The first event of each run carries it, also for a main session after `/new`. The heartbeat checklist keeps its taint in a setting; the owner's checklist from the dashboard has none. The other option, no built-in allow for these tools in a tainted session, was rejected: it asks the owner for every routine that the agent sets up after it reads mail, and it does not cover a payload that was written before the taint.
- **Untrusted errors stay untrusted.** `Tool.untrustedOutput` names the source of every output of a tool, an error too, because an HTTP body or an MCP error can carry outside text. M2 integrations with `untrustedOutput: true` set it.
- **Redaction.** `registerSecret` adds one escaped form for each JSON level, up to four, so a secret with a quote stays hidden in json inside json. The caller redacts a result before the preview cuts it, so a secret on the cut is never stored in part.
- **Smaller fixes.** A thrown `null` or string no longer breaks `call` (`errorText`), and the late path of an abandoned tool logs its errors instead of an unhandled rejection. A tool call in a reply cut at the token limit gets a row (`caller.notRun`), so the timeline shows it as `invalid`. `result_read` limits its query to 200 characters.
- **Known residual.** An approved call that ran, but whose trace write failed (fail open), has `startedAt` and no row. After the age limit the sweep reports it as interrupted, which is wrong only in that rare case; the session already has the real result.

### 2.7 Decisions from phase 2 M1, verification round 2

Three more reviews gave 18 findings: 14 distinct issues (the backslash secret was found three times, the result search cost and automation taint twice each). All were real, and each is fixed with a permanent test.

- **Redaction works on strings, not on JSON text.** A registered secret that starts or ends with a backslash or a quote is a part of its own escaped form, so a replacement in finished JSON text could take one half of an escape. The payload was then invalid, `appendEvent` committed it before it failed, and the append-only log blocked the session for good. `redactedJson` now redacts each string leaf (and each key) in a `JSON.stringify` replacer, so its output is always valid. The escaped forms of round 1 stay, because a string can hold JSON text, and `redact` replaces the longest form first, so that inner JSON text also stays valid. The MCP recorder, the logger, and the approvals page (`redactValue` after the parse) use the same path. Round 1 tried a replacer alone and rejected it because it misses JSON inside JSON; the two together cover both.
- **Automation text keeps its taint.** The name of an automation is text that its runs and the volatile context of every run read, but only a new payload changed the taint, and a new payload also cleared it. Now a session that writes the name or the payload adds its taint, and the old taint stays until both fields get new text. This replaces "a new payload replaces it" of 2.6. A pause or a new schedule writes no text and adds no taint, so a pause from a tainted session does not make each later run need approvals. `automations_list` marks its output untrusted (with the sources of the listed automations) when one of them is tainted, and the volatile context replaces the name of a tainted automation with a fixed phrase. The other option, a taint on the volatile context, was rejected: it would taint every session while any tainted automation is pending.
- **Relayed text is wrapped.** The message that an isolated automation or the heartbeat sent to the owner goes to main inside `wrapUntrusted` when the run was tainted, and the id stands for a tainted automation name. `wrapUntrusted` also neutralizes `</system_event>` and `</note>` (and, since 2.8, the tags of a summary request), so wrapped text cannot close the message that holds it. A render-time wrap of every tainted `system_event` was rejected: approved and late results already hold a wrapper, and a second wrapper would remove their closing tag.
- **The handle limit applies to the wrapped view.** The test was on the raw text, so an untrusted result just under 4,000 characters had a wrapped view over the limit and no handle, and the trim of an old turn cut its middle for good. The source in the wrapper has a limit of 120 characters (the taint keeps it in full).
- **`result_read` search is one pass.** It made one span for each match of each word over the whole result: 1.3 s and 650 MB for 26 one-letter words over 8 MB, on the event loop of the live app. Now one alternation regex walks the text in order, merges spans as they come, closes a span at the read limit, and after the passages are full only counts up to 10,000 more matches ("more than N passages"). Dropping short words was rejected: a two-letter id is a fair query, and the scan limit already bounds the work.
- **A blob failure keeps the row.** `blobs.put` was a part of the row insert, so one failed write (EPERM from a scanner, a full disk) dropped the decision link, the input and the model view. Now the blob has its own try; the row gets `rawResultBlob = NULL`. A late result gets `late` also when its blob fails.
- **The caller does not wait past the run.** The request to the owner and the reviewer race the run's signal, as the tool does. After a stop the model gets "did not run … if the request reached the owner, the decision comes back as a system event", and a late error goes to the log. `ReviewRequest` has a `signal` for the model call of Phase 3.
- **Content that is not text.** The registry turns content that is not a string (an adapter bug) into text, so the caller cannot throw after a tool acted.
- **Compaction boundary.** A repaired result comes after the events that arrived while the process was down, so a boundary on such an event kept the result without its call. `chooseBoundary` now keeps the ids of the results whose call it did not reach and takes a boundary only when that set is empty. A render-time guard that drops an orphan result was not added: the boundary is the only place that can split a pair.
- **Approvals.** Each value in the summary is JSON text (with U+0085, U+2028 and U+2029 escaped too), so a line break cannot forge a field or a "Why:" line. When `owner.send` returns false, the model is told that the owner was not reached and the approval is on the dashboard. `resolveApproval` no longer expires approvals; an approval past 24 hours cannot be resolved ("expired … did not run"), and the next sweep expires it with its session note.
- **Deny patterns match anywhere.** An anchored deny pattern let `Eve <eve@evil.example>`, a trailing dot or space, an address list in one string, and an object list past `*@evil.example`. A deny rule now matches its pattern anywhere in the value's text. Allow rules stay anchored and per item. A deny rule that matches too much stops a good call; one that matches too little lets a bad call out.

### 2.8 Decisions from phase 2 M1, verification round 3

Three more reviews gave 19 findings, all real, each fixed with a permanent test. None was skipped.

- **No cut splits a surrogate pair.** `src/text.ts` has `safeStart`, `safeEnd`, `headOf` and `tailOf`. `result_read` pages and search passages, the trim of old results, the approval summary, the source in the wrapper, and the other cuts of text for the model use them. A lone half stays in the append-only log, and a provider can refuse each later request with it. A page that starts inside a pair starts at the next whole character, and the "use from N" note gives the adjusted end.
- **The wrapper keeps the length of the text.** A closing tag inside untrusted text keeps its characters, and its `<` and `>` become `[` and `]` (`</note>` becomes `[/note]`). The old replacement, "[removed closing tag]", was three times longer than `</note>`, so tag-dense text grew past the preview limit, and a tag without its `>` took all the text after it. The other option, a shorter fixed word, still loses the tag name. With the length kept, a wrapped text over the limit is always over 3,000 characters, so head and tail never overlap.
- **The search budget counts its frame.** The passages of a `result_read` search share `READ_LIMIT` with the header (with the query) and the last line, so the output stays under the handle limit inside a wrapper with the longest source.
- **The raw result after a failed blob write.** A preview, a wrapped text and a late result always get a blob, so such a row without one lost its raw text. The run page says so, and an abandoned or interrupted call says that the tool gave no result. A new column was not needed: the rule is exact for the rows that the caller writes.
- **Two more compare-and-set claims.** The automation claim updates only when `nextRunAt` is still the value that the tick read, so the service and `npm run chat` never both run a due job. The interrupted row of the sweep is an `INSERT ... WHERE NOT EXISTS`, and only the sweep whose insert writes the row sends the notes. A status for interrupted approvals was rejected: it adds a state that `outcomeOf` and the approvals page must learn.
- **Repair of sessions without a next run.** The sweep repairs the session of a stale run when the key ends with the run id (`auto:<id>:<runId>`, `heartbeat:<runId>`); no other process can have a live turn there. `/new` repairs main before the reset, and a failed repair does not stop `/new`. The repair handles each call on its own: a call that fails gets the "unknown whether it finished" text and a log line. `redactedJson(undefined)` is now `"null"`, so a call without arguments keeps its row. A shared session such as `consolidate:<day>` is left to its next run.
- **Process safety.** The channel callback catches a rejected `router.handle`, and the router replies to the owner when an approval fails. A tool source that is not text stays untrusted (`true` becomes the tool's `untrustedOutput` or its name).
- **Approvals.** A typed `/approve N` replies with the stored card and its buttons; only a button or the dashboard approves, and `/deny N` still denies at once. The assistant can send a false card through `message_owner` with the id of a real approval, so a command that runs the stored input without showing it is a confused-deputy path. A fixed prefix on `message_owner` text was rejected: the owner reads a phone notification, and a prefix does not stop a false card. Each approval note (denied, approved, expired, stale, interrupted) carries the taint snapshot of its decision and wraps the summary, because the summary is text that the model wrote. The card marks a field that the redaction changed ("the tool gets the real value") and a word that mixes Latin letters with letters of another script, with the code points. A built-in deny for an input with a registered secret was rejected: the model sees only redacted text, so the case is rare, and the mark lets the owner decide.
- **Redaction.** The slot runner redacts a provider error once for the row, the result, and the reply to the owner; `runAgent` redacts the run error; the caller redacts `untrustedSource` with the content.
- **Deny rules read normalized forms.** A deny rule also tests the NFKC form after percent decoding (with `。` and `｡` as `.`) and the `href` of each value that parses as a URL. Allow rules keep the raw text and the ASCII fold.
- **Compaction.** The wrapper also neutralizes `</conversation>`, `</previous_summary>` and `</summary>`, and the summary prompt asks to keep text from an untrusted block as quoted data with its source. Dropping identifiers that occur only in untrusted results was rejected: a meeting time in an email is often the fact the owner needs.
- **Known gaps after round 3.** A late result or an approval result of a per-run session goes to that session, which no run reads; it is not relayed to main. Main got the relay with the abandoned text, so it can still repeat the action.

### 2.9 Decisions from phase 2 M1, verification round 4

Three more reviews gave 12 findings. 11 are fixed with a permanent test. One (an allow pattern on one free-text string) is documented and pinned by a test, and its fix waits for the first tool with a path or a recipient field.

- **Deny rules test each string.** The JSON text of a list or an object escapes `\` and `"`, so a deny pattern with either one never matched a list item or an object field (`C:\Users\owner\.ssh` in `{ from: ... }`, `rm -rf "/"` in an argv list). A deny rule now tests the JSON text and each string leaf at any depth. Each form also gets a copy without default-ignorable characters (soft hyphen, zero width space, word joiner, byte order mark), before NFKC, and the `href` of each `http(s)://` URL in the text, not only of a value that is a URL as a whole. A deny that matches too much only stops a call.
- **Allow patterns on free text.** A `*` also matches a comma, `<`, a space or a `..` segment. So `*@home.example` allows `"eve@evil.example, bob@home.example"`, and `C:\notes\*` allows `C:\notes\..\Users\...`. A heuristic that refuses separators in the starred part was rejected: it breaks an allow rule on any free-text field (`text: *`). A typed rule (`email` splits, `path` resolves) is the planned fix, with the first tool that has such a field. Until then a recipient or path field must be a list in the tool schema; a test pins the limit.
- **Redaction.** The tool list snapshot is `redactedJson(tools)`, the same text as `request.tools`, so the hash also covers the redacted text. The decision store redacts `reason` and `reviewerReason` in one place, and the caller redacts the error of a failed reviewer before it goes on the card.
- **An abandoned approved call.** `callApproved` returns `abandoned`. The owner and the session read "the tool started, but it did not finish in time, so its effect is unknown", not "the tool failed". A late result also goes to the owner, who approved the call; the session gets it as before.
- **The trace is a record, not a data path.** The heartbeat and the consolidation read the successful calls of their run from the event log (`succeededCalls`), which the run cannot go on without. A lost `tool_calls` row no longer drops a notification or makes a saved consolidation run again. `recentNotifications` still reads the trace; it only gives the prompt a hint against repeats.
- **Limits.** The run timeouts are at most 2^31-1 ms, because Node sets a longer timer to 1 ms. A schedule time must be before the year 10000 and an interval at most 366 days, because the store compares ISO text and `+010000-...` sorts first; `nextRun` gives no run past that limit.
- **Untrusted sources.** Only a missing source or `false` means trusted output. An empty or blank source becomes the tool's `untrustedOutput` or its name.
- **Tool call ids.** The OpenAI-compatible adapter gives a new id to a call whose id an earlier call of the request has, or that has none. The trace, the decisions and the repair find a call by run and id. Changing the repair to match by position was rejected: the id is the key everywhere, so the source is the right place.
- **The approval card.** Invisible and direction characters show as `\u` codes with a mark; a variation selector and a joiner after an emoji stay. The script check runs on each run of text between spaces and JSON marks, so an address split by an invisible character and a host made only of look-alikes (`https://аррӏе.example`) get a mark. Escaping every non-ASCII character was rejected again, because accented names and other languages become hard to read; a sentence without Latin letters stays plain.
- **Known gaps after round 4.** An allow pattern on one free-text string (above). An id collision after a compaction inside one run is still possible with a server that numbers its calls, because the earlier call is no longer in the request. A punycode form of a URL host is not shown on the card.

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
- Support elicitation (deferred in M2, see 3.7): form mode becomes a Telegram or dashboard prompt, and url mode becomes a link to open. Do not implement sampling (deprecated in the 2026-07-28 spec).

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
   - `tool_search { query, limit }` returns matching tools with name, description, and input schema, within a budget (1 KB per description; the whole answer stays under the handle limit of 3.5, see 3.7).
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

### 3.7 Decisions from phase 2 M2

- **Discovery only.** M2 builds group 3 of 3.4 (`tool_search` and `tool_call`) and no pinned integration tools. The two tools have fixed text, so the `tools` parameter is byte-stable by construction, also across a `list_changed`, a crash and a reconnect. The allowed names of a session come from `okc.integrations.json`, never from a catalog. Without the file, no discovery tool is registered, so the prompt prefix of an app without integrations does not change. Pinned tools come with the milestone that needs them (M3), with a frozen spec per session.
- **Live catalog.** There is no catalog freeze per session or run. A new tool list shows in the next search, and a schema change between a search and a call gives an "invalid input" that names the new fields. Each changed list is a version in `tool_catalog_snapshots` + `integration_catalogs`. The last version of each server is loaded at start under the current allow list and risk map, so `tool_search` works before the server answers. An equal list reuses the compiled catalog. The names of hidden tools are not part of a version.
- **The registry unwraps `tool_call`.** `registry.resolve` turns `tool_call {name, arguments}` into the integration tool it names, before the policy. The decision, the approval card, the trace row and the outcome all name the real tool (`notes__add_note`), so `okc.policy.json` rules work on real names. Only the `tool_result` event keeps the model's own call. A built-in tool, a nested `tool_call`, and a name outside the session's allowed names are refused. A failed check is recorded under the named tool, with `source = 'mcp'` and its integration; its message can quote the server's schema, so for an untrusted integration it carries the tool's untrusted source and taints the session. The lookup takes the session key and reads the current config, so an approved call whose session lost the integration does not run, and an approval whose tool is gone says so. The repair at run start names the inner tool.
- **Names.** `<id>__<tool>` when that is a valid name; otherwise the cleaned name plus 6 hex characters of the SHA-256 of the original name. A name depends only on the id and the server's name, so an approval made days earlier cannot bind to another tool. A collision inside one server is refused at intake.
- **Search budget under `HANDLE_OVER`.** This replaces the 16 KB of 3.4, which M1's 4,000-character handle rule would cut in the middle. The whole answer with its wrapper stays under `HANDLE_OVER - 600`. A tool whose schema does not fit gets one line and "search for the exact name"; an exact-name search returns one full schema, through a handle when long. Each hit names its integration and says what its risk means ("risk external: the owner approves each call"). A search without a hit lists the tool names (at most 1,500 characters).
- **Search output is untrusted** (`mcp catalog: <id>`), because a server writes its descriptions and can change them at any time. So is every output of an MCP tool, also our own "did not run" text. Cost: after a search, allow rules on `external` tools stop applying until `/new`. Accepted until the reviewer (Phase 3 M3).
- **ajv with a guard.** Server schemas are checked with the SDK's bundled ajv (`@modelcontextprotocol/client/validators/ajv`, no new dependency), not zod's `fromJSONSchema`, which refuses a valid `oneOf` with a const discriminator. ajv runs without `useDefaults` or `coerceTypes`, so the server gets the bytes the owner approved. Before the compile a guard refuses a schema that is not an object, is over 16 KB or over 32 levels, and removes `pattern`, `patternProperties` (and then `additionalProperties: false` and `unevaluatedProperties: false`), `$id`, `$anchor` and `$dynamicAnchor`: a server `pattern` took 11 s on 29 characters, and `$id` let one server replace another server's validator. The guard walks every value, not a list of keywords (draft-07 `dependencies` and a `$ref` to an unknown key such as `#/x-shared/slow` got past a list); only the names in `properties`, `$defs`, `definitions`, `dependentSchemas` and `dependencies` are kept, and data keywords (`const`, `enum`, `default`, `examples`, `required`) are copied. A `$ref` must point to a part that the walk loosened as a schema; a reference into data or into a map of names is refused with the reason. The guard only loosens; the server checks again. The client never checks `outputSchema` (see Connection), so no server pattern runs on the event loop. A dialect that the SDK's ajv does not know (for example draft-04) moves the tool to `rejected` with the reason. Round 2 adds a limit on the work of one check and removes `format: url` (see 3.8).
- **Connection.** The run owns cancellation, not the SDK: `tools/call` gets no run signal and no 60 s timeout (an abort makes the SDK drop the answer, so the M1 late result could never arrive). A 1 h cap ends a request that never answers as `unknown`; the SDK then sends `notifications/cancelled`, which the trace links to the call (a test pins it). That is the only cancel in M2. Outcomes are typed: `result | not_sent | refused | unknown`. `tools/call` goes out as a plain `request`, not `callTool`: `callTool` checks the result against the server's `outputSchema` (running server patterns on the event loop) and throws a protocol error for a tool that ran. `refused` means that the server's answer was a JSON-RPC error; when a result came but cannot be read, the outcome is `unknown` with `answered`, and the model hears that the tool ran. No ping goes out while a `tools/call` waits, so a server with one thread is not closed mid-call. The trace keeps at most 100 server notifications a minute (one row says where it stops; `list_changed` and `cancelled` have their own limit of 10 a minute each, see 3.8). A 401 or 403 from an HTTP server is `not_sent`, and for a bearer entry the state names the secret to update. The outbound trace write fails closed and the inbound one fails open. A stop or a second start cancels a stale attempt. Backoff is 1 s, 5 s, 30 s, 2 min, 10 min, reset only after 60 s of healthy uptime. Version negotiation is pinned to `legacy`, because `auto` starts a second, unrecorded stdio process. On Windows a close ends the descendants of a stdio server too. stderr is limited to 100 lines a minute and 2,000 characters a line. The transport error is kept, so a reason reads "Connection closed: spawn … ENOENT".
- **No wait for a connection.** A call while the server is not connected returns at once with why: not connected yet, not connected with the reason and the next try in the owner's time zone, paused, not signed in, or the chat process. A wait would hold the session queue, and the call did not leave, so a retry is safe.
- **`unsent` rows.** When the transport refuses a request after its out row was written, a second row with `direction = 'unsent'` and the error closes it. It is written only for an error that shows the message did not leave (`not_sent`): an HTTP `send` also reads the answer, so other send errors can follow the action, keep only the out row, and are `unknown`. No migration: `direction` has no check constraint.
- **Pagination.** The connection walks every `tools/list` page (capped at 64 pages, which throws instead of giving a partial list), also for the `list_changed` refresh. A test pins it. (Round 3 moved the walk from the SDK into the connection, see 3.9.)
- **Secrets.** `@napi-rs/keyring` loads only when the app uses it. A value over 1,200 UTF-16 units (one credential holds 1,280) is stored in parts under a new generation, then a head with the count and a hash, then the old parts are deleted, so a crash leaves the old or the new value. A delete removes the head first and the parts after it, and a head whose parts are gone reads as no value, so a damaged token set parks the integration instead of stopping it. The target of an entry is `<ref>.ok-computer`. A stdio entry run by `npx`, `pnpx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec`, `npm x` or `bun x`, also behind `cmd /c` and after an option such as `--yes`, must name an exact `x.y.z` version for each package it downloads; a tag, a range or no version is refused at load.
- **OAuth is parked until the owner clicks Connect.** An OAuth integration without tokens makes no request at start: no discovery, no registration, no flow. The provider never opens a browser. A flow is keyed by `state`, works once, for one integration, for 10 minutes. The callback on `127.0.0.1:4318` listens only while a flow waits, accepts only a loopback host and GET, and answers fixed text. A refresh is single-flight through the transport `fetch`, and only a successful refresh is shared. A refresh that fails because the sign-in server is down (no answer, a 5xx, `server_error`, `temporarily_unavailable`) makes the SDK ask for a new sign-in; the app then makes no link, a call says to try later, and a start retries with the backoff, so a short outage never becomes `needs_auth` or a message to the owner. Connect is single-flight per integration, the callback port starts once, its close timer follows the last link, and a sign-in finished after Pause leaves the integration stopped. The same wrapper logs each sign-in step (no query, no body) and writes a failed step's server text to `integration_state.lastError`. An SDK save that only adds the issuer to stored tokens does not count as a sign-in. `@hono/node-server` runs with `overrideGlobalObjects: false`, because its own `Response` class made the SDK misread `invalid_grant` in the live process.
- **One sign-in message.** The owner gets one Telegram message, with the server's text and the link to the page, only when a sign-in that worked (`authorizedAt` set) stops working in a call or a connect attempt that the owner did not start. A first sign-in, a crash loop and a restart after a revoke (the SDK deleted the tokens, so the integration is parked) send nothing.
- **Chat mode does not connect.** `npm run chat` keeps the same tools and stored catalogs, so its prefix is the same, but never starts a server; its calls say the integration runs only in the background app. This closes the refresh race between two processes, duplicate stdio servers and the port fight. Two service instances would still race; the supervisor runs one.
- **Schema normalization.** Anthropic gets the schema unchanged except `$schema`. The OpenAI-compatible adapter gets a plain schema: references in place, a union simplified only where a type list or an enum says it exactly, null variants dropped, and a union of objects kept as `anyOf` (the first-shape rule made `automations_create` accept only one schedule kind). A budget of 2,000 output nodes and 32 levels makes a part past the limit accept any value: looser, never stricter. The walk goes into every value, so a reference in `prefixItems`, `not` or `if` is put in place too. Integration schemas never enter `tools`; `tool_search` shows the guarded original.
- **Elicitation is deferred.** The client declares no elicitation capability. A form that asks for data is an outbound channel and needs its own approval design.
- **Dashboard.** `GET /api/integrations`, `GET /api/integrations/:id` (versions with diffs, recent calls with outcome words, JSON-RPC messages), `POST …/connect` (reconnect for every kind; resumes a paused integration), `POST …/pause {paused}` (survives a restart), `GET /api/mcp-messages/:id`. The pages reload on a log line of an integration. A changed description of an allowed tool is red in the version list. The run timeline shows the JSON-RPC messages of each integration call.
- **No migration.** Migrations 004 and 005 have every table and column M2 writes. `tool_calls.source = 'mcp'` and `serverId` are now written.
- **Known gaps after M2.**
  - Orphan stdio servers after a hard crash of the app (the tree kill runs only on close).
  - The SDK's 10 MB stdio line limit, and the same limit on an HTTP answer (3.10): a larger result closes the connection, and the call is `unknown`.
  - `list_changed` is asynchronous: a search right after a call that changes the list can see the old list.
  - No UI to store a pre-registered `clientRef` (Slack, Phase 3 M1); use `cmdkey`.
  - HTTP session-id expiry of a remote server is untested.
  - A stdio write before a spawn error lands in the pipe buffer, so the trace shows an out `initialize` that never reached a process. The status and last error say why.
  - Nothing prunes `mcp_messages`, blobs or catalog versions. A server that sends a new tool list each second still grows the database; an equal list costs one short row (3.8).

### 3.8 Decisions from phase 2 M2, verification round 2

- **The guard limits the work of one check.** The SDK gives ajv `allErrors`, so every branch of `allOf`, `anyOf` and `oneOf` runs. A 1.6 KB chain where each level refers twice to the next level ran out of heap memory (the process dies, no catch helps), and 31 levels of `allOf` took 7.9 s on a valid input. The guard now counts the parts of the schema with each `$ref` put in place and refuses the tool over 5,000 parts: a 16 KB schema without references has fewer, so a reference cannot make a check larger than the byte limit already allows. It also refuses a recursion that comes back to itself without a step into the input (it never ends), or on two paths where one is the start of the other, with wildcards for `additionalProperties` and `items` (`a = allOf [items a, items a]` doubles per level of input; the paths `x` and `x.x` split a chain in fib(n) ways). A filter with `and`/`or`, a JSON value and a binary tree stay. The prefix rule also refuses `x` with `x.y`, which is linear; it cannot tell the two apart, and such a schema is rare. Refusal and not loosening, because the guarded schema is also what the model reads, and the dashboard shows the reason. A worker thread with a time limit was not taken: the check runs inside a synchronous zod refinement, and a worker per check costs more than the count. `format: url` is removed, because ajv-formats checks it in quadratic time (40,000 characters took 1.2 s); every other format stayed under 3 ms on 20,000 characters, so they stay for the model.
- **A stored catalog goes through the guard of today** at the start, so a schema that an older guard kept cannot run before the server answers.
- **`list_changed` and `cancelled` have their own limit** of 10 a minute each in the trace, with the same row that says where it stops. 20,000 of them held the event loop for 25 s; now 0.4 s, the same as other notifications. A flood of other notifications still cannot hide them. A `tools/list` answer that the connection already recorded gets a short row with the SHA-256 of its result: an unchanged list of 200 tools was 100 KB a refresh. Both rate windows (the trace and stderr) start again when the clock moves back.
- **An inbound blob failure keeps the row** with a note in place of the payload, like M1's `tool_calls` rule. A message out still does not go without its whole trace.
- **An unreachable HTTP server is `not_sent`**: a fetch error whose cause is `ECONNREFUSED`, `ENOTFOUND` or `EAI_AGAIN` fails before a byte leaves. The connection closes, so the backoff starts at once. `ECONNRESET` stays `unknown`, because a reset can come after the server read the request (a call on an old keep-alive socket of a stopped server gives it too).
- **A tool output names its effect** (`effect: 'none' | 'unknown'`). An integration call that was not sent is `none`; a request with no answer is `unknown`. An approved call with no effect makes the approval `pending` again, so the owner can approve it when the integration can take it (paused, connecting, the chat process, a failed trace write); the words say that the tool did not run. The crash sweep ignores the row of such an earlier attempt (rows from before the start mark). An abandoned call that later ends without an answer stays `abandoned`, and the owner and the session read that its effect is still unknown, not that it finished.
- **A repaired row of an interrupted integration call** has `source = 'mcp'` and its integration, so the page shows the call whose effect is unknown.
- **A credential manager failure at the start** goes to the log, and the connection starts anyway: it reads the tokens again, and its retry shows the error and tries again. Before, the integration stayed stopped with no error.
- **The version check reads more runner forms**: `cmd /c` and `/k` (also one text with spaces), `npm x`, options before the runner word, and `-p=`. Not read: an option with a value before the runner word, such as `npm --prefix dir exec`.

### 3.9 Decisions from phase 2 M2, verification round 3

- **The tool list is read tool by tool.** The SDK checked a whole `tools/list` answer against its strict tool schema, so one tool with a sloppy shape (no `inputSchema`, `required: null`, a text `readOnlyHint`, a `null` description), also a hidden one, threw the list away, and the integration retried for ever. The connection now sends `tools/list` itself with a lenient result schema (`tools: unknown[]`, `nextCursor`), walks the pages (64 at most; a repeated cursor ends the walk), and refreshes after `list_changed` with its own 1 s debounce. The catalog checks each field: a tool without a name is skipped, a hidden tool stays hidden, and an allowed tool with a bad schema moves to `rejected` with the reason. A missing `inputSchema` becomes `{type: 'object'}`. A call to an integration that has no catalog yet says that the list did not come, and why the integration is not connected, instead of "no integration tool is named".
- **The risk map is read by own keys only**, so a tool named `constructor` or `__proto__` gets the default risk.
- **The redactor keeps the newest value of each source.** `registerSecret(value, source)` replaces the forms of the last value of that source (a credential reference; the access and refresh token of an integration). Each OAuth refresh added up to eight forms before, and `redact` makes one pass for each: after 100 refreshes one redaction of a 200-tool list took 488 ms instead of 15 ms (now 17 ms). A value without a source stays for the life of the process. An old token is not removed from text that was already written, and it never was in a trace row, because headers are not recorded.
- **The process tree of a stdio server uses start times.** Windows keeps the parent pid of a process after its parent ends and gives the freed pid to new processes, so a server with a reused pid listed unrelated orphans (for example `explorer.exe`). A descendant now counts only when it started after the server and after its parent, under a root that this process started; after the close the list is read again, and only a pid with the same start time is ended. A Job Object would be exact but needs native code.
- **The crash sweep reads a mark, not the clock.** The row of a tool output with effect `none` gets the stored outcome `unsent` (the dashboard word too), and the sweep skips only such rows. Comparing the row time with the start mark made a finished call look interrupted after the clock moved back.
- **A sign-in link shows only while the callback listens.** The SDK makes a flow when a sign-in stops in a call or a start that the owner did not begin, but the callback listens only during Connect, so that link ended in a refused connection with the code spent. The page offers Connect instead.
- **Refreshed tokens that the credential manager did not take stay in memory** and are saved again at each read until a save works. A server with rotation had spent the old refresh token, so the lost set ended the sign-in at the next refresh. A restart before the save still loses them. A failure of the credential manager inside a call is `not_sent` (its own error type), because the server did not accept the request.
- **The error of a connection attempt is redacted** before it reaches the state, `integration_state.lastError`, the page and the answer of Connect. A server that quoted its key put it there in plain text.
- **Requests from a server have a trace limit** of 100 a minute, like notifications; the answers of the app to the others are left out too, with one row that says so. 20,000 pings gave 40,005 rows and held the event loop for 50 s; now 206 rows and 1.3 s, the same as without the recorder. The client still answers every request.
- **A 401 or a 403 is an answer, not `unsent`.** The HTTP transport posted the whole call before the status, so the row is an in row with `{httpStatus, error}`. The outcome stays `not_sent` for the model, because the server refused before it acted. An auth error of the SDK (it comes only after a 401, or a 403 for a scope) gets the same row without a status; a credential manager failure keeps only the out row, because it can come before or after the post.

### 3.10 Decisions from phase 2 M2, verification round 4

- **One walk of the tool list at a time.** Each `list_changed` started a new walk after its debounce, also while an earlier walk or the first one ran. A slow, older answer then replaced a newer catalog (and was stored as the newest version), and a server with 64 pages of 9 MB and a `list_changed` each second filled the heap until the app crashed in 145 s. Now each attempt runs one walk, the first walk counts as one, and a `list_changed` during a walk runs one more walk after it. The same server now stays connected with the heap under 600 MB. A sequence number on each walk was not taken: it keeps the order, but not the number of walks. No cap on the bytes of a walk: the page limit and the message limit already bound it.
- **`nextCursor: null` ends the walk**, like a missing cursor. The strict cursor schema threw the whole list away.
- **An HTTP answer has the 10 MB limit of stdio.** A fetch wrapper on every HTTP entry (no auth, bearer, OAuth) stops a body over the limit and closes the transport, so the call is `unknown` and the backoff starts, as an oversized stdio line does. An event stream can stay open for hours, so there the limit applies to each event (a blank line ends an event; the data lines of one event count together). A 200 MB result now costs no blob and no trace row of its answer.
- **The reason that a tool list is missing is outside text.** It quotes the error of the connection, which can be the server's words. It now carries the untrusted source of the integration (so the session is tainted and the model reads it wrapped), and its trace row has `source = 'mcp'` and the integration. Dropping the error from the text was not taken: the error tells the owner what to fix.
- **A Pause during a Reconnect wins.** The reconnect checks the pause after the old connection closes and does not start. The answer of Connect says that the owner paused it. One queue per integration for pause and connect was not taken: one check closes the window.
- **The page gets a redacted catalog.** `status()` redacts the tools, the rejected tools and the hidden names, as the stored copy is.
- **The time of the newest message is the newest row by id**, one entry of the `(serverId, id)` index. `MAX(createdAt)` read every row of the server (0.6 s for 1.8 M rows at each load of the page).

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

### 4.7 Decisions from phase 2 M3

Three designs were built and judged (minimal, failure modes first, owner experience first). The build takes the failure-mode design as its base and adds parts of the other two. The owner guide is `docs/setup/google.md`.

- **Library.** `@googleapis/gmail@22.0.1`, `@googleapis/calendar@20.1.0` and `google-auth-library@11.3.0`, pinned exact. This is the code of `googleapis` (4.1) at 2 MB instead of 245 MB. The SDK retries are off (`retry: false`; one 503 was four requests), each request has a 30 s timeout, and the OAuth client runs with `forceRefreshOnFailure`, so the token endpoint decides a 401: `invalid_grant` is a dead sign-in, a 5xx is an outage. Only errors with the gaxios symbol become a `GoogleError` (`kind`, `status`, `reached`) with a redacted message of at most 300 characters; the SDK error carries the request config and can quote `Bearer …`. A failed token request never reached the API, so its effect is `none`.
- **Config.** A `google` block in `okc.config.json` (`clientId`, `accounts: [{alias, email?}]`, `send = false`, `sessions = ['main']`, `pollMinutes = 15`), not a `builtin` entry in `okc.integrations.json` (3.2). That file and its manager assume MCP: `tools.allow`, a connection and a catalog. Without the block nothing changes: no tools, no automation, no prompt text.
- **Pinned tools.** 14 tools `google__*` (13 without `send`) with zod schemas in code, in the `tools` parameter of the sessions that `sessions` names. This is group 2 of 3.4. The list depends only on the config, so it is byte-stable in a session, and no untrusted catalog taints the session. `account` is an enum of the aliases, plus `all` for reads.
- **Secrets.** The client secret (`google.client`) and one refresh token per alias (`google.<alias>`) are in the Credential Manager through `SecretStore`. Access tokens stay in memory. Each value is registered with the redactor under its own source, and `registerSecret` also registers `encodeURIComponent(value)`: a token endpoint that quoted its form body put `1%2F%2F…` in the log. The owner uploads the client file on the Google page; the server checks the client id against the config and keeps only the secret.
- **Token health.** `invalid_grant` parks the account (`needs_auth`); tokens are never deleted, and a parked account makes no request. The owner gets one message, by a compare-and-set on `alertedAt`, also over a restart and three calls at once. `invalid_client` parks every account with one message that names the client, and a new client file lifts that park without new sign-ins. After 12 failed polls in a row the owner gets one stall message. The poll job always returns `completed`, so the scheduler never turns it off.
- **Sign-in.** An ephemeral loopback port (never 4318) that listens only while a flow waits, PKCE, a one-time `state` for 10 minutes, `login_hint`. A wrong account or a missing scope revokes the new token, keeps nothing, and says what to do in words. The Gmail baseline is taken at the sign-in, and a cursor that exists stays, so the mail of an outage is still news after a reconnect.
- **Gmail sync** has two phases. `history.list` (at most 10 pages) inserts the new inbox ids as `state = new` and moves `google_accounts.historyId` in one `BEGIN IMMEDIATE` transaction with a compare-and-set. Then at most 50 rows per account and poll are read with `messages.get(metadata)`, each on its own. A crash or a failed page loses and repeats nothing; the unique key is the guarantee, and the compare-and-set only stops a slow poller from moving the cursor back. A 404 history id runs `getProfile`, then `in:inbox newer_than:2d`, and the note of the poll run says so.
- **Calendar sync.** The first read uses `timeMin = now − 1 day` and `singleEvents`, later reads the `syncToken` with the same `singleEvents`; the token moves after the signals of the last page are stored, and a 410 reads again without signals. Only changes by others (`organizer.self !== true`) are signals (`invite` or `event_change`, keyed `eventId@updated`). There is no copy of the calendar, so a cancelled event without an organizer makes no signal. The copy was rejected: it drifted from Google for recurring and deleted events, and its unbounded first read did not finish on a large calendar.
- **Signals** (`src/signals/`, source-agnostic for Slack). `integration_events` has `state`, `label`, `labelAttempts`, `labelModelCallId`, `detectors` (null until checked), `runId`, `handledAs` (`notified | seen | filtered | stale`) and `handledBy`, unique on `(source, account, externalId)`.
  - **Detectors run first**, so a label never hides a hit. `date_not_on_calendar` keeps its hit on the mail row; it reads subject and snippet, a weekday counts only after a day-setting word ("Would Thursday work?" is no date), and an all-day event counts on its own date. It compares against one live range read of each calendar per poll (yesterday to 61 days ahead). When a calendar read fails, the detector uses the calendars that the poll could read: a false hit is better than a hidden deadline. `event_soon` is its own signal.
  - **Classifier.** One utility call per 20 mail rows, at most 5 per poll, each row one try per poll. The mail is wrapped as untrusted, the answer is a `label_signals` tool call without a forced `tool_choice` (a 400 on current models), and each item is checked: an id of the batch and a label of the list. After 3 failures a row stays unlabeled and still shows. `SlotResult.modelCallId` links each label to its call.
  - **Heartbeat.** It runs for signals also with an empty checklist. The digest (at most 20, newest first, wrapped) carries one taint source per source and account. A completed run marks the shown signals `notified` when it sent a message and `seen` otherwise, after the send, so a crash repeats rather than loses a deadline. Quiet labels without a hit are `filtered` without a model call, and unhandled signals older than 3 days are `stale`. The model does not name signal ids.
- **The poll is a run.** The automation `{type: 'poll', source: 'google'}` runs a `runs` row (`sessionKey = poll:google`, `trigger = poll`), so its requests and its classifier calls show in one timeline with their cost, and the run's `error` holds its note. `scheduleContext` leaves poll automations out. The `polls` job map is generic, so Slack adds `slack`.
- **Risk of one call.** `Tool.riskFor(input)` and `Tool.accountOf(input)`. The caller computes the risk one time in the check and carries it in the gate; an approved call reads the risk and the account from the row of the call that asked, so `riskFor` never runs after the approval. A `riskFor` result of `external` asks the owner like `needsApproval`, so an allow rule on `calendar_create_event` never sends invitations. `tool_calls.account` is written.
- **Writes.** A send goes through a draft: after a lost answer, `drafts.get` decides (404 sent, 200 not sent, else unknown). Recipients are lists of bare addresses, and a line break in a header field is refused. `calendar_create_event` takes attendees and derives its event id from the call, so a repeated approved call makes one event. Update and delete take `currentTitle` and check it before they act. A repeated delete counts as done.
- **Unsubscribe** takes `{account, messageId, sender, target}`, so the card shows both. At run time the tool reads the message again and checks the parsed From address against the sender exactly (a substring test let `"bank@x" <evil@y>` pass), and that the header offers the target. A one-click target needs `List-Unsubscribe-Post` and `dkim=pass`; the POST uses `node:https` with a lookup that refuses private addresses inside the connect (DNS rebinding), no redirects, a 15 s timeout and a 64 KB answer cap. A mailto target goes through the draft send, only with `send`. A refusal has no `effect`, so it never gives the approval back to the owner.
- **One recorded fetch.** The OAuth client's `fetchImplementation` and the one-click POST write `google_requests` rows: before the request leaves (a failed row write stops the request, effect `none`), then the status, latency and answer (fail open). No header is stored; token, code, verifier and secret fields are removed by name before the redactor; an answer over 8 KB goes to a blob. An `AsyncLocalStorage` context links each row to the run and the call of a tool, or to the poll run, so a token refresh shows inside the call that needed it. A dedicated table, not `mcp_messages`: the rows are HTTP, not JSON-RPC.
- **Dashboard.** A Google page (status, what to do, Connect, the client upload, the last poll, the tools) and a Signals page (label and model call, detector hits, what happened with the message and the run). A Google tool call opens to its requests, and a poll run lists its requests.
- **Schema.** One migration, `008_google.sql`: `google_accounts` (with both cursors and `failures`), `google_requests`, `integration_events`. `src/db/index.test.ts` checks only the migration names before 008.
- **Known gaps after M3.**
  - The first calendar read with `timeMin` and the 7-day Testing-mode expiry are unverified against real Google; they are in the manual checks of the guide.
  - A cancelled event by someone else is often not recognized (no organizer in the delta).
  - After an outage longer than about a week, the resync looks back only 2 days.
  - After a lost send answer, a draft that the owner deleted in that second reads as sent; the output says so.
  - The date heuristics (a shared word of 4 letters, US month/day) need tuning with real mail. Some honest one-click senders fail the DKIM gate; the owner gets the link.
  - **Taint through memory (2.5) is now live.** Mail read by main or the heartbeat can reach daily notes and `MEMORY.md`, and a heartbeat relay taints main until `/new`, so allow rules on external tools stop working there. The owner should rule on this before Slack and review merge.
  - The write tools ask the owner until the reviewer exists; the guide shows the allow rules.

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

1. **Static rules** in `okc.policy.json`: patterns on tool name and arguments, with allow or deny. A matching deny rule always wins, in any position; otherwise the last matching allow rule decides. Example: allow `google__gmail_archive` for senders in a newsletter list.
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

**Plan change (2026-10-13, owner decision).** Three milestones leave the build plan for now:

- **Phase 3 M4 history is on hold.** The owner never asked for it in this form, and it is not designed well enough. A later design should also cover ChatGPT logs, not only Claude.
- **Phase 4 M1 sandbox is on hold.** There is no use case for it yet. Without it, the `code` sub-agent profile is not built.
- **Phase 4 M2 sweep is not a development milestone.** The owner tests it by asking the agent to do it with the Gmail integration. If that test shows a gap, the gap becomes a normal fix.

After M2, the other six milestones (google, telegram, slack, web, review, workshop) are built at the same time on separate branches, then merged one at a time. Review merges last, so that it can check its rules against the real tools.

### Phase 2: foundation and the owner's core accounts

| Milestone | Scope | Done when |
|---|---|---|
| **M1 trace** | Blob store; new tables (2.2); `toolCatalogHash`; the exact model view per tool result; result handles and `result_read`; policy engine with rules, risk, taint, and decisions (reviewer stubbed); nested run timeline and "what the model saw" per tool result | A seeded run with a large tool result shows the preview the model got, the handle, the full blob, and the policy decision, all in the dashboard |
| **M2 mcp** | MCP client v2 wrapper with `mcp_messages`; integration registry; keyring secrets; OAuth loopback flow; `tool_search` and `tool_call`; schema normalization; Integrations page | A test MCP server (in-memory and stdio) can be connected, searched, and called; every JSON-RPC message is in the trace; the `tools` parameter stays byte-stable across a session when the server's catalog changes |
| **M3 google** | Built-in Google integration with Gmail for N accounts and Calendar; history and sync-token polling; signals and detectors; heartbeat digest; send, unsubscribe, and event invites through approvals | With a mocked Google API: polling creates signals, the heartbeat tells the owner about a deadline missing from the calendar, unsubscribe needs approval, and tokens never appear in logs or blobs |
| **M4 telegram** | Rich messages, streaming drafts, reactions, typing, approval cards, commands menu; dashboard token and cookie for Tailscale | With a mocked Bot API: a Markdown reply goes out as a rich message, a long reply streams and then saves, an approval card shows the arguments, and the stop button stops a run |

### Phase 3: more reach

| Milestone | Scope | Done when |
|---|---|---|
| **M1 slack** | Slack through the official MCP server (OAuth with a pre-registered client per workspace); DM polling into signals; send through approval | With a fake MCP server shaped like Slack: DMs become signals, and sends need approval |
| **M2 web** | `web_search` through Chrome (Google, DuckDuckGo fallback), `web_fetch`, the browser worker with Playwright, allowlists, step screenshots, trace zips, and the Browser page | Against a local test site: every step has a screenshot and snapshot, off-list navigation is blocked and recorded, and a form submit needs approval |
| **M3 review** | Reviewer model, taint propagation, exfiltration guard, `delegate` with profiles, sub-agent traces | A tainted run cannot send without approval; the reviewer holds an injected action in a fixture; child runs show in the parent timeline |
| **M4 history** (on hold) | Claude Code transcript watcher and index, claude.ai export import, `history_search` and `history_get` | Fixture transcripts and an export ZIP are indexed with secrets redacted, and results are wrapped as untrusted |

### Phase 4: power tools

| Milestone | Scope | Done when |
|---|---|---|
| **M1 sandbox** (on hold) | Docker sandbox container, `sandbox_*` tools, network proxy with allowlist, optional Claude code execution per slot | With Docker available: commands run as non-root with no network, network needs review, and output goes through handles |
| **M2 sweep** (owner test, not built) | Subscription sweep: the `inbox` sub-agent triages mail across accounts on the `batch` slot, proposes an unsubscribe list, and runs it after one approval of the whole list | With a mocked Gmail: the list is grouped by sender, one approval runs all unsubscribes, and each run is traced |
| **M3 workshop** | Skill Workshop: after long or corrected tasks, a review proposes a new or changed skill, and the owner approves it in Telegram | A fixture task produces a skill draft, and only approval writes it to `skills/` |

## 11. What the owner sets up

These steps need the owner's own accounts. The implementer writes a guide in `docs/setup/` for each one.

1. **Google** (Phase 2 M3): create a Google Cloud project, turn on the Gmail and Calendar APIs, create a "Desktop app" OAuth client, and set the consent screen to "In production". Then connect each Gmail account from the dashboard. Takes about 10 minutes.
2. **Slack** (Phase 3 M1): one internal app per workspace with the user scopes in section 4.2. The owner may need admin approval in a workspace they do not own.
3. **Browser logins** (Phase 3 M2): run `okc browser login` once and sign in to the sites the agent may use, in the agent's own Chrome profile.
4. **Tailscale** on the PC, phone, and laptop (any time).
