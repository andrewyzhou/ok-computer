# Connect Slack

Optional. Each Slack workspace is one integration. The agent can search and read your Slack messages, and it sends a message only after you approve it. Every 15 minutes a poll reads your new direct messages, without a model call, and stores them for a later step. Nothing shows them to you yet: the heartbeat digest and the Signals page read only Google signals for now.

Read [integrations.md](integrations.md) first. This guide adds the Slack parts.

No test of the app may call the real Slack, so some Slack details in this guide are not checked yet. They are marked **check**. If a step does not match what Slack shows, the fallback server at the end works with a token that you copy by hand.

## 1. Make a Slack app for each workspace

Do this once for each workspace, on this computer.

1. Open https://api.slack.com/apps, choose **Create New App**, then **From scratch**. Name it, for example "OK Computer", and pick the workspace. The app stays internal to that workspace.
2. Open **OAuth & Permissions**.
   - Under **Redirect URLs**, add `https://127.0.0.1:4318/oauth/callback` and save. Slack's documentation says that a redirect URL must use https. **Check:** if Slack also accepts `http://127.0.0.1:4318/oauth/callback`, you can use that address and leave out `"callback": "paste"` in step 2. The sign-in then finishes by itself.
   - Under **User Token Scopes** (not Bot Token Scopes), add `search:read.im`, `search:read.mpim`, `im:history`, `mpim:history`, `users:read` and `chat:write`. A user token is what lets the app read your own direct messages; a bot token cannot.
3. Leave **token rotation** off. The token then does not expire. (With rotation on, the app refreshes the token by itself, but that path is tested only against a fake Slack.)
4. **Check:** if the app settings have a switch for the Slack MCP server or for AI clients, turn it on.
5. Open **Basic Information** and keep the page open. You need the **Client ID** and the **Client Secret** in step 3.

In a workspace that you do not own, an admin may have to approve the app.

## 2. Add the integration

Add one entry to `okc.integrations.json` for each workspace, each with its own `id` and `clientRef`:

```json
{
  "integrations": [
    {
      "id": "slack-work",
      "kind": "mcp-http",
      "url": "https://mcp.slack.com/mcp",
      "auth": {
        "type": "oauth",
        "clientRef": "slack-work-app",
        "scopes": ["search:read.im", "search:read.mpim", "im:history", "mpim:history", "users:read", "chat:write"],
        "callback": "paste"
      },
      "tools": {
        "allow": [
          "slack_search_public_and_private",
          "slack_read_user_profile",
          "slack_read_channel",
          "slack_read_thread",
          "slack_send_message"
        ]
      },
      "risk": {
        "slack_search_public_and_private": "read",
        "slack_read_user_profile": "read",
        "slack_read_channel": "read",
        "slack_read_thread": "read",
        "slack_send_message": "external"
      },
      "poll": "slack-dms"
    }
  ]
}
```

- `scopes` must be the same list as the User Token Scopes of the app. The app asks Slack for exactly this list.
- `slack_send_message` must stay `external`. Then you approve each send, and the card shows the channel and the exact text. Do not add `slack_schedule_message`, `slack_send_message_draft` or the canvas tools to `allow`.
- `poll: "slack-dms"` needs `slack_search_public_and_private` and `slack_read_user_profile` in `allow`. The app refuses the file without them. To stop the poll, turn it off on the **Automations** page; if you remove `poll` from the entry instead, the app turns the poll off at its next start, and turns it on again at the start after you add `poll` back.
- Slack text is untrusted. After the agent reads Slack, every `external` call asks you, also when a rule in `okc.policy.json` allows it.

Run `okc restart`.

## 3. Store the app and sign in

1. Run `okc open`, go to **Integrations**, and open your Slack integration.
2. In the **OAuth app** panel, enter the Client ID and the Client Secret and press **Store**. The app writes them to the system credential store, and no page shows them again: as `slack-work-app.ok-computer` in the Credential Manager on Windows, and as the account `slack-work-app` of the service `ok-computer` in the login Keychain on macOS. To change them, store new values. A Client ID with an empty secret keeps the stored secret of the same Client ID.

   Do not store this value with `cmdkey` or `security`: a terminal removes the quotes of the JSON on the way to `cmdkey`, and the app then says that the secret "is not valid json". The panel writes the JSON in the form that the app reads.
3. Press **Connect**. Slack's consent page opens in a new tab. Allow the access.
4. The browser then goes to `https://127.0.0.1:4318/oauth/callback?code=...` and shows an error page, because nothing answers there with https. That is expected. Copy the whole address of that page, paste it into the box in the **OAuth app** panel, and press **Finish sign-in** within 10 minutes. The address works once.

Do the sign-in on this computer, or over a remote desktop.

## 4. Read the first poll

The first poll runs 15 minutes after the start, and it reads the direct messages of the last day.

