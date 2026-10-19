# Phase 5 API contracts

Status: the shared contract for the parallel work of phase 5 (see `docs/PHASE5-PLAN.md`). The types are in `src/dashboard/types.ts`, one section for each milestone. The web route registry is `web/src/routes.ts`. When a team must change a shape, it changes the type, this file and its own code in the same commit, and it tells the teams that read the shape. When phase 5 is done, this file moves into DESIGN-NEXT with the plan.

## 1. Rules for every endpoint

- **Auth.** Every route is under `/api/` and goes through the existing middleware in `createDashboard`: the host check, then the token (`Authorization: Bearer`, or `?token=` for `EventSource`) or the session cookie when `DASHBOARD_TOKEN` is set. No new route skips it. D11 says to set `DASHBOARD_TOKEN` on every host.
- **Writes.** Every `POST`/`PUT` sends a JSON body with `content-type: application/json`, also when the body is `{}`. Otherwise the answer is `415 {error}`. Each body is checked with a strict zod schema.
- **Errors.** The body of an error is `{ "error": string }`, one sentence that the page can show.
  - `400` a query or body that is not valid. The text says what to give.
  - `401` not signed in.
  - `404` `"<what> not found"`, for example `"chat not found"`.
  - `409` the row is in a state where the action does not apply, for example an unsubscribe of a sender that is already unsubscribed.
  - `415` not JSON.
  - `422` an outside service refused the input (only the Google token import).
  - `500` a damaged blob or row. `503` a part that is not running: the web channel, Docker or the secret store.
- **Times** are ISO strings in UTC. A `day` is `yyyy-mm-dd` in the time zone of the app. Costs are in US dollars.
- **Limits.** `limit` is clamped to the range given for the endpoint. A value that is not a number gives the default.
- **Paging.** There are two kinds, and each endpoint says which one it uses.
  - **Cursor**: the answer has `nextCursor: string | null`. The page sends it back as `cursor`. The cursor is opaque, and `null` means the last page.
  - **Before**: the page sends the id of the last row it has as `before`. The answer holds the older rows. For `/api/runs` and the inbox lists, a page with fewer rows than `limit` is the last one. Chat messages and sandbox execs return `before: number | null`, where `null` means the last page.
- Lists are newest first, except chat messages, which are oldest first in each page.

## 2. Endpoints

### M1: chats, search, spans (`src/dashboard/chats.ts`, `search.ts`, `spans.ts`, plus edits in `server.ts`, `browser.ts`, `stream.ts`, `queries.ts`)

| Method | Path | Query / body | Response | Notes |
|---|---|---|---|---|
| GET | `/api/chats` | `ChatsQuery`: `kind` (`ChatKind` or `activity`), `q`, `cursor`, `limit` 1–200 (default 50) | `ChatsPage` | Cursor paging, sorted by `lastAt`. `main` is split at each `session_reset`, and each segment's key is `main@<resetEventId>` (`main@0` before the first reset). The sort and the cursor are in SQL, and the numbers of a chat are read only for the chats of the page. With `q`, one page reads at most 500 background chats, so a page can hold fewer chats than `limit` and still have a `nextCursor`. `400` for an unknown kind or a cursor that cannot be read. |
| GET | `/api/chats/:key/messages` | `ChatMessagesQuery`: `before` (event id), `limit` 1–200 (default 50) | `ChatMessagesPage` | Before paging. The messages are delivered text only: owner messages, guarded agent replies, notes (guard notes have `guarded: true`) and the system events that the chat shows. An agent message is the final reply of its run (its last `assistant_message` with no tool calls), or a turn whose call made an approval. The text of other tool turns was a draft, and the chat never got it. `400` for a `before` that is not an event id. `404 chat not found`. The key is URL-encoded (it holds `:` and `@`). |
| GET | `/api/search` | `SearchQuery`: `q` 1–200 characters (required), `scope` (`SearchScope`), `limit` 1–50 (default 8, or 30 with a scope) | `SearchResults` | One group per scope, in the order of `SearchScope`. With 3 or more characters `mode` is `fts` (trigram, input escaped). With fewer, it is `like`. `memory` uses `searchMemory`, one hit for each file. Each NUL character of `q` is dropped first, before the checks and the mode. A message hit shows the text that its chat got, with the rules of `/api/chats/:key/messages`: a `NO_REPLY` answer, a draft of a tool turn and a reply that the guard held give no hit, and a match only in a removed link gives no hit. `400` for no `q` (also a `q` of only NUL characters and spaces) or an unknown scope. |
| GET | `/api/runs/:id/spans` | none | `RunSpans` | Start and end are computed on the server. Child runs are nested under their sub-agent span. `404 run not found`. |
| GET | `/api/runs` | `RunsQuery`: the existing filters plus `sessionKey` and `before` (run id) | `RunRow[]` | Before paging. An unknown `before` id gives `400`. A `day` that is not a date of the calendar gives `400`. |
| GET | `/api/logs` | `LogsQuery`: the existing `level`, `limit`, plus `day` and `runId` | `LogLine[]` | `day` reads that day's file. `runId` keeps the lines with that run id. `limit` 1–5000 (default 500). A `day` that is not a date of the calendar, for example `2026-13-45`, gives `400`. |
| GET | `/api/browser/live` | none | `BrowserLive` | Open tasks, each with its latest step. Lives in `browser.ts`. |

