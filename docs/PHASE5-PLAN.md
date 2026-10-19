# Phase 5 plan: macOS, owner Google, dashboard v2, deploy, inbox jobs, sandbox

Status: approved 2026-10-18. When the phase is done, its decisions move into DESIGN-NEXT as "§12 Phase 5" and this file is deleted. That follows the "fix one so they match" rule in DESIGN.md.

## 0. Starting point (master @ 5596e3a, macOS arm64)

- `npm ci`, `npm run typecheck` and `npm run build` pass. `npm test` fails 6 of 1189 tests and skips 114.
- **Blocker:** `src/instance.ts` uses a Linux abstract socket (`\0okc-<hash>`) on every non-Windows platform. macOS rejects it with `listen EINVAL`, so the service cannot start. This causes 4 of the 6 test failures.
- The `skill_write` emoji regex (`src/skills/skill-write.ts`) fails on Node 26.0.0 (1 failure). The decompression-bomb RSS limit (40 MB) is too tight on macOS (1 failure).
- Process management (`okc.ps1`, `run.ps1`) works on Windows only.
- Chrome discovery (`src/browser/login.ts`, `test/browser-harness.ts`) checks Windows paths only. `profileBusy` uses the Windows `lockfile`. The MCP kill-tree runs on win32 only.
- Google OAuth (Desktop client, loopback + PKCE, refresh token in the OS keyring) works on macOS with no code change. The only remaining step is the owner's manual GCP setup.

## 1. Decisions

| # | Decision |
|---|---|
| D1 | Node 24 LTS is the supported runtime (`.nvmrc`, `engines ">=24 <27"`). The emoji regex is rewritten so it passes on Node 24 and 26. |
| D2 | Google: two owner accounts, personal Gmail and the university Workspace account. Scopes are read, drafts, archive and labels (`gmail.readonly`, `gmail.modify`, `calendar.readonly`, `calendar.events` for proposals only). `send: false`. The consent screen is published as unverified "In production", so tokens do not expire after 7 days. |
| D3 | macOS runs the service as a LaunchAgent in the GUI session (`RunAtLoad`, `KeepAlive.SuccessfulExit=false`). `scripts/okc.sh` gives the same commands as `okc.ps1`. |
| D4 | Web chat: a `web` ChannelAdapter. The dashboard sends to and streams from the same `main` session as Telegram. `web` is never the proactive target. |
| D5 | Chats: `main` is split at `session_reset`. Background sessions (`auto:`, `heartbeat:`, `sub:`, `consolidate:`, `workshop:`, `poll:`) show under Activity, grouped by kind. |
| D6 | Search: SQLite FTS5 with the trigram tokenizer over `events`, fed by an AFTER INSERT trigger. Under 3 characters it falls back to LIKE. |
| D7 | Developer mode shows the browser worker (live latest step, filmstrip, trace) and, after M9, the code sandbox runs. |
| D8 | Developer mode is a global toggle (⌘. and the status bar), saved in localStorage. |
| D9 | Web tests may be rewritten as the UI changes. The acceptance bar stays "every page loads against the seeded test database". |
| D10 | No UI kit, router or data library. Fonts are self-hosted OFL faces from `@fontsource` (serif display + grotesk body). Icons are a small inline SVG set. |
| D11 | Set `DASHBOARD_TOKEN` on every host, because the search endpoints return chat text. |
| D12 | Platforms: develop on macOS and Windows, deploy on Linux. A CI matrix (ubuntu, macos, windows) runs typecheck and test. |
| D13 | Hosting: one EC2 instance (t4g.medium, arm64) with one Docker container, SQLite on gp3 EBS, and Litestream backup to S3. No public ports. The dashboard is reached over Tailscale, and Telegram uses outbound polling. |
| D14 | Secrets: the OS keyring on desktops. On the server, a `SecretStore` backend for AWS Secrets Manager (or a 0600 file), chosen by config. |
| D15 | **One Telegram bot.** Only the live instance has `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`. Any other copy (local dev while the server is live, a second machine) runs without them and uses web chat and the CLI. The runbook says how to move the live role between hosts. |
| D16 | Model-agnostic stays a hard rule. Core abilities do not use provider-hosted tools (server-side code execution, hosted agent loops). An optional Bedrock provider may come later. |
| D17 | The agent's own mailbox and calendar are deferred to Phase 6. |
| D18 | The public product name and domain appear only in gitignored local config. Code, docs, commits and tests say "ok computer". |
| D19 | New SQL migrations are numbered in advance: M1 `018_search.sql`, M8 `019_inbox.sql`, M9 `020_sandbox.sql`. |