1. **Automations** page: the poll is "poll slack-work (slack-dms)". **Run now** polls at once. Its history shows each poll as completed, skipped (with the reason, for example not connected) or failed (with the reason).
2. **Integrations** page, your Slack integration: the JSON-RPC messages list has each poll call with a call id that starts with `poll:slack-work:`. Open the `in` message of a `slack_search_public_and_private` call to see Slack's whole answer.

**Before anything builds on the signals**, open the first real answer of `slack_search_public_and_private` and of `slack_read_user_profile`, remove the names and the message text, and save them as a test fixture. The answer form of the official server is not documented, and the reader of the poll was written against a guess. If the reader cannot read the real form, each poll fails and keeps its position, so no direct message is lost; the fix is a change to the reader with that fixture.

## 5. When something is wrong

| The page, the poll or Telegram says | Do this |
|---|---|
| "the OAuth client of slack-work is not stored yet" | Store the Client ID and the Client Secret (step 3). |
| "... is not valid json" | The client was stored by hand with `cmdkey` or `security`. Store it again on the page (step 3). |
| "The server said: invalid_client: the server said bad_client_secret" (or `invalid_client_id`) | Copy both values again from **Basic Information** and store them. |
| "The server said: invalid_grant: the server said invalid_code" | The address was pasted too late or twice. Press Connect again. |
| Slack's consent page says `bad_redirect_uri` | The redirect URL of the app must be exactly the one that the **OAuth app** panel shows. |
| A tool answers with `missing_scope` | Add the scope that Slack names to the User Token Scopes of the app and to `scopes`, and run `okc restart`. The stored token does not hold the new scope, so the integration then needs a new sign-in: press Connect and paste the address as in section 3. |
| "Connected, but the server did not grant these scopes: ..." | Slack gave a token without those scopes, for example because a workspace admin does not allow them. The tools that need them fail with `missing_scope`. The page shows them under **Not granted**. Ask the admin to allow them, then press Connect and paste the address as in section 3. Slack stays connected with the smaller grant until you paste the address. Or remove the scopes from the app and from `scopes`. |
| Telegram: "The slack-work integration needs you to sign in again" | The token was revoked, for example because the app was removed. Press Connect. |
| A poll is skipped: "slack-work is not connected" | Nothing. The Integrations page says why it is not connected, and the next poll goes on. |
| A poll failed: "could not be read" | Slack answered in a form that the reader does not know. See step 4: save the answer as a fixture, and change the reader. The Slack tools of the agent still work. |
| Telegram: "The automation "poll slack-work (slack-dms)" failed 5 times in a row. I keep it on." | Read the last error on the **Automations** page and fix its cause. The poll stays on and runs at its normal times; a Slack outage of more than about 20 minutes also gives this message. |

## Fallback: a local server with a token that you copy

Use this when the official server does not work for a workspace, for example when Slack refuses both redirect addresses. It runs `slack-mcp-server` on this computer (version 1.3.0, published 2026-05-14, checked on 2026-10-13) with a user token of the same Slack app. **This path has no poll**: the agent reads your direct messages when you ask, or from an automation that you make ("check my Slack DMs every hour").

1. In the app, open **OAuth & Permissions**, press **Install to Workspace**, and copy the **User OAuth Token** (`xoxp-...`). No redirect URL is needed for this.
2. Store it in a terminal. The token has no quotes and is short, so a terminal works. On Windows:

   ```
   cmdkey /generic:slack-work-xoxp.ok-computer /user:slack-work-xoxp /pass:xoxp-...
   ```

   On macOS (`security` asks for the token, so it stays out of the shell history):

   ```
   security add-generic-password -U -s ok-computer -a slack-work-xoxp -w
   ```

   To remove it later: `cmdkey /delete:slack-work-xoxp.ok-computer` on Windows, `security delete-generic-password -s ok-computer -a slack-work-xoxp` on macOS.

3. Use this entry in place of the one in step 2:

```json
{
  "id": "slack-work",
  "kind": "mcp-stdio",
  "command": "npx",
  "args": ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"],
  "env": { "SLACK_MCP_XOXP_TOKEN": { "secretRef": "slack-work-xoxp" } },
  "tools": { "allow": ["conversations_history", "conversations_replies", "conversations_search_messages", "channels_list"] },
  "risk": {
    "conversations_history": "read",
    "conversations_replies": "read",
    "conversations_search_messages": "read",
    "channels_list": "read"
  }
}
```

- **Check** the tool names on the Integrations page after the first start. It lists each allowed name that the server does not have.
- The server cannot send until you allow it: add `"SLACK_MCP_ADD_MESSAGE_TOOL": "true"` to `env`, add `conversations_add_message` to `allow`, and set its risk to `external`. Each send then asks you.
- Do not use the browser-cookie mode (`xoxc` and `xoxd` tokens) of this server. It acts as your browser session, outside what the workspace allowed.
