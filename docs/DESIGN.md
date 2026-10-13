# OK Computer: System Design

This document is the source of truth for the implementation. When the code and this document disagree, fix one of them so they match again, and say which in the commit message.

## 1. Purpose

OK Computer is a personal agent for one person (the owner). It lives on the owner's PC and talks to them over chat (Telegram first). It:

- asks for the owner's three goals each evening, follows up at the times the owner gives, and nags politely when goals are not set;
- creates and runs custom routines that the owner describes in plain language ("every night at 7pm ask me for my 3 goals, remind me hourly until 10pm");
- wakes up on a heartbeat (configurable: 15m, 30m, 1h) to check if anything is worth telling the owner;
- remembers the owner through daily notes, a long-term memory file, and nightly consolidation into weekly trends;
- records every model call, tool call, and message, and shows them in a large observability dashboard.

Later phases add Google Calendar, Gmail (polling every 15 minutes), browser control, a subscription sweep over email and bank data, sub-agents, and a Skill Workshop. See the phases and the TODO list in `README.md`.

There is one user. There is no multi-tenancy. Design for clarity and reliability, not scale.

## 2. Principles

1. **The event log is the truth.** Every message, model call, tool call, and tool result is appended to an append-only log. Nothing in the log is edited or deleted. Everything the model sees is a view computed from the log.
2. **Context strategies are swappable.** The function that turns the log into the model's input is a plug-in. Phase 1 ships tool-result trimming plus structured compaction. Retrieval and recursive-LM strategies can be added later and rerun over the full history.
3. **Model-agnostic.** All model access goes through one interface. Claude, OpenAI-compatible servers (Ollama, vLLM, llama.cpp), and others are adapters. Which model runs which job is configuration, not code.
4. **Deterministic routing.** Code, not the model, decides which session a message goes to and which model slot a job uses.
5. **Safety in code, not prompts.** A tool that does not exist cannot be misused. Risky tools require an approval that only the owner can give through a button or an explicit command. Text from email or the web is marked as untrusted data.
6. **Exact scheduling.** Timed work fires at the exact time from a real scheduler. The heartbeat is for open-ended checks only.
7. **Simple first.** Use the smallest design that meets the acceptance criteria. Add abstraction only when a second real use appears.

## 3. Runtime and stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript, `strict: true` | ES modules |
| Runtime | Node.js 24+ | Must run on Windows (dev) and Linux/WSL (service) |
| Database | SQLite through the built-in `node:sqlite` module | No native build step. Enable WAL mode. |
| Claude access | `@anthropic-ai/sdk` | Prompt caching, adaptive thinking, refusal handling |
| Other models | `openai` package with a custom `baseURL` | Ollama, vLLM, llama.cpp, any OpenAI-compatible server |
| Telegram | `grammy` | Long polling, no public URL needed |
| Schedules | `croner` | Cron expressions with time zones |
| Schemas | `zod` | Config, tool inputs, API payloads |
| HTTP server | `hono` with `@hono/node-server` | Dashboard API and static files |
| Dashboard UI | Vite + React + TypeScript in `web/` | Built to `web/dist`, served by the Hono server |
| Tests | `vitest` | Unit and integration |
| Run and build | `tsx` for dev, `tsc` for build | |

Add a dependency only when it removes real work. Prefer the standard library.

## 4. Repository layout

```
ok-computer/
  README.md               overview, decisions, TODO (later)
  docs/DESIGN.md          this document
  workspace/              persona files: AGENTS.md, SOUL.md, IDENTITY.md, and a local USER.md
    AGENTS.md SOUL.md IDENTITY.md USER.md
  skills/                 skill folders, each with a SKILL.md
  src/
    main.ts               process entry: load config, open db, start channels, scheduler, dashboard
    app.ts                wires the modules together; used by main.ts and integration tests
    smoke.ts              npm run smoke
    time.ts               clock type and owner-time-zone formatting
    config/               config schema and loader
    db/                   connection, migrations, typed query helpers
    events/               append-only event log
    models/               model interface, adapters, slots, pricing, cost
    agent/                agent loop, run lifecycle, system prompt builder
    context/              context strategies (trim, compaction), token estimation
    sessions/             session keys and routing
    channels/             channel interface, cli adapter, telegram adapter
    scheduler/            automations, heartbeat, run history
    goals/                goals domain
    memory/               daily notes, MEMORY.md, search index, consolidation
    skills/               skill loader and index
    tools/                tool registry, tool policy, built-in tools
    approvals/            approval requests and resolution
    observability/        structured logger, metrics queries
    dashboard/            Hono server and JSON API
  web/                    dashboard frontend (Vite + React)
  test/                   tests that span modules; unit tests sit next to code as *.test.ts
  data/                   runtime data, gitignored: okc.sqlite, logs/, memory/
  .env                    secrets, gitignored
  okc.config.json         non-secret config (optional; defaults apply)
```

`data/` and `.env` must be in `.gitignore` before the first commit that creates them. Personal data never goes into git.

## 5. Architecture

```
 owner (phone / terminal)
        |
        v
 channel adapters (telegram, cli)  --->  router: sender check, session key
        |                                        |
        |                                        v
        |                               run queue (one run at a time per session)
        |                                        |
 scheduler (automations, heartbeat) ------------>|
                                                 v
                                   agent loop: context strategy -> model -> tools -> repeat
                                                 |
          event log (sqlite) <-------------------+----> tools: goals, automations, memory, approvals, messaging
                 |
                 v
          dashboard (hono api + react ui)
```