## 2. Design by milestone

### M0: macOS bring-up
- `src/instance.ts`: on darwin, a filesystem unix socket at `os.tmpdir()/okc-<hash>.sock`, kept under the 104-byte `sun_path` limit. On `EADDRINUSE`, a `connect()` probe; `ECONNREFUSED` means stale, so unlink and listen again. Keep the pipe on win32 and the abstract socket on linux. Tests cover a stale socket.
- Rewrite the emoji regex as an alternation. Raise the RSS limit by platform, or measure the bytes cut instead.
- Chrome paths for darwin and linux in `login.ts` and `browser-harness.ts`. On POSIX, `profileBusy` reads the `SingletonLock` symlink and checks the pid with `kill(pid, 0)`. `openssl` is found on PATH.
- MCP stdio on POSIX: spawn detached and kill the process group.
- `scripts/okc.sh`: install, uninstall, start, stop, restart, status, logs, open, `browser login`. It keeps the stale-build check against `dist/.build-ok`, the graceful stop through `POST /api/shutdown` with the stop token, and the "running agent is older than the code" warning. Plist `~/Library/LaunchAgents/com.okcomputer.agent.plist` with an absolute node path, `WorkingDirectory`, a `PATH` that includes the Homebrew bin, and logs under `data/logs/`.
- Platform-neutral wording for the credential store in the UI and docs. macOS in DESIGN §3 and §18, and in the setup docs (`security` instead of `cmdkey`).

### M1: dashboard backend
All routes go inside `createDashboard` after auth. Shapes go in the import-free `src/dashboard/types.ts`.
- `018_search.sql`: `events_fts` (fts5 trigram; text plus sessionKey, runId, type, eventId, createdAt as UNINDEXED), an insert trigger, a backfill, `CREATE INDEX events_run ON events(runId)` and `runs_started ON runs(startedAt)`.
- `GET /api/chats?kind&q&cursor&limit` → `ChatRow {key, kind, title, channel, preview, firstAt, lastAt, runs, costUsd, lastRunStatus, pendingApprovals}`. Each `main` segment is keyed `main@<resetEventId>`.
- `GET /api/chats/:key/messages?before&limit`: a paged transcript of the delivered text, with guard notes marked.
- `GET /api/search?q&scope&limit`: messages, runs, tool calls, automations, memory (exposes `searchMemory`) and approvals. FTS input is escaped.
- `GET /api/runs/:id/spans`: waterfall spans (run, model, tool, review, approval, subagent, mcp, google, browser) with start and end times computed on the server.
- `/api/runs` gains `sessionKey` and `before`. `/api/logs` gains `day` and `runId`.
- SSE kinds `model_call`, `tool_call`, `browser_step`, `approval`, `policy` carry ids and summaries only.
- `GET /api/browser/live` returns open tasks with their latest step.

### M2: web channel
- `src/channels/web.ts` implements `ChannelAdapter` with an in-process emitter. `progress()` emits text, activity and done. `send()` emits the reply and its buttons.
- `POST /api/chat {text}`, `POST /api/chat/button {data}`, and stop through the progress stop callback.
- `GET /api/chat/stream` is a separate SSE that carries live tokens. Runs that Telegram started also stream to open web clients.
- `isOwner` trusts `web`. `OwnerMessenger` treats `web` like `cli`.

### M3: dashboard shell and design system
- Layout: an icon rail, a left nav with groups and a search field for chats, a ⌘K command menu, a header with breadcrumb and actions, a tabs/filter/sort/display bar, the main area, a right details panel, and a status bar (live state, running runs, pending approvals, cost today, DEV badge).
- Nav groups, each shown only when its view exists: Today, Desk, Inbox, Calendar, Docs, People, Chats, Activity, Agent (Goals, Memory, Automations, Signals), Connections (Google, Integrations, Browser), Dev (Runs, Policy, Cost, Logs, Sandbox).
- Look: a warm off-white base `#fbfaf9`, near-black ink, hairline rules, a serif display face for titles, a grotesk for UI text, black pill primary buttons, generous whitespace, and a matching warm dark theme with a toggle.
- Hash routes stay. A list and its selected item share the screen.
- Responsive: below 1100px the details panel becomes a drawer. Below 760px the rail and nav collapse into a sheet. It must work at 390px.
- Kept as they are: `api.ts`, `format.ts`, the `events.tsx` renderers, the status word+dot semantics, and the SVG charts.
- All 15 current pages are restyled into the shell.