### M2: web chat (`src/channels/web.ts`, `src/dashboard/chat.ts`)

| Method | Path | Query / body | Response | Notes |
|---|---|---|---|---|
| POST | `/api/chat` | `ChatSendRequest` `{ text }`, 1–16,000 characters | `ChatSendResponse` `{ turnId, state }` | Goes into the `main` session as channel `web`. `state` is `queued` when the session is busy. A command such as `/status` or `/stop` is `running`, gets its answer at once and then ends as `done`. `400` for a text of only spaces. `503` when the web channel is not running. |
| POST | `/api/chat/button` | `ChatButtonRequest` `{ data, turnId? }`, `data` at most 256 characters, `turnId` at most 200 | `ChatButtonResponse` | The same path as a pressed Telegram button. The data never goes to the model. `data` is the data of a button of a `reply` event, as it came: it carries a mark that the server checks, as Telegram does, so a button that the model wrote into a reply does nothing. `400` for empty data, and `400 that button is not from one of my cards` for data without a valid mark (the marks are new after a restart; `/approve <n>` sends a fresh card). |
| POST | `/api/chat/stop` | `ChatStopRequest` `{ turnId }`, at most 200 characters | `ChatStopResponse` `{ stopped }` | Calls the progress stop callback of the turn. `stopped: false` for a turn that has ended, is not known, or still waits in the queue (it runs later; a stop after it started works). |
| GET | `/api/chat/stream` | `token` when needed | SSE of `ChatStreamEvent` | See section 3. |

`turnId` is the `messageId` of the inbound message: `web:<uuid>` for the web, and `telegram:<message id>` for a turn that Telegram started. Those turns stream to open web clients too.

The bodies are strict: an unknown key gives `400`. The web chat starts only when `DASHBOARD_TOKEN` is set, because it runs the main session as the owner; without the token every route answers `503`. Each proactive message to the owner (an approval card, an alert, `message_owner`) still goes to Telegram (or the cli), and a copy goes to the stream as a `reply` with `turnId: null`. A button press is not a turn, so its reply also has `turnId: null`.

`reply.text`, `text` deltas and `details` are model text, and a tainted model can be told what to write. The page renders markdown with no raw HTML, loads no image without a click, and makes only `http(s)` links clickable. It never makes a button out of reply text: only `reply.buttons` are buttons.

### M7: deploy (`src/dashboard/deploy.ts`, `src/integrations/secrets.ts` backends)

| Method | Path | Query / body | Response | Notes |
|---|---|---|---|---|
| POST | `/api/google/accounts/:alias/token` | `GoogleTokenImportRequest` `{ refreshToken, clientId }` | `GoogleTokenImportResponse` | The server refreshes the token one time, then stores it in the `SecretStore` under the alias's ref. The token never appears in a log or an answer. `400` for a bad body. `404` for an alias that is not in the config. `409` when `clientId` is not the configured client. `409` also when the server has no client secret yet. `422` when Google refuses the token. `422` also when the token lacks a required scope or is for another email; the token is then revoked. `503` when the secret store fails or Google does not answer. |
| GET | `/api/secrets` | none | `SecretStoreView` | The backend and whether it answers. It never shows a value or a ref. |

