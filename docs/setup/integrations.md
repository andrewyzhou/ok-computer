# Add an MCP integration

Optional. Without `okc.integrations.json` the app has no integrations, and the model's tool list does not change.

## 1. Write `okc.integrations.json`

Put the file next to `okc.config.json`. Example with one local server and one remote server:

```json
{
  "integrations": [
    {
      "id": "notes",
      "kind": "mcp-stdio",
      "command": "npx",
      "args": ["-y", "some-notes-server@1.4.2"],
      "env": { "NOTES_TOKEN": { "secretRef": "notes-token" } },
      "tools": { "allow": ["search_notes", "add_note"] },
      "risk": { "search_notes": "read" },
      "sessions": ["main"]
    },
    {
      "id": "cloud",
      "kind": "mcp-http",
      "url": "https://mcp.example.com/mcp",
      "auth": { "type": "oauth" },
      "tools": { "allow": ["search"] },
      "risk": { "search": "read" }
    }
  ]
}
```

- `id`: at most 24 lower-case letters, digits and dashes. The model sees each tool as `<id>__<tool>`.
- `command` and `args`: pin an exact version, for example `some-notes-server@1.4.2`. For `npx`, `pnpx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec` (or `npm x`) and `bun x`, also behind `cmd /c`, a tag (`@latest`, `@next`), a range (`@^1.2.0`) or no version is refused. A local path needs no version.
- `tools.allow`: the only tools the agent can see. Every other tool of the server is hidden.
- `risk`: `read` runs without approval. A tool without an entry is `write` when the server says it is read only, and `external` otherwise. A `write` call goes to the reviewer model on the `utility` slot, which allows or holds it; when the reviewer fails, you decide. An `external` call asks you each time. The Integrations page shows where each risk comes from.
- `untrustedOutput` (default `true`): the results taint the session, so an `external` call after them always asks you.
- `sessions` (default `["main"]`): `main`, `auto` (automations), or `sub:<profile>` (`sub:browser`, `sub:research`, `sub:inbox`; another name stops the app at start). A sub-agent reaches an integration only through a `sub:<profile>` entry. A sub-agent never asks you: a call that needs your approval is denied in the sub-agent, and the main agent can make it.

An invalid file stops the app at start with a message that names the field.

## 2. Store secrets in the system credential store

The app keeps secrets in the credential store of the system: the Credential Manager on Windows, and the login Keychain on macOS. A `secretRef` (an env value, a bearer token, or a pre-registered OAuth client) names an entry of the service `ok-computer`. Store it in a terminal on this computer.

On Windows:

```
cmdkey /generic:notes-token.ok-computer /user:notes-token /pass:THE_SECRET
```

On macOS:

```
security add-generic-password -U -s ok-computer -a notes-token -w
```

`security` then asks for the secret twice. Keep `-w` last and give it no value, so the secret does not go into the shell history. `-U` replaces an entry that is already there.

On Windows the target is `<secretRef>.ok-computer`. On macOS the entry is a generic password with the service `ok-computer` and the account `<secretRef>`. The app never writes these values to its database, log or trace. OAuth tokens are stored there by the app itself.

To remove an entry:

```
cmdkey /delete:notes-token.ok-computer
security delete-generic-password -s ok-computer -a notes-token
```

Store only short values by hand, for example a token of a few hundred characters. The app splits a value of more than 1,200 characters into parts with the names `<secretRef>#<generation>.<index>`, because Windows keeps at most 2,560 bytes in one entry. It does this only for the values that it writes itself, such as OAuth tokens. Do not edit or remove those parts by hand.

A pre-registered OAuth client (`auth.clientRef`) is JSON, and a terminal removes its quotes on the way to `cmdkey`. On every system, store it in the **OAuth app** panel of the integration's page instead, as [slack.md](slack.md) step 3 shows. The panel writes the JSON in the form that the app reads.

## 3. Restart and connect

Run `okc restart`, then open the dashboard (`okc open`) and go to **Integrations**.

- A stdio or plain http server connects by itself. The page shows its status, its tools, and the next step when something is wrong.
- An OAuth server waits until you press **Connect**. It makes no request before that. A sign-in page opens in a new tab; finish it on this computer, because the callback listens on `127.0.0.1:4318` while the sign-in waits.
- If a sign-in that worked stops working (for example a revoked token), you get one Telegram message with the server's reason and a link to the page.

`npm run chat` shows the same tools but never connects to a server; its calls say that the integration runs only in the background app.
