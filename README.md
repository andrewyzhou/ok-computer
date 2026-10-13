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

## Phases

1. **Core coach (done):** Telegram adapter, agent loop, workspace files, scheduler (automations + heartbeat), 3-goals routine, daily notes + nightly consolidation into weekly trends, run logging, first version of the observability dashboard.
2. **Accounts and browser:** Google Calendar + Gmail (all accounts, OAuth, 15-min polling), browser control, approval gates.
3. **Depth:** Skill Workshop, sub-agents, compaction, email + bank subscription sweep (local model triage, Plaid).

## TODO (later)

- [ ] iMessage channel (needs a Mac) and/or SMS
- [ ] Web dashboard features beyond observability (goals board, approvals inbox)
- [ ] Agent-built widgets/dashboards (on hold; Telegram can't display them)
- [ ] Mid-reply steering (new texts adjust a reply in progress)
- [ ] Event triggers (script detects a condition → wake the agent)
- [ ] Inbound webhooks
- [ ] Docker sandbox for shell commands
- [ ] Voice replies / voice notes, PDF and image understanding
- [ ] Spending alerts
- [ ] Move more work to a local model as hardware allows
- [ ] iOS app / web app front end
- [ ] Product version (multi-user, Google CASA audit, per-user isolation)