The backend is chosen by `SecretStoreConfig` (`keyring`, `file` with mode 0600, or `aws` with one secret per ref named `prefix + ref`, where the default prefix is `okc/`). A secret name of AWS cannot hold every character of a ref, so each character outside `A-Z a-z 0-9 / _ + = . -` is written as `@` and two hex digits for each of its UTF-8 bytes, and `@` itself too: the ref `linear:oauth-tokens` is the secret `okc/linear@3aoauth-tokens`. No secret name may start with `okc-host/`, which holds the env of the host, and the config refuses that prefix. The config refuses a `file` path inside `paths.workspace` or `paths.skills`. On a native Windows desktop the `file` backend makes no mode check. It sets an access list for the current user only with `icacls /inheritance:r /grant:r`, on each new file before a value is in it and on an old file at its first read, and it fails when that does not work. The Docker access for the M9 sandbox (a socket proxy service) moves to M9: the M7 image has no Docker access, so the sandbox tool is off on the server until M9 adds it. It goes in `okc.config.json` as `secrets`, and the default is `{ "backend": "keyring" }`. The desktop sends the token with a CLI command that M7 adds, so the web app needs no page for it.

### M8: inbox jobs (`src/dashboard/inbox.ts`, `src/inbox/`)

| Method | Path | Query / body | Response | Notes |
|---|---|---|---|---|
| GET | `/api/inbox/senders` | `SendersQuery`: `account`, `state`, `sort`, `cursor`, `limit` 1–200 (default 50) | `SendersPage` | Cursor paging. |
| POST | `/api/inbox/senders/:id/unsubscribe` | `{}` | `InboxActionResponse` | Asks for approval. One-click (RFC 8058), or the https link. `409` when already unsubscribed or pending, or when the method is `none`. |
| POST | `/api/inbox/senders/:id/archive` | `InboxArchiveRequest` | `InboxActionResponse` | Asks for approval. |
| POST | `/api/inbox/senders/:id/keep` | `{}` | `InboxActionResponse` (`done`) | Takes the sender out of later sweeps. |
| GET | `/api/inbox/subscriptions` | `account`, `state` (`SubscriptionState`) | `SubscriptionsPage` | No paging, because the table is small. |
| POST | `/api/inbox/subscriptions/:id/cancel` | `{}` | `InboxActionResponse` | Asks for approval, then opens the cancel link or a browser task. Each step is approved. `409` unless the state is `active`. |
| POST | `/api/inbox/subscriptions/:id/ignore` | `{}` | `InboxActionResponse` (`done`) | |
| GET | `/api/inbox/digests` | `cursor`, `limit` 1–100 (default 30) | `DigestsPage` | Cursor paging. |
| GET | `/api/inbox/digests/latest` | none | `InboxDigest` | `404 digest not found` when none exists yet. |
| GET | `/api/inbox/digests/:id` | none | `InboxDigest` | `404`. |
| GET | `/api/inbox/drafts` | `InboxListQuery` (`state` is a `DraftState`) | `DraftView[]` | Before paging by id. Drafts are never sent. |
| GET | `/api/inbox/proposals` | `InboxListQuery` (`state` is a `ProposalState`) | `CalendarProposalView[]` | Before paging by id. The owner decides through the existing `POST /api/approvals/:id`, so there is no decision route here. |
| POST | `/api/inbox/run` | `InboxRunRequest` `{ job }` | `202 { started: true }` | Runs the automation of the job now, like `POST /api/automations/:id/run`. `404` when the job's automation is missing, `409` while a run of the job is still going. |

An approval that an inbox action asks for shows on the Approvals page, in the stream (`approval`), and in Telegram, the same way as any approval.

- Each job runs in code in the session `inbox:<job>:<runId>`, and each dashboard action in `inbox:action:<runId>`. The first event of each run is a `system_event` with the task of the run, so the reviewer reads what the run may do. One run of a job goes at a time: a second start is skipped.
- The tools of the inbox code are in the registry, but no session lists them, so only the inbox code calls them through the tool caller. Nothing in them sends mail, and a `mailto` unsubscribe is only shown, never used.

  | Tool | Risk | Who decides |
  |---|---|---|
  | `inbox_unsubscribe` | external | the owner approves each call |
  | `inbox_archive_sender` | write | the owner approves each call |
  | `inbox_cancel_subscription` | external | the owner approves each call |
  | `inbox_create_event` | write | the owner approves each call |
  | `inbox_draft_reply` | write | the reviewer checks each call of the tainted digest session. It needs no owner approval, because a draft never leaves the account, as for `gmail_draft` |