### 5.1 Inbound message flow

1. A channel adapter receives a message and normalizes it to `InboundMessage { channel, senderId, chatId, text, replyToMessageId?, receivedAt }`.
2. The router checks the sender against the owner allowlist. Unknown senders get one short refusal and the attempt is logged. Their text does not reach the model.
3. The router resolves the session key (section 7) and appends a `user_message` event.
4. The run queue starts a run for that session. If a run is active, the new message waits for the next run (Phase 1). Mid-run steering is a later feature.
5. The agent loop runs (section 6) and produces the final text.
6. If the final text is exactly `NO_REPLY`, nothing is sent. Otherwise the reply goes back to the same channel and chat. Long replies are split to fit channel limits.

### 5.2 Scheduled flow

1. The scheduler fires an automation at its time.
2. The automation either appends a system event to the main session, or starts a run in a fresh isolated session (section 7) with the automation's prompt.
3. Isolated runs that produce text deliver it to the owner's main chat, unless the result is `NO_REPLY`.

## 6. Agent loop

A **run** is one trigger (a message, an automation, a heartbeat) processed to completion.

1. Create a `runs` row: `id, sessionKey, trigger (message | automation | heartbeat | consolidation | system), slot, status (running), startedAt`.
2. Build the model input with the session's context strategy (section 8).
3. Call the model through the slot's model chain (section 9).
4. Append an `assistant_message` event with the full content blocks.
5. If the response has tool calls: run them (parallel calls may run concurrently), append one `tool_result` event per call, and return all results to the model in one message. A failed tool returns an error result with `isError: true`. It does not crash the run.
6. Repeat from step 2 until the model ends its turn, the iteration limit is reached (default 20), or the run timeout passes (default 10 minutes for chat, 30 minutes for background).
7. Set `status` to `completed`, `failed`, or `aborted`, with `endedAt` and an error message when relevant.

If the loop ends on the iteration limit, append a short note to the session and tell the owner that the task stopped and why.

## 7. Sessions and routing

| Session | Key | Use |
|---|---|---|
| Main | `main` | All owner messages from all channels share one continuous conversation |
| Automation | `auto:<automationId>:<runId>` | Fresh session for each automation run |
| Heartbeat | `heartbeat:<runId>` | Fresh session for each heartbeat |
| Consolidation | `consolidate:<date>` | Nightly memory job |

- There is no automatic topic detection and no automatic reset. Compaction keeps the main session bounded.
- The owner can type `/new` to start a fresh main session. The old session stays in the log. A `session_reset` event marks the boundary, and the daily note gets a short excerpt of the last messages (the last 6 owner and assistant messages, under `## notes`).
- Old context returns through memory search, not by reopening old sessions.

## 8. Context management

### 8.1 Event log

Table `events`:

```
id INTEGER PRIMARY KEY, sessionKey TEXT, runId TEXT NULL, seq INTEGER,
type TEXT, payload TEXT (json), createdAt TEXT (iso, utc)
```

Event types: `user_message`, `assistant_message`, `tool_result`, `context`, `system_event`, `compaction`, `session_reset`, `note`.

`context` holds the volatile part of the system prompt (section 8.4), recorded once at the start of each run so that later requests replay the same bytes.

Rules:
- Insert only. No `UPDATE` or `DELETE` on `events`, ever. Add a test that greps the source for violations. Database triggers also abort any `UPDATE` or `DELETE` on the table.
- `assistant_message` payloads store the full content blocks exactly as the provider returned them, including thinking blocks and signatures, so they can be replayed unchanged. They also store the provider, model, normalized text, and tool calls, so another provider's adapter can rebuild the turn.
- The router appends a `user_message` only when its run starts, so a message that arrives during a run can never land between a tool call and its result.

### 8.2 Context strategy interface

```ts
interface ContextStrategy {
  name: string;
  build(input: {
    session: SessionInfo;
    events: StoredEvent[];      // full history of the session, in order
    system: string;             // stable part only; the volatile part is a `context` event
    tools: ToolSpec[];
    compaction?: CompactionHooks; // runId, signal, flush(text); absent when the strategy must not compact
  }): Promise<ModelRequest>;
}
```

M1 ships `full-history`, which renders every event after the last `session_reset`. M3 adds `trim-and-compact`, which the app uses. It does not take a `model` input: the window is `context.windowTokens` from config (default 200,000), a cost budget for the input of one call rather than the limit of the model.

The default strategy is `trim-and-compact`:

1. **Start point.** Begin after the most recent `compaction` event, or from the start of the session. If a compaction exists, its summary becomes the first message.
2. **Tool-result trimming.** Keep the last 3 assistant turns untouched. In older turns, cut tool results over 4,000 characters to their first and last 1,500 characters with a marker between. When estimated context is over 50% of the window, replace old tool results with `[old tool result cleared]`.
3. **Compaction trigger.** When the estimated input exceeds `contextWindow - reserve` (reserve: 20,000 tokens, never more than a quarter of the window), compact before the model call.
4. **Memory flush.** Before compaction, run one silent turn in the same session with the instruction to save durable facts to today's daily note through the memory tool. Its final text must be `NO_REPLY`.
5. **Summarize.** Send the events to be compacted to the `compaction` slot with a fixed prompt. The summary must contain these headings: `## goals and commitments`, `## decisions`, `## open requests`, `## facts and identifiers`, `## recent progress`. Keep the most recent ~20,000 tokens of events verbatim. Never split a tool call from its result.
6. **Validate.** Check that every heading is present and that identifiers found in the compacted events (dates, times, numbers, ids, file paths, URLs) appear in the summary or are listed as dropped. Retry up to 2 times with the failures named. If all attempts fail, do not compact; log a warning and continue with trimming only.
7. **Record.** Append a `compaction` event with `{ summary, firstKeptEventId, tokensBefore, tokensAfter, model, clearToolResults }`.

