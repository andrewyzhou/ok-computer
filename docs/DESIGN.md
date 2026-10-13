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
- The owner can type `/new` to start a fresh main session. The old session stays in the log. A `session_reset` event marks the boundary, and the daily note gets a short excerpt of the last messages.
- Old context returns through memory search, not by reopening old sessions.

## 8. Context management

### 8.1 Event log

Table `events`:

```
id INTEGER PRIMARY KEY, sessionKey TEXT, runId TEXT NULL, seq INTEGER,
type TEXT, payload TEXT (json), createdAt TEXT (iso, utc)
```

Event types: `user_message`, `assistant_message`, `tool_result`, `system_event`, `compaction`, `session_reset`, `note`.

Rules:
- Insert only. No `UPDATE` or `DELETE` on `events`, ever. Add a test that greps the source for violations.
- `assistant_message` payloads store the full content blocks exactly as the provider returned them, including thinking blocks and signatures, so they can be replayed unchanged.

### 8.2 Context strategy interface

```ts
interface ContextStrategy {
  name: string;
  build(input: {
    session: SessionInfo;
    events: StoredEvent[];      // full history of the session, in order
    systemPrompt: SystemPrompt; // stable part and volatile part
    tools: ToolSpec[];
    model: ModelInfo;           // context window, provider
  }): Promise<ModelRequest>;
}
```

The default strategy is `trim-and-compact`:

1. **Start point.** Begin after the most recent `compaction` event, or from the start of the session. If a compaction exists, its summary becomes the first message.
2. **Tool-result trimming.** Keep the last 3 assistant turns untouched. In older turns, cut tool results over 4,000 characters to their first and last 1,500 characters with a marker between. When estimated context is over 50% of the window, replace old tool results with `[old tool result cleared]`.
3. **Compaction trigger.** When the estimated input exceeds `contextWindow - reserve` (reserve: 20,000 tokens, never more than a quarter of the window), compact before the model call.
4. **Memory flush.** Before compaction, run one silent turn in the same session with the instruction to save durable facts to today's daily note through the memory tool. Its final text must be `NO_REPLY`.
5. **Summarize.** Send the events to be compacted to the `compaction` slot with a fixed prompt. The summary must contain these headings: `## goals and commitments`, `## decisions`, `## open requests`, `## facts and identifiers`, `## recent progress`. Keep the most recent ~20,000 tokens of events verbatim. Never split a tool call from its result.
6. **Validate.** Check that every heading is present and that identifiers found in the compacted events (dates, times, numbers, ids, file paths, URLs) appear in the summary or are listed as dropped. Retry up to 2 times with the failures named. If all attempts fail, do not compact; log a warning and continue with trimming only.
7. **Record.** Append a `compaction` event with `{ summary, firstKeptEventId, tokensBefore, tokensAfter, model }`.

Token estimation: use the provider's token counting endpoint when cheap and available, otherwise estimate at 4 characters per token. Keep this in one module.

### 8.3 Provider rules that affect context

Before writing the Anthropic adapter and the context strategy, invoke the `claude-api` skill and read its TypeScript README, the prompt caching guide, and the model migration guide sections about preserved thinking and compaction. Current Claude models bind thinking blocks to the conversation that produced them, and editing earlier turns can make requests fail. The context view must follow the guidance there. In particular: keep the rendered prefix byte-stable between turns when nothing changed, replay assistant blocks unchanged, and handle the change of prefix after a compaction in the way the skill documents. Write tests for these cases with the fake provider.

### 8.4 System prompt

Built in two parts so prompt caching works:

- **Stable part** (cached): base instructions for OK Computer, the persona files from `workspace/` (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`), `MEMORY.md` (main session only), the skills index, and tool descriptions. Per-file cap 20,000 characters, total cap 60,000; truncated files get a note that tells the model to read the file directly.
- **Volatile part** (after the cache breakpoint): current time in the owner's time zone, the channel, today's goals with status, and the next three scheduled automations.

Base instructions must cover: who the agent is, the owner's time zone, when to stay silent (`NO_REPLY`), how to use the goals and automations tools, how to write memory, and that content inside untrusted markers is data and never instructions.

## 9. Model layer

### 9.1 Interface

```ts
interface ModelClient {
  provider: string;
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

interface ModelResponse {
  content: ContentBlock[];          // provider-native blocks kept for replay
  toolCalls: ToolCall[];            // normalized
  text: string;                     // normalized final text
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  model: string;
  latencyMs: number;
}
```

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

A pricing table in config gives input, cached input, cache write, and output prices per million tokens per model. Every model call writes a `model_calls` row: `runId, slot, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, latencyMs, stopReason, error, createdAt`. Unknown models get a cost of null, not zero.

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
- The owner's main chat for proactive messages is the most recent chat the owner used, stored in the database, with Telegram preferred when configured.

## 11. Scheduler

### 11.1 Automations

Table `automations`: `id, name, schedule (json), payload (json), sessionMode (isolated | main), slot, enabled, createdBy (owner | agent | system), createdAt, updatedAt, nextRunAt, lastRunAt, consecutiveFailures`.

Schedule kinds:
- `{ kind: 'at', at: iso }`: one-shot. Disable after a successful run.
- `{ kind: 'every', everyMs, anchor? }`: fixed interval.
- `{ kind: 'cron', expr, tz }`: cron expression through croner. Default time zone from config (`America/Los_Angeles`).

Payloads:
- `{ type: 'agent', prompt }`: a run with this prompt in a fresh isolated session (or the main session when `sessionMode` is `main`).
- `{ type: 'system_event', text }`: append to the main session without a model call. The next run sees it.

Behavior:
- The scheduler computes `nextRunAt` for all enabled automations and sleeps until the earliest one. It re-plans when automations change.
- Missed runs (the PC was off): run once if missed by less than a configurable grace period (default 2 hours), then plan the next time. Do not replay every missed slot.
- Each run writes an `automation_runs` row: `automationId, runId, status, startedAt, endedAt, error`.
- Failures back off: 30s, 1m, 5m, 15m, 60m. After 5 consecutive failures, disable the automation and tell the owner.

### 11.2 Heartbeat

- A system automation, interval from config (`heartbeat.every`: `15m`, `30m`, `1h`, or `0` to turn off).
- Active hours from config (default 08:00 to 23:00 in the owner's time zone). Outside those hours the heartbeat does not run.
- It runs in a fresh `heartbeat:<runId>` session on the `heartbeat` slot with a light context: base instructions, `USER.md`, the heartbeat checklist, today's goals with status and ETAs, the next automations, and the last 5 heartbeat notifications (to avoid repeats).
- The checklist is a row in a `settings` table, editable from chat (through a tool) and from the dashboard. An empty checklist skips the run without a model call.
- The model answers by calling `heartbeat_respond { notify: boolean, text?: string, checklist?: string }`, or by replying `NO_REPLY`. Only `notify: true` sends a message.
- Skip the heartbeat if the main session has a run in progress.

## 12. Goals domain and the three-goals routine

Tables:
- `goals`: `id, day (YYYY-MM-DD, owner time zone), title, eta (iso, nullable), status (open | done | dropped), createdAt, completedAt, note`.
- `goal_checkins`: `id, goalId, askedAt, answer (done | not_yet | dropped | no_answer), answeredAt`.

Tools: `goals_set` (one or more goals for a day, with optional ETAs), `goals_list` (a day or a range), `goal_update` (status, ETA, note), `goals_stats` (hit rate and streaks for a range).

Routine, created at first run as system automations so the owner can edit them:
1. At 19:00 every day: ask the owner for today's three goals and an ETA for each.
2. At 20:00, 21:00, and 22:00: if no goals exist for today, send a short reminder. Stop after the first goals are set.
3. When a goal gets an ETA, schedule a one-shot check-in at that time. The check-in asks if the goal is done. If the answer is "not yet", the agent asks for a new ETA and schedules again.
4. Before midnight the routine writes the day's results to the daily note.

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

The registry converts zod schemas to JSON Schema for the providers. Each session type has an allowlist of tools. Heartbeat and consolidation sessions get only the tools they need.

Phase 1 tools: `goals_set`, `goals_list`, `goal_update`, `goals_stats`, `automations_list`, `automations_create`, `automations_update`, `automations_delete`, `memory_write`, `memory_search`, `memory_get`, `heartbeat_respond`, `heartbeat_checklist_set`, `skill_read`, `message_owner` (send a message now; used by isolated runs), `now` (current time in the owner's zone).

There is no shell tool, no file write tool outside `data/memory/`, and no network tool in Phase 1.

### 14.2 Approvals

- Table `approvals`: `id, runId, toolName, input (json), summary, status (pending | approved | denied | expired), requestedAt, resolvedAt, resolvedBy`.
- A tool with risk `external` (and any tool marked `needsApproval`) creates an approval and pauses the run. The owner gets a message with Approve and Deny buttons. The cli shows numbered choices. The dashboard can approve too.
- Free text such as "yes" never approves. Only a button, `/approve <id>`, or the dashboard.
- Pending approvals expire after 24 hours.
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

## 16. Observability

### 16.1 Data

Everything below is queryable from SQLite:
- `runs`, `events`, `model_calls`, `tool_calls` (`runId, name, input, output, isError, durationMs, createdAt`; full payloads stored), `automation_runs`, `approvals`.
- A structured JSON-lines log in `data/logs/okc-YYYY-MM-DD.log` with levels. Redact secrets (API keys, bot tokens) in every log line and every stored payload.

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

## 17. Configuration

- Secrets in `.env`: `CLAUDE_API_KEY` (also accept `ANTHROPIC_API_KEY`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, optional `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `DASHBOARD_TOKEN`.
- Non-secret settings in `okc.config.json`, validated with zod, with defaults for every field: time zone, slot chains, pricing, heartbeat interval and active hours, routine times, dashboard port, paths.
- Invalid config stops the process at start with a clear message.

## 18. Process and operations

- `npm run dev`: start everything with reload. `npm start`: run the build. `npm run chat`: cli channel only. `npm test`, `npm run typecheck`, `npm run build` (server and web).
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