- An approved https unsubscribe and an approved cancellation start a browser help run in `auto:inbox:<runId>` on the `main` slot, because it drives the browser and web tools over many turns. The facts from mail (the list, the merchant, the link) go in an untrusted block. The row stays `unsubscribe_pending` or `cancel_pending` while the run works, and each form send asks the owner. The row is `unsubscribed` or `cancelled` when the run completes, and `active` again (with `error`) when it fails or the owner denies its steps. An approved call that refuses, for example because a later sweep or scan changed the row, also gives the row back to `active`.
- Every unsubscribe, one-click or https, needs a DKIM signature of the From domain that covers `List-Unsubscribe`. The sweep takes the link of a sender from its newest signed message.
- Without a `google` block in the config, the lists answer from the tables (empty), and the `POST` routes give `503`, also `POST /api/inbox/run`.
- `SubscriptionRow` also has `sourceMessageIds` (every receipt, newest first) and `confidence` (0 to 1), which the subscription finder needs to show why a row is there.
- For M6 to move into DESIGN-NEXT §12: the automation payload is `{ type: 'inbox', job }`. The app installs three system automations one time: `inbox: daily digest` at 07:30 every day, `inbox: newsletter sweep` at 09:00 on Saturday and `inbox: subscription finder` at 10:00 on Sunday, in the time zone of the app. The owner changes the time or turns a job off on the Automations page, and the app never puts a deleted one back. The tables are in `019_inbox.sql`. A job that could read no account fails, so the scheduler backs off.

### M9: code sandbox (`src/dashboard/sandbox.ts`, `src/sandbox/`)

| Method | Path | Query / body | Response | Notes |
|---|---|---|---|---|
| GET | `/api/sandbox` | `SandboxQuery`: `runId`, `status`, `before` (exec id), `limit` 1–200 (default 50) | `SandboxPage` | Before paging. `status.available` is false when Docker is missing. That is not an error. |
| GET | `/api/sandbox/execs/:id` | none | `SandboxExecDetail` | `404 sandbox exec not found`. The full stdout and stderr load through the existing `GET /api/blobs/:hash`. |
| GET | `/api/sandbox/files/:hash` | none | the bytes of the file | Only a blob that a `sandbox_files` row names, with the `mime` of that row, `x-content-type-options: nosniff` and a sandboxing CSP. A type other than png, jpeg, gif or webp gets `content-disposition: attachment`. `404 sandbox file not found`. |

The tool is `sandbox_exec` (input in `src/sandbox/input.ts`) with risk `exec`, which `decide()` sends to the reviewer (rule `risk:exec`). A call with `network.allow` is `external` through `riskFor`, so the owner approves it. `SandboxExecRow.language`, `SandboxExecDetail.policy` (the decision, the reviewer verdict and the approval of the tool call), `imageId`, `containerId`, `endedAt`, `egress` (`SandboxEgress`: the hosts that the proxy let through and the requests that it refused, or null without network), `notCollected`, and `SandboxStatus.network` with `networkReason` were added by M9. `command` holds the redacted code.

The waterfall (M1) gives a `sandbox` span with `ref.sandboxExecId` for each exec of a run.

The default image is `okc-sandbox:1` (`SANDBOX_IMAGE` in `src/sandbox/limits.ts`), built from `sandbox/Dockerfile` by `npm run sandbox:image`. It runs as `1000:1000` with the home `/work`, the create request resets the entrypoint of its base (`Entrypoint: [""]`), and it holds the relay of the network mode at `/opt/okc/relay.mjs`. A change of what the image holds changes the tag in `limits.ts` and in the `sandbox:image` script together. The decisions are in DESIGN-NEXT 5.8.

## 3. Event streams

Both streams are SSE. With `DASHBOARD_TOKEN` set, they take `?token=` because `EventSource` sends no headers. The cookie also works. A stream sends `event: ready` with `{}` first. Then each message is an unnamed event whose data is one JSON value.

| Stream | Data type | Kinds |
|---|---|---|
| `GET /api/stream` (existing, M1 adds kinds) | `StreamMessage` | `event`, `run`, `log` (existing). M1 adds `model_call` (`StreamModelCall`), `tool_call` (`StreamToolCall`), `browser_step` (`StreamBrowserStep`), `approval` (`StreamApproval`, sent when it is asked for and when it is resolved), and `policy` (`StreamPolicy`, sent when it is written, and for a `review` or `approve` decision again when its `reviewerVerdict` or `approvalId` changes, until its run ends). The feed polls the database, so these kinds carry ids and summaries only. A page ignores a kind that it does not know. |
| `GET /api/chat/stream` (M2) | `ChatStreamEvent` | `snapshot` (first, the turns that have not ended), `owner` (an owner message from any channel), `state` (`queued`, `running`, `done`, `failed`, `stopped`), `run` (the run id of a turn, for the trace link), `text` (`delta`, and `reset: true` drops the streamed text first), `activity` (tool names or `null`), `reply` (the guarded final text with `buttons`, `markdown` and `details`, which replaces the streamed text; `turnId: null` for a proactive message or the answer to a button press), `done` (`ok`), and `error` (the text that the owner got about a failed turn, right before its `failed` state). The server also sends `event: ping` every 25 seconds, and the page ignores it. |

