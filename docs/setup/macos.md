# Set up ok computer on a new Mac

These are the steps for a new Mac, in order. Each step links to the part of the docs that explains it in full.

## 1. Install Node 24 and the packages

1. Install Node 24, the version that `.nvmrc` names. Node 24 to 26 runs the app. Check it in a new terminal:

   ```sh
   node -v
   ```

2. In the project folder, install the packages and build once:

   ```sh
   npm ci
   npm run build
   ```

## 2. Make the settings

1. Make `.env` in the project folder with `ANTHROPIC_API_KEY` and `DASHBOARD_TOKEN`. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` only when this Mac is the live instance, because only one host may poll the bot ([aws.md, section 10](aws.md#10-move-the-live-telegram-role-between-hosts-d15)). The [Tailscale guide](tailscale.md) shows how to make a dashboard token.
2. Settings go in `okc.config.json` next to `README.md`. A missing file gives the defaults.

## 3. Install the okc command and the LaunchAgent

```sh
scripts/okc.sh install
```

This adds `~/.local/bin/okc` and the LaunchAgent `~/Library/LaunchAgents/com.okcomputer.agent.plist`, and starts the agent. The agent then starts each time you sign in. The README section [On macOS](../../README.md#on-macos) lists the commands, and DESIGN.md §18 explains what the LaunchAgent does.

Put `~/.local/bin` on your `PATH` if it is not there yet. With the default shell (zsh):

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile
```

Open a new terminal and check it with `okc status`.

The plist holds the absolute path of the `node` that ran the install. When a node update moves `node` to a new path, run `okc install` again.

## 4. Answer the Keychain prompt

Secrets go in the login Keychain (service `ok-computer`). When the agent first reads an entry, macOS asks whether `node` may use it. Choose **Always Allow**: under the LaunchAgent the read waits until you answer. macOS asks again after each node update, because the program changed. See [integrations.md, section 2](integrations.md#2-store-secrets-in-the-system-credential-store).

## 5. Chrome

The agent's browser and `web_search` use the installed Chrome, in its usual place in `/Applications`, with a profile of its own. Without Chrome, the browser tools say so and the rest of the app works. Sign in to the sites that the agent may use with `okc browser login`, and quit Chrome with Command-Q when you are done ([browser.md](browser.md)).

## 6. The accounts and the optional parts

- Gmail and Calendar: [google.md](google.md).
- Slack: [slack.md](slack.md). Other MCP servers: [integrations.md](integrations.md).
- The dashboard on the phone and the laptop: [tailscale.md](tailscale.md).
- The code sandbox: Docker Desktop and `npm run sandbox:image`, see [sandbox.md](sandbox.md).
