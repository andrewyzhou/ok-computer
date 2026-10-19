# Open the dashboard from your phone or laptop (Tailscale)

The dashboard listens only on `127.0.0.1:4317` on the computer that runs the agent. Tailscale Serve makes it reachable from your own devices, and from nobody else. Takes about 10 minutes.

## What you need

- Tailscale on the computer that runs the agent, the phone, and the laptop, all signed in to the same tailnet.
- In the Tailscale admin console, under **DNS**: **MagicDNS** on, and **HTTPS Certificates** on.

## Steps

1. **Make a dashboard token.** In a terminal on that computer (PowerShell on Windows, Terminal on macOS):

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **Put the token in `.env`** in the project folder (the file is gitignored):

   ```
   DASHBOARD_TOKEN=<the 64 characters from step 1>
   ```

3. **Share the dashboard on the tailnet:**

   ```
   tailscale serve --bg 4317
   ```

   It prints an address like `https://my-pc.tail1234.ts.net`. Use `serve`, never `funnel`: Funnel puts the dashboard on the public internet.

4. **Tell OK Computer the address.** In `okc.config.json`:

   ```json
   { "dashboard": { "publicUrl": "https://my-pc.tail1234.ts.net" } }
   ```

   The address must start with `https://`. The dashboard accepts that host name only while `DASHBOARD_TOKEN` is set. Without the token, the log says that `publicUrl` is ignored.

5. **Restart:** `okc restart`.

6. **Sign in once on each device.** With Tailscale on, send `/dashboard` to the bot in Telegram. It answers with a sign-in link. Open it and press **Sign in**. The link works one time, for 5 minutes. Opening the page does not use it up, so a link preview in Telegram does no harm; only the button signs you in.

   On a device without Telegram, open the address. The page sends you to `/login`. Paste the token and press **Sign in**.

   The browser keeps a sign-in cookie for 30 days. The cookie holds a random id, not the token. The app keeps the ids in memory, so after `okc restart` each device signs in again with a new `/dashboard` link.

   Share nothing else on this tailnet name: no other `tailscale serve` port and no other `--set-path`. A browser sends the cookie to every port and every path of the name, so another service there would receive it and could use it until it expires.

The dashboard on that computer itself (`http://127.0.0.1:4317`) asks for the token too while `DASHBOARD_TOKEN` is set. A sign-in there lasts until you close the browser, for at most 12 hours, and ends when the app restarts. The browser sends a cookie of `127.0.0.1` to every local port, also to other programs that you open there, so this cookie is short.

## Sign everyone out

Run `okc restart`. Every old cookie stops working. If someone else may know the token, put a new token in `.env` before the restart.

## Stop sharing

```
tailscale serve reset
```

## If something is wrong

| You see | Why | Fix |
|---|---|---|
| `forbidden` | The host name is not `127.0.0.1` or the host of `dashboard.publicUrl`, or `DASHBOARD_TOKEN` is not set | Check step 2 and step 4, then restart |
| `/dashboard` explains what to set instead of a link | `DASHBOARD_TOKEN` or `dashboard.publicUrl` is missing | Check step 2 and step 4, then restart |
| `/dashboard` says that the dashboard did not start | Another program, often an older copy of the app, holds the port | End that program (check its command line first), then `okc restart` |
| "This link does not work any more" | The link is older than 5 minutes, was used already, or the agent restarted | Send `/dashboard` again |
| The login page again after you sign in | The browser did not keep the cookie | Allow cookies for the `ts.net` address |
| The page does not load at all | Tailscale is off on the device, or Serve is not running | Turn Tailscale on; run `tailscale serve status` on the computer that runs the agent |

OAuth sign-ins for integrations still work only on the computer that runs the agent (the callback listens on `127.0.0.1:4318`).