A browser allows six connections to one host, so the web app opens each stream one time (`subscribe` in `web/src/api.ts` for the main stream, and a matching shared subscriber for the chat stream that M4 adds to `web/src/chat-stream.ts`).

## 4. Web routes and the left nav

The routes stay in the hash (`#/<path>`). `web/src/routes.ts` holds the registry:

- `RouteDef { path, group, label, icon, load, devOnly?, order?, pageKey? }`. `path` uses `:name` for one segment and a last `:name*` for the rest of the path. A param never matches an empty value, one trailing slash of the hash is dropped, a bad percent escape gives no match (the missing page), and the query starts at the first `?`. `pageKey(params)` gives the key of the page: two hashes with the same key show one page that stays mounted and keeps its scroll. The default key is the path with every param, so each new param gives a new page. The trace routes key the page by run, so a click on a span changes the page in place. `group` is a `NavGroup`, or `null` for a detail page that the nav does not list. `icon` is an `IconName`. `load` gives the component, which gets `RouteProps { params, query }`. A `devOnly` route shows in the nav and the command menu only in developer mode, but its hash opens it in each mode.
- `CORE_ROUTES` are the paths of the pages from before phase 5, which live in `web/src/pages/`. A view route with the same path replaces a core route, so the M3 restyle drops in. Two views with one path are an error.
- `matchRoute(hash)` prefers fixed segments over params. `navSections(devMode)` gives the nav groups in order and leaves out the empty ones.
- Each view folder `web/src/views/<area>/` exports its list as the default export of `web/src/views/<area>/routes.ts` (use `defineRoutes`). `import.meta.glob` finds it, so no shared file changes when a view is added. The shell in `App.tsx` renders the route that `matchRoute` gives, keyed by `pageKeyOf(match)`.
- A view folder can also add parts to the shell with the default export of `web/src/views/<area>/shell.ts` or `shell.tsx` (use `defineShellExtension` from `web/src/shell/extensions.ts`): a panel under a nav group (`navPanels`, for example the chat list under Chats), fixed actions of the ⌘K menu (`commands`), and sources of ⌘K results (`commandSources`, for example the full-text search). The shell finds it like `routes.ts`.
- The shared parts of the views are in `web/src/ui/` (`Page`, `Section`, `Stats`, `Facts`, `Table`, `FilterBar`, `Select`, `Tabs`, `DetailsPanel`, `Drawer`, `Button`, `Pill`, `Badge`, `EmptyState`, `KeyHint`, `Skeleton`, `CodeBlock`, `Highlight`). A view reads developer mode with `useDevMode()` from `web/src/shell/prefs.ts`. The web tests share `web/src/testing.tsx` (`stubFetch` for the endpoints that are not built yet, `FakeEventSource`, `openApp`, `inMain`).

| Nav group | Item → route | Owner |
|---|---|---|
| Today | Overview → `#/` | core, M3 restyles |
| Desk, Calendar, Docs, People | none in phase 5. The groups stay hidden until a view registers. | |
| Inbox | Digest → `#/inbox`, Newsletters → `#/inbox/newsletters`, Subscriptions → `#/inbox/subscriptions`, Drafts → `#/inbox/drafts`, Proposals → `#/inbox/proposals`. Detail: `#/inbox/digests/:id` | M8 |
| Chats | Chats → `#/chats`. Detail: `#/chats/:key` (the `main@<id>` key, URL-encoded) | M4 |
| Activity | Activity → `#/activity` (`?kind=` filters). Detail: `#/activity/:key` | M4 |
| Agent | Goals `#/goals`, Memory `#/memory`, Automations `#/automations`, Signals `#/signals`, Approvals `#/approvals` | core |
| Connections | Google `#/google`, Integrations `#/integrations` (detail `#/integrations/:id*`), Browser `#/browser` (detail `#/browser/:id*`) | core |
| Dev | Runs `#/runs` (detail `#/runs/:id*`), Sessions `#/sessions` (detail `#/sessions/:sessionKey*`), Policy `#/policy`, Cost `#/cost`, Logs `#/logs`, Sandbox `#/sandbox` (devOnly) | core, M5 for Sandbox |
| none | Search → `#/search?q=` (the full page behind ⌘K) | M4 |
| none (devOnly) | Trace → `#/trace/:runId`, a span → `#/trace/:runId/:spanId`, a browser task live → `#/sandbox/browser/:taskId`, a code exec → `#/sandbox/code/:execId` | M5 |