Token estimation: use the provider's token counting endpoint when cheap and available, otherwise estimate at 4 characters per token. Keep this in one module.

Decisions from M3:

- **Where trimming happens.** Step 2 changes old turns, so it runs only on the kept events of a compaction, or in the fallback after a failed compaction. Below the trigger, the view is the same as `full-history`. After a compaction, the view is the summary (a `<summary>` text block at the start of the first user message), then the kept events, then the events after the compaction event. The kept events lose their thinking blocks and get the step 2 trim. The 50% clear decision is made at compaction time and stored as `clearToolResults`. The view then depends only on the compaction event, so it is byte-stable until the next compaction. Events after the compaction event are not changed.
- **Sizes.** The reserve and the kept part are each `min(20,000, window / 4)` tokens. The kept part starts at an event that is not a `tool_result`. It is the longest such part under the limit, or the shortest one if even that is larger.
- **Memory flush.** The flush is a nested run in the same session with trigger `system`, the same slot and tools, and `noCompaction`. Its first event is a `system_event` with the flush prompt. After it, the strategy appends a `system_event` that says the flush is done. Without that event the next request would end with an assistant turn, which the API refuses. The flush is skipped when the session has no `memory_write` tool, or when a flush already ran after the last compaction.
- **Summary.** The compaction slot gets a fixed system prompt and a plain-text transcript, so any provider can summarize any other provider's turns. The previous summary goes with it. Validation checks the five headings (an optional `## dropped identifiers` heading lists dropped values). It also checks dates, times, `#ids`, 8-hex ids, uuids, paths, URLs, and numbers with two or more digits. These come from owner text, assistant text, tool inputs and results, system events, notes, and the previous summary. `context` events are left out, because they repeat the clock. A full ISO timestamp counts as its date.
- **Failure.** After 3 failed attempts there is no compaction, and the rest of that run uses the trimmed fallback without new attempts. The next run tries again.
- **Estimate.** Only the 4-characters-per-token estimate is used (`context/tokens.ts`). A token counting call on every iteration would add latency and cost.

### 8.3 Provider rules that affect context

Before writing the Anthropic adapter and the context strategy, invoke the `claude-api` skill and read its TypeScript README, the prompt caching guide, and the model migration guide sections about preserved thinking and compaction. Current Claude models bind thinking blocks to the conversation that produced them, and editing earlier turns can make requests fail. The context view must follow the guidance there. In particular: keep the rendered prefix byte-stable between turns when nothing changed, replay assistant blocks unchanged, and handle the change of prefix after a compaction in the way the skill documents. Write tests for these cases with the fake provider.

Decisions from M1:

- The Anthropic adapter calls the beta messages endpoint with the `thinking-binding-controls-2026-08-01` beta and `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`. The stable prompt is rebuilt each run, so an edit to a persona file or `MEMORY.md`, or a deploy that changes tools, changes the prefix. With `drop_block` the API drops the stale thinking blocks one time; without it the request fails with a 400 on enforced accounts. Dropped blocks come back in `input_transformations` and are logged as warnings.
- Requests use adaptive thinking, an explicit effort per slot, an explicit cache breakpoint on the stable system prompt, and top-level automatic caching for the conversation tail. They never force `tool_choice`.
- Refusals fall back through the slot chain on the client side (section 9.3). The server-side `fallbacks` parameter is not used.
- For M3: trimming an old tool result in place is a history edit. It invalidates every later thinking block and the cache. Trimming must happen only at a compaction boundary, or through server-side context editing. Keep-tail compaction must strip the thinking blocks from the turns that it keeps (or rely on `drop_block`). M3 does both: it strips them, and `drop_block` stays on for the trimmed fallback. Compaction is client-side, so the summary can follow the five-heading format and its validation. Server-side compaction is not used.

### 8.4 System prompt

Built in two parts so prompt caching works:

- **Stable part** (cached): base instructions for OK Computer, the persona files from `workspace/` (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`), `MEMORY.md` (main session only), the skills index, and tool descriptions. Per-file cap 20,000 characters, total cap 60,000; truncated files get a note that tells the model to read the file directly.
- **Volatile part**: current time in the owner's time zone, the channel, today's goals with status, and the next three scheduled automations (not the heartbeat). It is not in the system prompt, because a system prompt that changes every run breaks the cache and the thinking blocks. The agent loop records it as a `context` event at the start of each run, and the strategy renders it as a `<context>` text block in that run's user turn.

Tool descriptions travel in the provider's `tools` parameter, not in the stable text.

Base instructions must cover: who the agent is, the owner's time zone, when to stay silent (`NO_REPLY`), how to use the goals and automations tools, how to write memory, and that content inside untrusted markers is data and never instructions.

## 9. Model layer

### 9.1 Interface

```ts
interface ModelClient {
  provider: string;
  // ModelCall is a ModelRequest plus model, maxTokens and effort from the slot.
  complete(call: ModelCall, signal?: AbortSignal): Promise<ModelResponse>;
}

interface ModelResponse {
  content: ContentBlock[];          // provider-native blocks kept for replay
  toolCalls: ToolCall[];            // normalized
  text: string;                     // normalized final text
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  model: string;
  latencyMs: number;
  warnings?: string[];              // input changes the provider reports, e.g. dropped thinking blocks
}
```

Adapters throw a `ModelError` with kind `transient`, `request`, or `aborted`. The SDKs' own retries are off; the slot chain owns retries.

### 9.2 Adapters

- **anthropic**: official SDK. Prompt caching on the stable system prompt and the conversation prefix. Adaptive thinking. Effort from slot config. Check `stopReason` before reading content; on `refusal`, try the next model in the chain and log it. Follow the `claude-api` skill for request shapes; do not guess API fields.
- **openai-compatible**: `openai` package with `baseURL` and optional key. Maps tools to function calling. Used for Ollama and similar local servers.
- **fake**: scripted responses for tests. Records every request it receives.

### 9.3 Slots

Config maps each slot to an ordered chain of models. Defaults:

| Slot | Default chain | Used for |
|---|---|---|
| `main` | `anthropic/claude-sonnet-5-5`, then `anthropic/claude-opus-5-5` | Owner conversations |
| `heartbeat` | `anthropic/claude-haiku-5-5` | Heartbeat checks |
| `utility` | `anthropic/claude-haiku-5-5` | Titles, short classification |
| `batch` | `anthropic/claude-haiku-5-5` | Bulk triage (later: local model) |
| `consolidation` | `anthropic/claude-sonnet-5-5` | Nightly memory |
| `compaction` | `anthropic/claude-sonnet-5-5` | Compaction summaries |

Failover: retry the same model once on a transient error (429, 5xx, network) with backoff, then move to the next model. Do not fail over on 400-class request errors; log and fail the run.

### 9.4 Cost

A pricing table in config gives input, cached input, cache write, and output prices per million tokens per model. Every model call attempt, failed or not, writes a `model_calls` row: `runId, slot, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, latencyMs, stopReason, error, request, response, createdAt`. `request` and `response` hold the full redacted JSON for the run detail view. Unknown models get a cost of null, not zero.

Current Claude prices per million tokens (verify against the skill before use): Opus 5.5 $4 input, $0.20 cached input, $20 output. Sonnet 5.5 $2, $0.20, $10. Haiku 5.5 $0.10 input, $0.50 output.

## 10. Channels

```ts
interface ChannelAdapter {
  id: string;                                   // 'telegram' | 'cli'
  start(onMessage: (m: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(out: OutboundMessage): Promise<{ messageId: string }>;
}
interface OutboundMessage { chatId: string; text: string; buttons?: Button[][] }
```

- **cli**: a terminal chat for development (`npm run chat`). It counts as the owner. Buttons show as numbered choices.
- **telegram**: grammY with long polling. Owner is set by `TELEGRAM_OWNER_ID`. Split messages over 4,096 characters at paragraph boundaries. Escape formatting safely, or send plain text. Inline keyboard buttons for approvals. If `TELEGRAM_BOT_TOKEN` is missing, the adapter does not start and the log says so. The process still runs with the cli channel.
  - M3 sends plain text with no parse mode. A split falls back from paragraphs to lines, then words, then a hard cut that never breaks a surrogate pair. Buttons go on the last part.
  - Polling runs in the background, so a network failure is logged and the cli keeps working. A button press is answered (`answerCallbackQuery`) and becomes an inbound message with `button`. Messages without text are logged and ignored. Messages and button presses from a chat that is not private (a group or a channel) are also logged and ignored, so an owner message in a group never gets an answer there and never becomes the main chat.
  - Telegram starts only when both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` are set, and never in `npm run chat`. The owner id is not registered as a secret.
  - The cli runs in chat mode, when Telegram does not run, or when stdin is a terminal. When Telegram runs, the end of cli input does not stop the process.
- The owner's main chat for proactive messages is the most recent chat the owner used, stored in the database (`settings.owner_chat`), with Telegram preferred when configured. Before the first owner message it is the cli, when the cli runs. In M3 the order is: the saved chat when it is not the cli, then the owner's private Telegram chat (its chat id is `TELEGRAM_OWNER_ID`), then a saved cli chat, then the cli.
- An inbound message can carry `button` (the data of a pressed button). Such a message never goes to the model.

## 11. Scheduler

### 11.1 Automations

Table `automations`: `id, name, schedule (json), payload (json), sessionMode (isolated | main), slot, enabled, createdBy (owner | agent | system), createdAt, updatedAt, nextRunAt, lastRunAt, consecutiveFailures`.

Schedule kinds:
- `{ kind: 'at', at: iso }`: one-shot. Disable after a successful run.
- `{ kind: 'every', everyMs, anchor? }`: fixed interval.
- `{ kind: 'cron', expr, tz }`: cron expression through croner. Default time zone from config (`America/Los_Angeles`).

Payloads:
- `{ type: 'agent', prompt, condition? }`: a run with this prompt in a fresh isolated session (or the main session when `sessionMode` is `main`). With `condition: 'no_goals_today'` the run is skipped in code, without a model call, when today already has goals.
- `{ type: 'system_event', text }`: append to the main session without a model call. The next run sees it.
- System payloads that only code creates: `{ type: 'heartbeat' }`, `{ type: 'goal_checkin', goalId }`, `{ type: 'goals_results' }`, and `{ type: 'consolidation' }`. The agent's tools can change their schedule and enabled state, but not their payload.

Behavior:
- The scheduler computes `nextRunAt` for all enabled automations and sleeps until the earliest one, but never more than one minute, because a timer can fire late after the PC sleeps. It re-plans when automations change.
- Before a job starts, the scheduler moves `nextRunAt` to the next time ("claims" the job), so a second tick during a long job does not run it again.
- Missed runs (the PC was off): run once if missed by less than a configurable grace period (default 2 hours), then plan the next time from now. Do not replay every missed slot. A miss outside the grace period writes a `skipped` run.
- Each run writes an `automation_runs` row: `automationId, runId, status (completed | failed | skipped), startedAt, endedAt, error`.
- Failures back off: 30s, 1m, 5m, 15m. A retry never comes later than the next normal run. After 5 consecutive failures, disable the automation and tell the owner.
- An `every` interval must be at least one minute. A one-shot time in the past is refused.
- Text from an isolated run goes to the owner and is also appended to the main session as a `system_event`, so the main conversation knows what the owner answers to.
- Automations that the agent creates through tools have `createdBy: 'agent'`. `automations_list` leaves out one-shot automations that already ran.

### 11.2 Heartbeat

- A system automation, interval from config (`heartbeat.every`: `15m`, `30m`, `1h`, or `0` to turn off; default `30m`). The app syncs the automation with the config at each start. The owner can pause it with the automations tools; a restart turns it on again only when the interval in the config changed.
- Active hours from config (default 08:00 to 23:00 in the owner's time zone). Outside those hours the heartbeat does not run.
- It runs in a fresh `heartbeat:<runId>` session on the `heartbeat` slot with a light context: base instructions, `USER.md`, the heartbeat checklist, today's goals with status and ETAs, the next automations, and the last 5 heartbeat notifications (to avoid repeats).
- The stable prompt of a heartbeat session is the base instructions, `USER.md`, and the heartbeat rules. The checklist and the last 5 notifications go in the run's first `system_event`; today's goals and the next automations come from the `context` event.
- The checklist is a row in a `settings` table, editable from chat (through a tool) and from the dashboard. It is empty by default. An empty checklist skips the run without a model call.
- The last 5 notifications come from the `tool_calls` rows of `heartbeat_respond` with `notify: true`. A sent notification is also appended to the main session as a `system_event`.
- The model answers by calling `heartbeat_respond { notify: boolean, text?: string, checklist?: string }`, or by replying `NO_REPLY`. Only `notify: true` sends a message.
- Skip the heartbeat if the main session has a run in progress.

## 12. Goals domain and the three-goals routine

Tables:
- `goals`: `id, day (YYYY-MM-DD, owner time zone), title, eta (iso, nullable), status (open | done | dropped), createdAt, completedAt, note`.
- `goal_checkins`: `id, goalId, askedAt, answer (done | not_yet | dropped | no_answer), answeredAt`.

Tools: `goals_set` (one or more goals for a day, with optional ETAs), `goals_list` (a day or a range), `goal_update` (status, ETA, note), `goals_stats` (hit rate and streaks for a range).

Routine, created at first run as system automations so the owner can edit them. A `settings` flag records the install, so an automation that the owner deletes does not come back. All routine runs use the main session, so the owner answers in the same conversation.
1. At 19:00 every day: ask the owner for today's three goals and an ETA for each. The ask is skipped in code when today already has goals.
2. At 20:00, 21:00, and 22:00: if no goals exist for today, send a short reminder. Stop after the first goals are set (the `no_goals_today` condition, checked in code).
3. When a goal gets an ETA, schedule a one-shot check-in at that time. The check-in asks if the goal is done. If the answer is "not yet", the agent asks for a new ETA and schedules again. A new ETA or a closed goal replaces the planned check-in; a check-in for a goal that is no longer open is skipped. `goal_update` records the answer of the open check-in (`done`, `not_yet`, `dropped`); an open check-in gets `no_answer` when the next one starts or the day ends.
4. At 23:45 (`routine.resultsAt`) code writes the day's results from the database to the daily note, under `## goals`, `## done`, and `## slipped and why`. There is no model call. The reason for a slip comes from the goal's note.

ETAs are `HH:MM` in the owner's time zone on the goal's day, or an ISO time with an offset. All times in `routine` are in config.

The owner can change all times by chat ("move the goals question to 8pm"). The agent does this with the automations tools.

## 13. Memory

Files (under `data/memory/`, gitignored):
- `daily/YYYY-MM-DD.md`: the day's note. Sections: `## goals`, `## done`, `## slipped and why`, `## notes`, `## mood and energy`. The agent appends through `memory_write`.
- `MEMORY.md`: curated long-term facts and preferences. Bounded to 8,000 characters. Loaded into the main session's stable prompt.
- `weekly/YYYY-Www.md`: weekly trend summary written by consolidation.

Search: an SQLite FTS5 index over all memory files, chunked by heading and paragraph (about 400 tokens per chunk). Reindex a file when it changes. Tools: `memory_search { query, limit }` and `memory_get { path, fromLine?, lines? }`. Embedding search is a later feature.

Nightly consolidation, a system automation at 03:00:
1. Read yesterday's daily note, the goal statistics for the last 7 and 30 days from the database, the current weekly file, and `MEMORY.md`.
2. On the `consolidation` slot, update the weekly file with trends (hit rate, common reasons for slips, best and worst times of day) and propose changes to `MEMORY.md`.
3. Apply `MEMORY.md` changes only if the result stays under the size limit. Keep the previous version as `MEMORY.md.bak-YYYY-MM-DD` under `data/memory/history/`.
4. Write a short entry to `data/memory/consolidation-log.md`.
Statistics come from the database, never from the model's reading of notes.

Decisions from M3:

- **Writes.** `memory_write { text, section = 'notes', day? }` writes only to daily notes. A write goes to the end of its section, and a missing section goes in the fixed order. Sections that the owner adds by hand stay in place, and the 23:45 day results use the same writer. `MEMORY.md` changes only through consolidation. An edit during a session would change the stable prompt on every write.
- **Search.** Chunks are about 1,600 characters. They break at each heading and keep the heading path (`2026-10-12 > notes`) and their line numbers. Each `memory_search` first indexes again the files whose size or time changed and removes deleted files, so no watcher is needed. `history/` is not indexed. Each query word is quoted and joined with `OR`, and results are ranked by bm25. `memory_get` refuses paths outside `data/memory/`.
- **Consolidation run.** The automation runs at `memory.consolidateAt` (default 03:00). It is installed one time, with a `settings` flag, like the routine. It runs in `consolidate:<run date>` with trigger `consolidation` and the only tool `consolidation_save { weeklyTrends, memory?, logNote }`. Its stable prompt is the base instructions, `USER.md`, and the consolidation rules. Its first `system_event` holds the inputs of step 1.
- **Weekly file.** Code writes the weekly file of the consolidated day's ISO week: a `## stats` section from the database, then the model's `## trends`. The stats are the 7- and 30-day hit rate, the on-time count, the streaks, and the counts of done goals and of slipped or late goals for each part of the day.
- **MEMORY.md.** A `memory` over 8,000 characters is refused with an error that asks for a shorter text. The weekly file and the log line are still written. Before a change, the first backup of the run date goes to `history/MEMORY.md.bak-<date>` and is not overwritten later that day.
- **Failure.** A run that ends without a successful `consolidation_save` fails the job, so the scheduler backoff retries it.

## 14. Tools, policy, approvals

### 14.1 Registry

```ts
interface Tool<I> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  risk: 'read' | 'write' | 'external';  // external = leaves the machine or changes accounts
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}
```

The registry converts zod schemas to JSON Schema for the providers, in input mode, so a field with a default is optional for the model. Each session type has an allowlist of tools. Heartbeat and consolidation sessions get only the tools they need:

- main: goals tools, automations tools, `heartbeat_checklist_set`, `memory_write`, `memory_search`, `memory_get`, `now`.
- isolated automation runs: goals tools, `automations_list`, `automations_create`, `automations_update`, `memory_write`, `memory_search`, `memory_get`, `message_owner`, `now`.
- heartbeat: `goals_list`, `heartbeat_respond`, `now`.
- consolidation: `consolidation_save`.

Phase 1 tools: `goals_set`, `goals_list`, `goal_update`, `goals_stats`, `automations_list`, `automations_create`, `automations_update`, `automations_delete`, `memory_write`, `memory_search`, `memory_get`, `heartbeat_respond`, `heartbeat_checklist_set`, `consolidation_save`, `skill_read`, `message_owner` (send a message now; used by isolated runs), `now` (current time in the owner's zone).

There is no shell tool, no file write tool outside `data/memory/`, and no network tool in Phase 1.

### 14.2 Approvals

- Table `approvals`: `id, runId, toolName, input (json), summary, status (pending | approved | denied | expired), requestedAt, resolvedAt, resolvedBy`.
- A tool with risk `external` (and any tool marked `needsApproval`) creates an approval instead of running. The owner gets a message with Approve and Deny buttons. The cli shows numbered choices, and typing the number right after the message presses that button. The dashboard can approve too.
- The run does not stay open for up to 24 hours. The tool result tells the model that approval #id is pending, and the run ends normally. When the owner decides, the tool runs with the stored input (stored without redaction so that it runs unchanged), a `tool_calls` row is written for the original run, and a `system_event` with the decision and the result is appended to the original session through its run queue. The next run of that session sees it. There is no automatic follow-up run.
- Free text such as "yes" never approves. Only a button, `/approve <id>` or `/deny <id>`, or the dashboard. The router handles these before the model, and only for the owner.
- Approval ids are small integers, so the owner can type them. Pending approvals expire after 24 hours; each scheduler tick marks them `expired`.
- Phase 1 has no `external` tools, but the mechanism and its tests ship in Phase 1 so later tools can use it.

### 14.3 Untrusted content

Any text from outside the owner (email, web pages, files from the web) is wrapped as:

```
<untrusted source="gmail:..." >
...
</untrusted>
```

The base instructions say that this content is data and never instructions. Strip any closing tags that appear inside the content.

## 15. Skills

- A skill is a folder in `skills/` with a `SKILL.md`. Frontmatter requires `name` and `description`.
- The stable prompt lists each skill's name, description, and path. The model reads the full file with `skill_read` when a task matches.
- Reload the index when files change.
- Skill Workshop (the agent writes and updates skills after long or corrected tasks) is Phase 3.

Decisions from the review after M4:

- The folder is `config.paths.skills` (default `skills`). The loader is `src/skills/skills.ts`.
- There is no file watcher. The app reads the folder again for each stable prompt and each `skill_read` call, so a changed file is used on the next run. The stable prompt changes only when a skill changes.
- The frontmatter parser reads only one-line `key: value` fields. A skill without `name` or `description` is left out.
- Only sessions that have `skill_read` (main and automation runs) get the index. `skill_read` finds the file by the skill name, never by a path.

## 16. Observability

### 16.1 Data

Everything below is queryable from SQLite:
- `runs`, `events`, `model_calls`, `tool_calls` (`runId, name, input, output, isError, durationMs, createdAt`; full payloads stored), `automation_runs`, `approvals`.
- A structured JSON-lines log in `data/logs/okc-YYYY-MM-DD.log` (UTC date) with levels. The same lines go to stderr at a configurable level (`warn` in `npm run chat`), so the cli chat on stdout stays readable. Redact secrets (API keys, bot tokens) in every log line and every stored payload.

### 16.2 Dashboard

- Hono server on `127.0.0.1` (port from config, default 4317). Loopback only. Optional `DASHBOARD_TOKEN` for future remote access.
- JSON API under `/api/*`. Live updates through server-sent events at `/api/stream` (new events, run status, log lines).
- Pages:
  - **Overview**: today's cost, runs, errors, open goals, next 5 automations, heartbeat status.
  - **Runs**: list with filters (trigger, slot, status, date). Run detail is a timeline: each model call (model, tokens, cache hits, cost, latency, full request and response on expand) and each tool call (input, output, duration, errors).
  - **Sessions**: list and full transcript with compaction markers. A toggle shows "what the model saw" (the context view) next to the raw log.
  - **Automations**: list, schedule in plain words, next run, history, enable and disable, run now.
  - **Goals**: today, history, hit rate and streak charts.
  - **Memory**: browse daily, weekly, and `MEMORY.md` files; consolidation log.
  - **Approvals**: pending and history; approve and deny.
  - **Cost**: by day, slot, and model.
  - **Logs**: live tail with level filter.
- Phase 1 write actions are limited to: toggle automation, run automation now, edit heartbeat checklist, approve or deny.

Decisions from M4:

- **Where it runs.** `src/main.ts` starts the dashboard after the app, on `dashboard.port` (default 4317), except in `npm run chat`. A dashboard that cannot start (for example, the port is in use) logs an error, and the agent keeps running. `web/dist` is served from the same server; routes are in the URL hash, so only `index.html` and the assets are needed. `npm run dev:web` runs the Vite dev server with a proxy to the API.
- **Access.** The server listens on `127.0.0.1` only. It refuses requests whose host name is not a loopback name (this stops DNS rebinding), and it takes writes only with a JSON content type (a form post from another web page then needs a CORS preflight, which the server never allows). When `DASHBOARD_TOKEN` is set, every `/api/*` request must give it as a bearer header or as `?token=`, because `EventSource` cannot send headers.
- **Stream.** `/api/stream` polls the database and today's log file each second for each client: new events by id, new runs by rowid, a status change of each run it saw running, and complete new log lines. It needs no hooks in the writers, so it also sees rows that another process writes. The page closes its stream on `pagehide`, because the browser allows only six connections to one host.
- **Run timeline.** A fixed clock gives rows the same time, so the timeline is not sorted by time. Each tool call goes after the model call whose response asked for it (matched by tool call id). A tool call that ran after an approval goes last. The full request and response of a model call load on demand from `/api/model-calls/:id`.
- **What the model saw.** `App.contextView(sessionKey)` runs the session's real strategy over the full log, with the session's stable prompt and tool allowlist and without compaction hooks, so it never calls a model or appends an event. It shows the input of the next model call. It can differ from an earlier call in two cases: the stable prompt files changed since then, or that run used the trimmed fallback after a failed compaction. The exact input of each past call is in the run detail.
- **Run now** runs the automation through the normal job runner and writes an `automation_runs` row, but it does not change `nextRunAt` or the failure count. The job gets the current time as its planned time, so a job that works on a day (consolidation, goals results) uses the day of the click, not the day of the next planned run. The API answers at once with 202; the run shows in the stream.
- **Approvals.** The dashboard shows the redacted summary of an approval, never the stored input, because the input is not redacted.
- **Plain words.** A daily cron (`M H * * *`) is described as "every day at HH:MM" before the cron text, also in the tool output.
- **Charts** are single-series SVG bars (daily hit rate, the streak of days with goals, cost by day) with a native tooltip on each day. Tables carry the same numbers.
- **Tests.** `test/seed.ts` fills a database through the real app and a fake model: runs with tool calls, a failed tool, a failed model call, a heartbeat, a compaction, approvals, goals over several days, memory files and log lines. The API tests and the jsdom page tests (`web/src/pages.test.tsx`) run against it.

## 17. Configuration

- Secrets in `.env`: `CLAUDE_API_KEY` (also accept `ANTHROPIC_API_KEY`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, optional `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `DASHBOARD_TOKEN`.
- Non-secret settings in `okc.config.json`, validated with zod, with defaults for every field: time zone, slot chains, pricing, missed-run grace (`scheduler.missedGraceMs`), heartbeat interval and active hours, routine times (`routine.askAt`, `routine.reminders`, `routine.resultsAt`), the consolidation time (`memory.consolidateAt`), the context budget (`context.windowTokens`), the dashboard port (`dashboard.port`), paths.
- Invalid config stops the process at start with a clear message.

## 18. Process and operations

- `npm run dev`: start everything with reload. `npm start`: run the build. `npm run chat`: cli channel only. `npm run dev:web`: the dashboard UI with hot reload. `npm test`, `npm run typecheck`, `npm run build` (server and web).
- Graceful shutdown on SIGINT and SIGTERM: stop channels, finish or abort active runs with a recorded status, close the database.
- Database migrations are numbered SQL files applied at start inside a transaction, tracked in a `migrations` table.
- Running as a service in WSL (systemd user unit) is a later task. Keep the process friendly to it: log to stdout and files, exit non-zero on fatal errors.

## 19. Testing

- Every module has unit tests. Use the fake model provider; tests never call a real model.
- Integration tests drive the full loop through the cli adapter in memory: an owner message goes in, scripted model responses call tools, the database and the outbound messages are checked.
- Scheduler tests use an injectable clock. Never sleep in tests.
- Context tests cover: trimming, compaction trigger, validation failure and abort, prefix stability, and replay of assistant blocks.
- `npm run smoke` makes one real call per configured provider on the cheapest model with a tiny prompt and prints the cost. It is not part of `npm test`. Run it at most a few times.
- `typecheck` and `test` must pass before each commit.

## 20. Milestones and acceptance criteria

**M1. Foundation.** Scaffold, config, database and migrations, event log, model layer (anthropic, openai-compatible, fake), slots and cost, tool registry, agent loop, cli channel, system prompt builder, structured logger.
Done when: `npm run chat` holds a conversation through the fake provider in tests and through Claude in a manual smoke run; every call is in `model_calls` with a cost; the event log has no update or delete paths.

**M2. Scheduling and goals.** Automations with all schedule kinds, missed-run handling, backoff, heartbeat with active hours and checklist, goals tables and tools, the three-goals routine, check-ins at ETAs, approvals mechanism.
Done when: tests with a fake clock show the full evening routine (ask, remind, set goals, check-ins, results to the daily note); heartbeat stays silent on an empty checklist and outside active hours; approvals cannot be resolved by free text.

**M3. Memory, context, Telegram.** Daily notes, `MEMORY.md`, FTS5 search, nightly consolidation, trim-and-compact strategy with memory flush and validation, Telegram adapter with owner allowlist and buttons.
Done when: tests show compaction summaries with all headings, an aborted compaction on validation failure, raw history unchanged after compaction, and consolidation stats taken from the database; the Telegram adapter is covered by tests with a mocked bot API.

**M4. Observability dashboard.** Hono API, SSE stream, and the React pages in section 16.2.
Done when: every page loads against a seeded test database; run detail shows the full timeline; the "what the model saw" view matches the context strategy output.

## 21. Conventions

### 21.1 Code comments

- Comments are full sentences in all lower case, including the first word. Code identifiers inside a comment keep their real case.
- Follow ASD-STE100 Simplified Technical English:
  - one topic per sentence; descriptive sentences at most 25 words, instructions at most 20 words;
  - active voice and simple tenses (present, past, future);
  - one word for one meaning, and the same word for the same thing every time;
  - no more than three nouns in a row;
  - keep articles ("the", "a");
  - no slang, no idioms, no jokes;
  - use a list when a sentence has more than two parts.
- Comment why, not what. Most functions need no comment. Do not restate the code.
- Do not mention any other agent project by name in comments, docs inside `src/`, or commit messages.

Example:

```ts
// the scheduler runs a missed job one time only. this prevents a burst of old reminders after the pc starts.
```

### 21.2 Commits

- Commit after each coherent step that passes `typecheck` and `test`. Small commits are better than large ones.
- Style follows the owner's history: a lower-case conventional prefix (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`), a lower-case subject that says what changed, and for larger changes a body in lower-case prose that explains why and how, wrapped near 75 characters. Examples from the owner's history:

  ```
  feat: sync strava api activities into neon via webhook + daily cron

  new activities rebuild their route from the streams api and go through the
  same privacy trim/publish pipeline as uploads. strava renames/edits patch the
  row, private activities stay hidden, and deletes are verified against strava
  before hiding. capped at 25 new activities per run for the read rate limit.
  ```

  ```
  chore: pad problem numbers to 4 digits in filenames
  ```

  ```
  fix: revert cursor motion smear, event-driven halo with working hover + looser shake-to-find
  ```

- End every commit message with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit `.env`, `data/`, or anything with personal data or secrets. Check `git status` before each commit.
- Do not push. There is no remote.

### 21.3 Code

- Small modules with clear names. No classes where a function works.
- Typed results for expected failures; exceptions for bugs.
- Times are stored in UTC ISO strings and shown in the owner's time zone.
- No dead code, no commented-out code, no speculative options.

### 21.4 Third-party code

If you copy a substantial part of any MIT-licensed project, add that project's copyright and license text to `THIRD_PARTY_NOTICES.md`. The license requires this. Do not put attributions in code comments.
