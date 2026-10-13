# OK Computer

A personal life-coach / executive-assistant agent that texts you through the day: it asks for your daily goals, follows up on them, watches your calendar and email for things you might forget, and does bigger jobs (inbox and subscription cleanup) on request.

It runs on this PC. Its persona files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and a local, gitignored `USER.md`) live in [workspace/](workspace/). The full system design is in [docs/DESIGN.md](docs/DESIGN.md).

## Decisions so far

- **Model-agnostic.** One model interface; any provider (Claude, GPT, local via Ollama/vLLM) is a config change.
- **Model routing by role, not by guessing.** Each job type has a fixed model slot (main chat, heartbeat, background/utility, batch triage, summarizer), with a fallback chain per slot.
- **Channels are adapters.** Telegram first; iMessage/SMS later without touching the core.
- **Raw history is never lost.** Every message, tool call and result goes into an append-only event log. What the model sees each turn is computed from that log by a swappable context strategy (tool-result clearing + structured compaction first; retrieval or recursive-LM strategies later), so a better strategy can be rerun over the full history.
- **Exact scheduling + heartbeat.** Automations fire at exact times; a heartbeat with a configurable interval (15m / 30m / 1h) and quiet hours handles "anything worth telling them?" checks.
- **Gmail and Calendar by polling every 15 minutes.** No push watcher.
- **Memory:** daily notes → nightly consolidation ("dreaming") into long-term memory and weekly trend summaries, so goal/productivity history can be tracked without rereading every note.
- **Skill Workshop:** the agent turns repeated or corrected procedures into skills (`SKILL.md` format).
- **Safety in code, not prompts:** narrow tool set, approval buttons for anything that sends/deletes/pays/unsubscribes, email and web content marked untrusted.
- **Big observability UI:** every turn, tool call, model, token count, cost and error is logged and browsable in a web dashboard.
- **Language:** TypeScript on Node.js.

## Running it

`scripts/okc.ps1 install` adds an `okc` command, an "OK Computer" desktop shortcut, and a logon task that starts the agent in the background.

| Command | What it does |
|---|---|
| `okc` | Build if needed, start in the background, open the dashboard |
| `okc stop` / `okc restart` | Stop or restart the agent |
| `okc status` | Show whether it runs, the dashboard URL, and recent restarts |
| `okc logs` | Follow the agent log |
| `okc open` | Open the dashboard at http://127.0.0.1:4317 |

To connect MCP servers (optional), see [docs/setup/integrations.md](docs/setup/integrations.md). To connect Gmail and Google Calendar, see [docs/setup/google.md](docs/setup/google.md).

A small supervisor restarts the agent if it stops. The logon task means it runs whenever you are signed in to Windows.

`npm run chat` uses the same database as the background agent. That is fine, but do not chat with it while the agent is answering you in Telegram at the same moment: two processes in one conversation can give the same tool call two results. `npm run chat` never connects to MCP servers: only the background agent does, so each server runs once and an OAuth token is refreshed by one process.

## Phases

1. **Core coach (done):** Telegram adapter, agent loop, workspace files, scheduler (automations + heartbeat), 3-goals routine, daily notes + nightly consolidation into weekly trends, run logging, first version of the observability dashboard.
2. **Foundation and core accounts:** full tracing v2, MCP client and integration registry, Gmail (all accounts) + Calendar, Telegram v2. See [docs/DESIGN-NEXT.md](docs/DESIGN-NEXT.md).
3. **More reach:** Slack, web search + browser worker, reviewer model + taint + sub-agents.
4. **Power tools:** Skill Workshop.

On hold: Claude history (a later design should cover ChatGPT logs too) and the Docker sandbox. The subscription sweep is an owner test of the agent with Gmail, not a separate feature.

## TODO (later)

- [ ] iMessage channel (needs a Mac) and/or SMS
- [ ] Web dashboard features beyond observability (goals board, approvals inbox)
- [ ] Agent-built widgets/dashboards (on hold; Telegram can't display them)
- [ ] Mid-reply steering (new texts adjust a reply in progress)
- [ ] Event triggers (script detects a condition → wake the agent)
- [ ] Inbound webhooks
- [ ] Docker sandbox for shell commands (on hold until there is a use case)
- [ ] Claude and ChatGPT history import (on hold)
- [ ] Voice replies / voice notes, PDF and image understanding
- [ ] Spending alerts
- [ ] Move more work to a local model as hardware allows
- [ ] iOS app / web app front end
- [ ] Product version (multi-user, Google CASA audit, per-user isolation)