Search hits give `href` as a path without `#/`, so a hit opens with `location.hash = '#/' + hit.href`. The run page links to `#/trace/<runId>` in developer mode.

## 5. File ownership

Each team edits only its own files. A shared file gets only the change written here for it.

| Milestone | Owns (new files) | Shared files it may touch |
|---|---|---|
| M1 | `src/db/migrations/018_search.sql`, `src/dashboard/chats.ts`, `search.ts`, `spans.ts`, `chat-keys.ts` (the chat key rules that chats, search and stream share), `params.ts` (the limit and id rules of section 1), `src/search/`, `test/seed-m1.ts` | `types.ts` (its section and the `StreamMessage` union), `stream.ts`, `queries.ts` (`listRuns` paging), the `/api/runs` and `/api/logs` handlers in `server.ts`, `browser.ts` (`/api/browser/live`) |
| M2 | `src/channels/web.ts`, `src/dashboard/chat.ts` | `types.ts` (its section), the `isOwner` and `OwnerMessenger` lines, the wiring of the channel in `src/app.ts`, one key in the `app` pick of `DashboardDeps` |
| M3 | `web/src/shell/`, `web/src/ui/`, `web/src/icons.tsx`, `web/src/fonts.ts`, `web/src/testing.tsx`, the pages in `web/src/pages/` (restyled in place) | `App.tsx`, `styles.css`, `main.tsx`, `web/src/routes.ts`, the `@fontsource` entries in the root `package.json`, the web tests |
| M4 | `web/src/views/chats/`, `web/src/views/activity/`, `web/src/views/search/`, `web/src/chat-stream.ts` | none |
| M5 | `web/src/views/trace/`, `web/src/views/sandbox/` | none |
| M7 | `Dockerfile`, `compose.yaml`, `litestream.yml`, `.github/workflows/`, `docs/setup/aws.md`, `src/dashboard/deploy.ts`, `src/secrets/` (the file and aws backends) | `types.ts` (its section), `src/config/schema.ts` (`secrets`), the store choice in `src/app.ts` |
| M8 | `src/db/migrations/019_inbox.sql`, `src/inbox/`, `src/dashboard/inbox.ts`, `web/src/views/inbox/` | `types.ts` (its section), the tool registration in `src/app.ts`, `src/google/` for new Gmail and Calendar calls |
| M9 | `src/db/migrations/020_sandbox.sql`, `src/sandbox/`, `src/dashboard/sandbox.ts`, `sandbox/` (the image), `docs/setup/sandbox.md` | `types.ts` (its section), the tool registration in `src/app.ts` and its policy rule, `src/browser/proxy.ts` (the `EgressProxyOptions` with `allowHost` and the listen address; the browser team reviews it), `src/main.ts` (`sandbox: {}`), the `sandbox:image` script of `package.json`, `RISK_TEXT.exec` in `src/integrations/discovery.ts`, and `README.md` |

- **Route modules.** Each new module `src/dashboard/<area>.ts` exports `mount<Area>(server, deps)`. The stub exists already, and `server.ts` already mounts it with one line after the sign-in check and before the `/api/*` 404. A team fills its stub and does not edit those lines. A team that needs a new part of `App` adds one key to the `app` pick in `DashboardDeps`.
- **Types.** Each team adds fields only in its own section of `types.ts`. A new shape that another team reads goes there too, and nothing in that file imports anything.
- **Migrations** use the numbers in D19. `004_trace.sql` made `sandbox_execs` and `006_trace_contract.sql` dropped it, so `020_sandbox.sql` makes it again with the columns of `SandboxExecDetail`, and adds `sandbox_files` (the files in and out of each exec) and `sandbox_scratch` (the scratch volume of each task). The spans of M1 read the table only when it has the columns that they use (`hasSandbox` in `spans.ts`): a row is written with status `running` before the container starts, so `createdAt` is the start and `endedAt` is the end.
- **Web views.** Each view lives in its own folder and registers in its own `routes.ts`. It never edits `App.tsx` or another view. A shared component that M4, M5 and M8 need goes to M3, which adds it to `web/src/ui/` or `web/src/shell/`.
