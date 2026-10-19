# OK Computer

An always-on personal AI agent that lives on your own computer and texts you through the day. Say "OK Computer" and it gets to work: it asks for your daily goals and holds you to them, watches your email, calendar and messages for things you might forget, browses the web for you, and does bigger jobs (inbox and subscription cleanup) on request. Anything that sends, pays, deletes or unsubscribes waits for your tap.

It runs on your machine, so your data stays with you. Its persona files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and a local, gitignored `USER.md`) live in [workspace/](workspace/). The full system design is in [docs/DESIGN.md](docs/DESIGN.md).

## Decisions so far

- **Model-agnostic.** One model interface; any provider (Claude, GPT, local via Ollama/vLLM) is a config change.
- **Model routing by role, not by guessing.** Each job type has a fixed model slot (main chat, heartbeat, background/utility, batch triage, summarizer), with a fallback chain per slot.
- **Channels are adapters.** Telegram first; iMessage/SMS later without touching the core.
- **Raw history is never lost.** Every message, tool call and result goes into an append-only event log. What the model sees each turn is computed from that log by a swappable context strategy (tool-result clearing + structured compaction first; retrieval or recursive-LM strategies later), so a better strategy can be rerun over the full history.
- **Exact scheduling + heartbeat.** Automations fire at exact times; a heartbeat with a configurable interval (15m / 30m / 1h) and quiet hours handles "anything worth telling them?" checks.
- **Gmail and Calendar by polling every 15 minutes.** No push watcher.
- **Memory:** daily notes → nightly consolidation ("dreaming") into long-term memory and weekly trend summaries, so goal/productivity history can be tracked without rereading every note.
- **Skill Workshop:** each morning a review looks at the long or corrected tasks since the last review and can propose a new or changed skill (`SKILL.md` format). You get the full text in Telegram, and only Approve writes it to `skills/` (gitignored, because skills come from your tasks). Move or pause it like any automation ("move the skill review to 8am"). See [DESIGN-NEXT 10.1](docs/DESIGN-NEXT.md#101-decisions-from-phase-4-m3).
- **Safety in code, not prompts:** narrow tool set, approval buttons for anything that sends/deletes/pays/unsubscribes, email and web content marked untrusted.
- **Big observability UI:** every turn, tool call, model, token count, cost and error is logged and browsable in a web dashboard.
- **Language:** TypeScript on Node.js.

## Running it

Node 24 to 26 runs the app (`.nvmrc` names 24). The app runs on macOS, Windows and Linux.

### On Windows

`scripts/okc.ps1 install` adds an `okc` command, an "OK Computer" desktop shortcut, and a logon task that starts the agent in the background.

| Command | What it does |
|---|---|
| `okc` | Build if needed, start in the background, open the dashboard |
| `okc stop` / `okc restart` | Stop or restart the agent |
| `okc status` | Show whether it runs, the dashboard URL, and recent restarts |
| `okc logs` | Follow the agent log |
| `okc open` | Open the dashboard at http://127.0.0.1:4317 |

A small supervisor restarts the agent if it stops. The logon task means it runs whenever you are signed in to Windows.

### On macOS

`scripts/okc.sh install` adds an `okc` command in `~/.local/bin` and a LaunchAgent (`~/Library/LaunchAgents/com.okcomputer.agent.plist`) that starts the agent in the background when you sign in. Put `~/.local/bin` on your `PATH` if it is not there yet. The same script is the `okc` command on Linux.

| Command | What it does |
|---|---|
| `okc` | Build if needed, start in the background, open the dashboard |
| `okc stop` / `okc restart` | Stop or restart the agent |
| `okc status` | Show whether it runs, the dashboard URL, how often launchd started it with its last exit code, and the last errors from launchd |
| `okc logs` | Follow the agent log |
| `okc open` | Open the dashboard at http://127.0.0.1:4317 |
| `okc browser login [url]` | Open the agent's Chrome profile to sign in to sites |
| `okc install` / `okc uninstall` | Add or remove the `okc` command and the LaunchAgent |

launchd restarts the agent only after a crash, not after `okc stop`, and waits at least a minute between two starts. Its own output goes to `data/logs/launchd.*.log`, which `okc start` and `okc stop` cut to its last 1000 lines when it grows over 1 MB. `okc uninstall` removes the command and the LaunchAgent.

### On every system

`npm run chat` uses the same database as the background agent. That is fine, but do not chat with it while the agent is answering you in Telegram at the same moment: two processes in one conversation can give the same tool call two results. `npm run chat` never connects to MCP servers and runs no automations: only the background agent does, so each server runs once, an OAuth token is refreshed by one process, and reminders always come to Telegram. A second background agent on the same `data` folder (for example `npm start` while the service runs) stops at once with a message.

## What works now and how to turn each part on

A part that needs setup stays off until the setup is done, and the rest of the app works without it. Settings go in `okc.config.json`, secrets in `.env` or the system credential store (the Credential Manager on Windows, the login Keychain on macOS). On a server, the `secrets` block of `okc.config.json` keeps them in a file with mode 0600 or in AWS Secrets Manager instead. Run `okc restart` after a change. The background agent runs the build of its last start, so restart it once after an update.

| Part | State | How to turn it on |
|---|---|---|
| Chat, goals, heartbeat, memory, automations | Running | `.env`: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID` |
| Telegram v2: rich replies, streaming, reactions, approval cards, commands menu | Built | Nothing. Check it once: `node --env-file=.env scripts/smoke-telegram.mjs` sends a few test messages to you |
| Trace and dashboard (runs, what the model saw, Policy page) | Built | Nothing. `okc open` |
| Gmail (all accounts) and Calendar | Built, not yet checked against real Google | A `google` block and one sign-in for each account: [docs/setup/google.md](docs/setup/google.md). New mail and calendar changes become signals for the heartbeat; sending, unsubscribing and invitations always ask you |
| Slack, one integration for each workspace: search, read, send with approval | Built, not yet checked against real Slack. The DM poll stores new DMs, but nothing shows them yet | [docs/setup/slack.md](docs/setup/slack.md). Other MCP servers: [docs/setup/integrations.md](docs/setup/integrations.md) |
| Web search, `web_fetch` and the agent browser | On (needs Chrome) | Optional sign-ins: `okc browser login`, see [docs/setup/browser.md](docs/setup/browser.md). Each form submit asks you |
| Reviewer model, taint and sub-agents (`delegate`) | On | Nothing. `npm run smoke:reviewer` (about 30 calls of the `utility` slot) shows how well the reviewer holds injected actions |
| Skill Workshop | On | Nothing. A review at 09:00 can propose a skill; only Approve writes it to `skills/` |
| Dashboard on the phone and laptop | Optional | `DASHBOARD_TOKEN` and Tailscale Serve: [docs/setup/tailscale.md](docs/setup/tailscale.md) |
| Running on a server (Docker, Tailscale, Litestream backups, AWS Secrets Manager) | Built, not yet checked on a real host | Try the image locally with [docs/setup/docker.md](docs/setup/docker.md), then follow the runbook in [docs/setup/aws.md](docs/setup/aws.md). Google accounts move with `npm run google:push` |
| Subscription sweep | Owner test, not a separate feature | After Gmail works, ask the agent for it (see below) |
| Code sandbox (`sandbox_exec`): bash, Python and Node in a fresh Docker container for each call | Optional (needs Docker) | Docker Desktop or the Docker engine, then `npm run sandbox:image` and `okc restart`: [docs/setup/sandbox.md](docs/setup/sandbox.md). Without Docker the tool is off and the rest of the app runs. The reviewer checks each call, and you approve each call with network access |
| Claude history | On hold | Nothing to do |

A call that changes data (risk `write`, for example an archive) goes to the reviewer model on the `utility` slot, not to you. The reviewer holds a call that you did not ask for, a failed review comes to you, and you still approve everything that leaves this computer.

To test the subscription sweep, ask the agent in Telegram, for example: "Look through my newsletters in all accounts from the last month, group them by sender, and unsubscribe me from the ones that I leave unread." It should search with the Gmail tools (or a `delegate` to the `inbox` profile), show you the list, and send one approval card for each unsubscribe. If the test shows a gap, the gap becomes a normal fix.

## Phases

1. **Core coach (done):** Telegram adapter, agent loop, workspace files, scheduler (automations + heartbeat), 3-goals routine, daily notes + nightly consolidation into weekly trends, run logging, first version of the observability dashboard.
2. **Foundation and core accounts (built; manual checks against the real services pending):** full tracing v2, MCP client and integration registry, Gmail (all accounts) + Calendar, Telegram v2. See [docs/DESIGN-NEXT.md](docs/DESIGN-NEXT.md).
3. **More reach (built; manual checks against the real services pending):** Slack, web search + browser worker, reviewer model + taint + sub-agents.
4. **Power tools (built; manual checks against the real services pending):** Skill Workshop.

On hold: Claude history (a later design should cover ChatGPT logs too). The Docker sandbox, on hold in phase 4, comes with phase 5 (optional, see [docs/setup/sandbox.md](docs/setup/sandbox.md)). The subscription sweep is an owner test of the agent with Gmail, not a separate feature.

## TODO (later)

- [ ] iMessage channel (needs a Mac) and/or SMS
- [ ] Web dashboard features beyond observability (goals board, approvals inbox)
- [ ] Agent-built widgets/dashboards (on hold; Telegram can't display them)
- [ ] Mid-reply steering (new texts adjust a reply in progress)
- [ ] Event triggers (script detects a condition → wake the agent)
- [ ] Inbound webhooks
- [ ] Claude and ChatGPT history import (on hold)
- [ ] Voice replies / voice notes, PDF and image understanding
- [ ] Spending alerts
- [ ] Move more work to a local model as hardware allows
- [ ] iOS app / web app front end
- [ ] Product version (multi-user, Google CASA audit, per-user isolation)
