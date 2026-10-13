# The agent's browser

The agent searches the web and uses sites through its own Chrome profile in `data/browser/profile`. It is your installed Chrome with a separate profile. Your everyday profile, with its passwords and sign-ins, stays out of reach. Nothing to install: Chrome must be in its usual place. Without Chrome, the browser tools and `web_search` say so, and `web_fetch` still works.

## 1. Sign in to the sites the agent may use

```
okc browser login
okc browser login https://accounts.google.com/
```

A normal Chrome window opens on the agent profile. Sign in to the sites that the agent may use, then close the window. The sign-ins stay in the profile.

- Password saving and autofill are off in this profile. Sign in by hand. The agent never types or sends a password: a password field is masked in everything the agent reads, and the tools refuse it.
- Answer Google's consent page once here. Until then, searches go to DuckDuckGo, and the search result says so.
- If Google asks you to prove you are not a robot during searches, solve it here once.
- The window cannot open while the agent uses the browser. The agent closes the browser 10 minutes after its last browser action. Run `okc stop` first if you do not want to wait. The Browser page of the dashboard says whether the profile is open now.

## 2. What the agent can do

| Tool | Risk | What happens |
|---|---|---|
| `web_search` | read | Google in the agent profile, DuckDuckGo when Google shows a CAPTCHA, a consent page, or no result. At most 20 searches an hour for each engine, one at a time. |
| `web_fetch` | read | Gets a page without a browser and reads its main text (20,000 characters at most; longer text through a handle). |
| `browser_open`, `browser_snapshot`, `browser_back`, `browser_extract`, `browser_close` | read | Opens and reads pages. |
| `browser_click`, `browser_type`, `browser_select` | write | Until the reviewer model exists, you approve each call (see section 3). The card names the element. |
| `browser_submit` | external | Sends a form. You approve each call. The card shows the page address, the button and every field with its value. If the page differs when you approve, nothing is sent. |
| `browser_allow_domain` | external | Adds a site to the allowlist of the open task. You approve each call, also when a rule in `okc.policy.json` allows external tools. |

Everything a page or a search shows is outside text: it taints the session, so a later `external` action always asks you.

One browser task runs at a time. Another conversation that wants the browser gets "busy" until the task ends (`browser_close`, or 10 minutes without an action).

## 3. Before the reviewer model: clicks and typing

A click, a typed text and a choice in a list are `write` actions. Until the reviewer model (phase 3 M3) exists, each one becomes an approval card, so real browsing is slow. You can allow them in `okc.policy.json` (next to `okc.config.json`):

```json
{
  "rules": [
    { "tool": "browser_click", "effect": "allow", "note": "clicks change only the page on this pc" },
    { "tool": "browser_select", "effect": "allow" }
  ]
}
```

What such a rule risks: the browser session is always tainted, and a rule for a `write` tool holds in a tainted session. A page can then lead the agent to click a link or a search form that carries text to a site on the task's allowlist in its address. A request that sends data (a form post, a script's `fetch` post, a beacon) is still blocked outside `browser_submit`, and other sites stay blocked. Be more careful with `browser_type`: allow it only if you accept that typed text can reach an allowlisted site through a search box. Remove the rules when the reviewer arrives.

## 4. Limits that always apply

- **Allowlist per task.** A task starts at its first `browser_open`, and that site (with its subdomains) is its allowlist. A page, a frame, a redirect, a refresh tag or a script cannot move the tab to another site. A link that opens a new tab or window is refused. Each block is recorded on the step, and the tab goes back to the page it was on.
- **Sending data.** Every request other than GET, HEAD or OPTIONS is blocked outside an approved `browser_submit`: a form post, a script's `fetch` or XHR post, a beacon. A search box (a GET form) still works with `browser_click`. A submit that redirects its post to another site is blocked at the hop.
- **Your own network.** No page, image, frame, script or redirect can reach this PC or your local network (the dashboard, the router, a printer). `web_fetch` checks the address of each connection, so a name cannot point there either.
- **Refs.** Each snapshot numbers its refs (`s3e12`). A ref of an older snapshot is refused, so an approval that comes hours later can never click another element.
- **Limits on bad pages.** `web_fetch` reads at most 5 MB (also after decompression), 5 redirects and 20 seconds. Text extraction runs in a worker thread with a 5-second limit. A hung page closes its tab, and the task ends.

## 5. What you see on the dashboard

The **Browser** page shows the state of each search engine (ready, or paused with the reason and the end of the pause), whether the agent profile is open, and each task and search with its blocked requests (red) and the requests that an approved submit sent (orange). A task opens to its steps: the action, the address before and after, the risk and the policy decision of the tool call with its approval, the screenshot, the snapshot that the agent read, the blocked and sent requests, and console errors.

A finished task has a Playwright trace zip. Open it with `npx playwright-core show-trace <file>` or at https://trace.playwright.dev (the file stays on your PC).

- **The trace holds** a screenshot of each action, the list of actions with their addresses, what the agent typed (the same text as the tool call on the run page), and console messages.
- **The trace leaves out** cookies and request headers, the network log, response bodies, the page HTML and DOM, and password values.
- **Screenshots are not redacted.** A screenshot shows the page as it was: your account name, an order, a message. A password field shows dots. Keep `DASHBOARD_TOKEN` set when the dashboard is reachable from another device.

Screenshots and traces stay until a later `okc prune`.

## 6. When something goes wrong

| You see | Why | What to do |
|---|---|---|
| "The agent browser profile is in use by another Chrome window" | `okc browser login` is open | Close that window. |
| "The browser runs only in the background app" | The message came from `npm run chat` | Use Telegram or the background app. |
| "The browser is busy with a task of another session" | Another conversation has the open task | Wait, or tell that conversation to call `browser_close`. |
| "Google is paused until 14:15 (a CAPTCHA)" | Google asked for a CAPTCHA | Nothing; DuckDuckGo answers until then. Each new CAPTCHA makes the pause longer: 15 minutes, 1 hour, 6 hours, then a day. To end it sooner, solve one with `okc browser login https://www.google.com/`. |
| A submit you approved says "No page is open" | The task ended (10 minutes idle, or a restart) before you approved | Ask the agent to open the page again; it asks you again. |
| A task is `interrupted` | The app stopped during the task | Nothing. Its steps are kept. Its trace is lost. |
| A task is `crashed` | Chrome or the tab stopped, or the page hung | Nothing. The next `browser_open` starts a new task. |
