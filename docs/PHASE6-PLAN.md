# Phase 6 plan: an assistant that is useful each day, and its own desk

Status: building (2026-10-20). When the phase is done, its decisions move into DESIGN-NEXT as "§13 Phase 6" and this file is deleted.

The bar is a top human executive assistant. Such an assistant owns things and follows through: it knows the owner's day, keeps a list of what is in flight and who it waits on, writes the brief instead of describing it, remembers people, and asks only for decisions. Chat stays the remote control. The web app is where the agent shows its work.

## 0. Rules for every track

- The phase 5 rules stay: the trace is complete, events are append-only, the code stays model-provider-neutral, and safety lives in code and not in prompts. Anything that sends, pays, deletes or unsubscribes waits for the owner.
- **Sending mail stays off.** Every outgoing text is a Gmail draft or a proposal for the owner.
- **Ownership, so tracks do not edit the same files:**
  - each track's API types go in its own import-free file, `src/dashboard/<area>-types.ts`;
  - each track's routes go in `src/dashboard/<area>.ts`, mounted with one line in `server.ts`;
  - each track's web views go in `web/src/views/<area>/` and register themselves through `routes.ts` in that folder;
  - each track's tools go in `src/<area>/tools.ts`, registered with one line where the app builds its tools.
- **Migration numbers:** 021 delegations, 022 docs, 023 people, 024 autonomy, 025 brief.
- **UI work is checked in real Chrome before it counts as done.** Use `web/scripts/shots.ts` at 1440 and 390, light and dark. Cover the empty state, the error state, the first-run state and a full state. Look at every shot.
- **Code that reads Google is also checked against the owner's real accounts**, read-only, on a copy of the database: `sqlite3 data/okc.sqlite ".backup <scratch>/okc.sqlite"`. Each such track writes its own scratch script, like `createGoogleAccounts` and `createGoogleTools` with `createKeyringStore`. A check never archives, labels, unsubscribes, creates events or saves drafts on the real accounts. It does not print mail bodies, and it reports only shapes and counts.

## 1. Tracks

### T1 today: the morning brief, the Today view and the calendar view (owner's daily use)
- **Brief contents:** a `brief` built from:
  - the day across every calendar the owner shows (calendar_list_events data);
  - conflicts between events the owner accepted;
  - **travel gaps**: back-to-back events at different places with less than 15 minutes between them;
  - invitations the owner has not answered;
  - deadlines from mail and the calendar;
  - the inbox digest (needs a reply, bills, packages);
  - delegations that are due or waiting (read through T3's store when present);
  - today's goals.
- **Delivery:** stored as a dated brief (`025_brief.sql`), shown on a **Today** page (`#/today`, now the home screen), and sent as a short Telegram message with a link. It is an automation at 07:30 local time that the owner can move ("move my brief to 8").
- **Calendar view** (`#/calendar`): a week and day grid of every shown calendar, colored by calendar, with the event details in the details panel and pending proposals drawn as dashed blocks. It is read-only. Proposals are approved through the existing flow.
- The text of the brief is short and scannable, and each item links to its source (event, thread, delegation).

### T2 inbox-live: the inbox jobs against real mail (owner's daily use)
- Run the M8 jobs (digest, newsletter sweep, subscription finder, drafts, deadline proposals) against a copy of the real database with read-only Google calls, and fix what real mail breaks. Mail across the 5 accounts includes HTML-only senders, receipts from many merchants, course mail, GitHub notifications and Google security alerts.
- **Quality bar:**
  - the digest puts mail that needs a human reply first and hides automated mail;
  - the subscription finder gets merchant, amount and cadence right for the receipts it finds, and reports confidence honestly;
  - newsletter grouping does not merge different senders;
  - deadline extraction does not invent dates.
- **Schedule:** the digest runs before the brief, so the brief can use it. The jobs run on all accounts, and the views show the account of each item.
- Model calls go through the configured slots.

### T3 desk: delegations (Phase 6 P6-M2)
- **Data:** `021_delegations.sql`: a delegation is a job the owner hands off. Its fields are:
  - title and details;
  - status: `open`, `waiting`, `blocked`, `done`, `dropped`;
  - owner-facing next step;
  - waiting on (a person or an email);
  - due date and next follow-up time;
  - links (runs, docs, mail threads, events);
  - an append-only history.
- **Tools:**
  - `delegation_create`, `delegation_update`, `delegation_wait_on`, `delegation_done`, `delegation_list`;
  - follow-ups through the scheduler: at the follow-up time a run checks the thread and either updates the delegation or drafts a nudge (a draft, never sent).
- **Chat:** "can you handle X" creates a delegation, and the reply says so.
- **Desk view** (`#/desk`): a board with columns by status. Each card shows waiting on, due and the next step. The details panel shows the history and links.

### T4 docs (Phase 6 P6-M3)
- **Data:** `022_docs.sql`: docs and append-only doc_versions in markdown, with a title, kind (brief, plan, notes, comparison, meeting prep, other), links, and an author (agent or owner).
- **Tools:** `doc_write`, `doc_update` (a new version), `doc_read`, `doc_list`, `doc_search` (FTS over docs).
- **Docs view** (`#/docs`, `#/docs/:id`): a list, and a rendered document with a version history and a diff between versions. The owner can comment; a comment becomes an event the agent sees in its next run on that doc. Export is a .md download. Google Docs export waits, because it needs a Drive scope and new sign-ins.
- The agent's chat replies link to a doc instead of pasting long text ("Trip plan is ready → link").

### T5 people (Phase 6 P6-M5, people part)
- **Data:** `023_people.sql`: a person has:
  - names, emails;
  - organization (from the email domain);
  - first and last contact;
  - counts of mail and meetings;
  - upcoming meetings, open threads, and the delegations waiting on them;
  - notes the agent or owner wrote (append-only), and preferences ("prefers mornings").
- **Filling it:** built from mail headers and calendar attendees during the Google polls (no bodies stored). Large mailing lists and no-reply senders are left out.
- **Tools:** `person_lookup`, `person_note`, `people_search`.
- **People view** (`#/people`, `#/people/:id`): searchable, with a profile in the details panel. Event details and chat show a person chip that opens the profile.

### T6 autonomy: the trust ladder (Phase 6 P6-M6)
- **Data:** `024_autonomy.sql`: one autonomy level for each domain, on top of the policy engine. The levels are `ask` (owner approves each call), `review` (the reviewer model decides, the owner sees it) and `auto` (only where the domain allows it). The domains are:
  - mail drafts;
  - mail labels and archive;
  - calendar holds on the owner's own calendar without guests;
  - calendar events with guests (always `ask`);
  - browser form submits;
  - unsubscribes;
  - sandbox network;
  - purchases (always `ask` and never above).
- **Defaults equal today's behavior,** so nothing gets more freedom until the owner changes it.
- **Only the owner can raise a level,** on the dashboard (Agent → Autonomy). No tool can raise a level, and a text in a mail or on a page that asks for one does nothing. Lowering a level is allowed from chat.
- Each decision in the trace records the level that applied.

## 2. Order of work
All six tracks run in parallel, each with a scaffold, parallel work packages, integration, verification (review, an adversarial tester, a spec and platform check, a visual check for UI, and a real-data check for Google), and a fix. A final integration merges them, runs every whole-system check, and lands on master. GitHub CI on the three systems must be green.

## 3. Out of scope
Its own mailbox and calendar (the owner has no use for them yet), sending mail, voice, iMessage and the multi-user version.