### M4: chats UI (after M1, M2, M3)
The nav list, a transcript with a composer (send, stop, queued/running state), streaming text, inline approval cards, tool chips that expand in dev mode, and per-turn trace links. ⌘K full-text search with grouped results.

### M5: developer mode (after M1, M3; M9 for the sandbox tab)
- **Waterfall:** cost and tokens per span, click a span to inspect it.
- **Model-call inspector:** the full input and output, byte for byte.
- **Tool calls:** policy decision, reviewer verdict, taint and raw result.
- **MCP and Google request inspectors.**
- **Sub-agent nesting.**
- **Sandbox:** live browser tasks, the step filmstrip, the trace zip, and code sandbox runs.

### M6: docs sync and end-to-end check
Move decisions into DESIGN-NEXT §12 and update the README table. Run end to end on macOS.

### M7: deploy
A multi-arch Dockerfile (Node 24 + Chrome + Docker CLI access for M9 through a socket proxy, or a sibling sandbox runner), a compose file, the `SecretStore` server backend, Google tokens moved to a remote host (sign in on a desktop, then send the refresh token to the server through an authenticated dashboard endpoint), Litestream to S3, a Tailscale sidecar, a GitHub Actions CI matrix plus an image build, and `docs/setup/aws.md` with the runbook (including how to move the live Telegram role).

The Docker access for M9 moved to M9. The socket proxy can create containers, so it must allow only the endpoints that the sandbox uses, and those come with the sandbox. Until M9 adds the proxy service to `deploy/compose.yaml`, the sandbox tool is off on the server.

### M8: inbox jobs (Gmail, owner accounts)
- **Newsletter sweep:** group senders by List-Id or From, show read rates, unsubscribe through RFC 8058 one-click (`List-Unsubscribe-Post`) or the https link after approval, and archive or label the old mail.
- **Paid subscription finder:** find receipts and recurring charges, then build a table (merchant, amount, cadence, last charge, source mail). Cancellation help with the cancel link, or a browser task, each step approved.
- **Daily inbox digest:** needs a reply, deadlines, bills, and packages. It is an automation whose output is a dashboard page plus a short Telegram message.
- **Draft replies** go into Gmail Drafts and are never sent.
- **Deadline proposals:** course and bill deadlines become calendar event proposals that the owner approves.
- `019_inbox.sql` holds the sender, subscription and digest tables. Each job is a tool or skill under the existing policy and approval rules.

### M9: code sandbox (Docker)
- A `sandbox_exec` tool runs code in a fresh container with no network by default, CPU, memory and time limits, a read-only image, a per-task scratch volume, and a size limit on output.
- An optional network allowlist goes through the existing egress proxy.
- Files move in and out through the blob store.
- `020_sandbox.sql` holds `sandbox_execs` (command, image, limits, exit code, stdout/stderr blobs, files, duration) linked to `tool_calls`.
- Policy: risk `exec`, reviewer, and approval for network access.
- The tool works with every model provider. Docker comes from Docker Desktop on macOS and Windows and the engine on Linux. When Docker is missing, the tool is off and the rest of the app runs.

## 3. Owner setup (manual)
1. `.env` in the repo root: `ANTHROPIC_API_KEY` (a Console API key), `DASHBOARD_TOKEN`. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` only on the instance that is live. Stop the Windows service first (`okc stop`, and `okc uninstall` to remove its logon task).
2. Google Cloud: create a project, enable the Gmail and Calendar APIs, set up branding (External), publish the app, create a Desktop client, and download its JSON.
3. `okc.config.json`: `google.clientId`, `accounts` (personal and university aliases), `send: false`.
4. Dashboard → Google: upload the JSON, then Connect for each account. Choose "Always Allow" for the Keychain prompt.

## 4. Order of work
1. M0 on `master`.
2. M1, M2, M3, M7, M8 and M9 in parallel, each on its own branch (`phase5_m<n>_<word>`). Each branch passes `npm run typecheck && npm test`, gets a review, and is merged one at a time with a full test run after each merge.
3. M4 and M5 in parallel on the merged base.
4. M6.

Commits use the lower-case conventional style, with STE100 comments in code. The trace stays complete, events stay append-only, and a dependency is added only when it removes real work.

## 5. Out of scope
iMessage, the multi-user product version, voice, Claude/ChatGPT history import, and the agent's own mailbox (Phase 6).
