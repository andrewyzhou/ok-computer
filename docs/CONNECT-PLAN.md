# Plan: one-tap sign-in, a connections hub, and the bank

Status: building (2026-10-21). When it is done, its decisions move into DESIGN-NEXT as "§14 Connections and sign-in" and this file is deleted.

The owner should never edit a JSON file, or paste a long token, to use the app. Each service gets a Connect button, and signing in takes a code that arrives by text.

## 0. Rules for every track

- The rules of phases 5 and 6 stay: the trace is complete, history is append-only, the code stays model-provider-neutral, safety lives in code, sending mail stays off, and anything that sends, pays, deletes or unsubscribes waits for the owner. **No tool can move money.**
- **Secrets** live only in the configured `SecretStore` (`src/secrets/`: the system keyring on a desktop, AWS Secrets Manager on the server), or in `.env` for the ones the owner already put there. They never go in the database, in logs or in API answers. The redactor registers each new secret. Never call the keyring directly.
- **Built for the server.** The agent will move to one always-on AWS host (the phase 5 M7 deploy: Docker, Secrets Manager, Litestream, Tailscale), and the owner's machines become screens. So every connect flow must work when the dashboard is reached at `dashboard.publicUrl`, for example a Tailscale https name, and not only on loopback:
  - OAuth redirect URIs come from the public URL when it is set;
  - Plaid Link runs in the browser that views the dashboard;
  - nothing assumes that the browser and the agent are on the same machine.
  
  Test each flow with a public URL and with loopback.
- **Ownership:**
  - API types go in `src/dashboard/<area>-types.ts`, import-free;
  - routes go in `src/dashboard/<area>.ts`, mounted with one line;
  - views go in `web/src/views/<area>/` with their own `routes.ts`;
  - modules go in `src/<area>/`.
- **Migrations:** 028 sign-in sessions, 029 connectors, 030 plaid.
- UI is checked in real Chrome with `web/scripts/shots.ts`, at 1440 and 390, light and dark, in its empty, error, first-run and full states. Every shot is looked at.

## 1. Tracks

### S1 signin: a code by text, and remember me
- **The login page** keeps the token field as a fallback and adds "Text me a code". The app sends a 6-digit code to the owner's Telegram chat (the text channel of the app), on loopback as well as on the public URL.
  - The code lasts 10 minutes and allows 5 tries.
  - Sending is rate-limited, each code is single-use, and it is compared in constant time.
- **"Remember this device"** gives a session of 90 days on loopback and 30 days on the public URL. Without it, the session is 12 hours.
- **Sessions are kept** in the database (`028_sessions.sql`), as a hash of the cookie value only, so a restart no longer signs the owner out.
  - The cookie is HttpOnly and SameSite=Strict, and Secure on https.
  - A session records the device (user agent), its creation and its last use.
- **Settings → Sign-in** lists the sessions, and can sign out one or all of them.
- **The Telegram command /dashboard** keeps working: it sends a sign-in link.
- **SMS** is not part of this: the app has no SMS provider, and Telegram is the text channel.

### S2 connections: the hub and the Connect buttons
- **A connector registry** in `src/connectors/`. Each connector has:
  - an id, a name, an icon, a short line on what the agent can do with it, and a kind (`mcp-oauth`, `native`, `env-keys`);
  - the setup steps the owner must do, if any;
  - its status (not connected, connecting, connected, needs sign-in, error with the reason) and its accounts;
  - connect, disconnect and test;
  - its tools, each with its risk.
  
  The registry exposes the interface `ConnectorDef` from `src/connectors/types.ts`, so the plaid track can add its connector with one registration line.
- **Managed integrations** are kept in the database (`029_connectors.sql`): which preset, its settings, its tool allow list and risks. They join the entries of `okc.integrations.json`, which stays for advanced use. A connect or disconnect applies without a restart of the app when the integration layer allows it; otherwise the page says one restart is needed and offers a button.
- **Presets** (check each service's current official MCP server and its sign-in before building; do not guess URLs):
  - **GitHub, Linear, Notion:** the official remote MCP servers with OAuth sign-in through the existing `src/integrations/oauth.ts`.
  - **Slack:** the existing native Slack integration, given a Connect button (see `docs/setup/slack.md`). Where Slack needs the owner to make an app, the card walks them through it step by step with copy buttons, and the owner pastes nothing into a file.
  - **Granola:** only if an official server exists; otherwise the card says it is not available yet.
  - **Defaults:** read tools on, and every write asks the owner.
- **The Connections page** (`#/connections`, nav group Connections, replacing the separate Integrations entry; Google keeps its page and gets a card here):
  - a grid of cards with a status dot, Connect / Disconnect / Reconnect, the last error in full, and the tools with a switch each;
  - a details panel with the account and its activity.
  
  It must look as finished as the rest of the app.
- Untrusted output stays marked. A connector's tools join the policy and autonomy rules like any integration.

### S3 plaid: the bank, read-only, for subscriptions
- **Native module** `src/plaid/`:
  - The client ID and secret come from `PLAID_CLIENT_ID` and `PLAID_SECRET` in `.env`, or from the keyring when they are entered on the dashboard. The Plaid environment is set in config; check which environment the owner's free hobby plan (10 connections) uses.
  - **Plaid Link** runs in the dashboard (its official script). The public token is exchanged on the server. Each access token goes to the keyring and never to the database.
  - **Data** (`030_plaid.sql`): items, accounts (name, mask, type), the sync cursor, and **recurring streams only**: merchant, amount, frequency, last and next date, status, category, and the price history of each stream. Single transactions are read for the sync and then dropped, except the ones in a recurring stream.
  - A daily sync (`/transactions/sync` and `/transactions/recurring/get`) through the scheduler, plus "Sync now". A failed or expired item shows "Reconnect", which uses Link in update mode.
- **Subscriptions** join the email finder in `src/inbox/subscriptions.ts`: one row for each real subscription, with its source (bank, receipt or both), a confidence value, and the cancel help that exists today.
- **Alerts:** a new subscription, a price increase, a free trial that turns into a charge (from receipts or a first charge after a trial), a duplicate service, and a charge for something not used. They appear in the brief (a "Money" section) and on the Subscriptions page.
- **Plaid card** in the connections hub, through `ConnectorDef`: Connect opens Link; Disconnect removes the item at Plaid and deletes the token.
- **No tool moves money. No tool can start a payment, a transfer or a purchase.** Bank text is untrusted.

## 2. Order of work
The three tracks run in parallel, each with a scaffold, packages, integration, verification (review, tester, spec and platform, visual, and for S2 and S3 a security pass on token handling) and a fix. A final integration merges them, runs the whole-system checks, lands on master, and GitHub CI must be green.
