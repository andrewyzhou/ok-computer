# The agent's browser

The agent searches the web and uses sites through its own Chrome profile in `data/browser/profile`. It is your installed Chrome with a separate profile. Your everyday profile, with its passwords and sign-ins, stays out of reach. Nothing to install: Chrome must be in its usual place.

## 1. Sign in to the sites the agent may use

```
okc browser login
okc browser login https://accounts.google.com/
```

A normal Chrome window opens on the agent profile. Sign in to the sites that the agent may use, then close the window. The sign-ins stay in the profile.

- Password saving and autofill are off in this profile. Sign in by hand.
- Answer Google's consent page once here. Until then, searches go to DuckDuckGo, and the search result says so.
- If Google asks you to prove you are not a robot during searches, solve it here once.
- The window cannot open while the agent uses the browser. The agent closes the browser 10 minutes after its last browser action. Run `okc stop` first if you do not want to wait.

## 2. What the agent can do

| Tool | Risk | What happens |
|---|---|---|
| `web_search` | read | Google in the agent profile, DuckDuckGo when Google shows a CAPTCHA, a consent page, or no result. At most 20 searches an hour for each engine. |
| `web_fetch` | read | Gets a page without a browser and reads its main text (20,000 characters at most; longer text through a handle). |
| `browser_open`, `browser_snapshot`, `browser_screenshot`, `browser_back`, `browser_extract` | read | Opens and reads pages. |
| `browser_click`, `browser_type`, `browser_select` | write | Until the reviewer model exists, you approve each call. |
| `browser_submit` | external | Sends a form. You approve each call. The card shows the page address, the button and every field with its value. If the page differs when you approve, nothing is sent. |
| `browser_allow_domain` | external | Adds a site to the task's allowlist. You approve each call. |

Everything a page or a search shows is outside text: it taints the session, so a later `external` action always asks you.

## 3. Limits that always apply

- **Allowlist per task.** A task starts at its first `browser_open`, and that site (with its subdomains) is its allowlist. A page, a frame, a redirect, a refresh tag or a script cannot move the tab to another site. A link that opens a new tab or window is refused. Each block is recorded on the step.
- **Forms.** A button that sends a form does not work with `browser_click`. A script that sends a form during a click or a typing step is blocked. Only `browser_submit` sends a form.
- **Your own network.** No page, image, script or redirect can reach this PC or your local network (the dashboard, the router, a printer). `web_fetch` checks the address of each connection, so a name cannot point there either.
- **Limits on bad pages.** `web_fetch` reads at most 5 MB (also after decompression), 5 redirects and 20 seconds. A hung page closes its tab, and the task ends.

## 4. What you see on the dashboard

The **Browser** page lists each task and each search. A task opens to its steps: the action, the address before and after, the screenshot, the snapshot that the agent read, the blocked requests and console errors. A finished task has a Playwright trace zip. Open it with `npx playwright show-trace <file>` or at https://trace.playwright.dev (the file stays on your PC).

The trace holds the cookies and requests of the task, like the profile itself. Keep `DASHBOARD_TOKEN` set when the dashboard is reachable from another device.

## 5. When something goes wrong

| You see | Why | What to do |
|---|---|---|
| "The agent browser profile is in use by another Chrome window" | `okc browser login` is open | Close that window. |
| "The browser runs only in the background app" | The message came from `npm run chat` | Use Telegram or the background app. |
| "Google is paused until 14:15 (a CAPTCHA)" | Google asked for a CAPTCHA | Nothing; DuckDuckGo answers until then. Each new CAPTCHA makes the pause longer: 15 minutes, 1 hour, 6 hours, then a day. To end it sooner, solve one with `okc browser login https://www.google.com/`. |
| A task is `interrupted` | The app stopped during the task | Nothing. Its steps are kept. Its trace is lost. |
| A task is `crashed` | Chrome or the tab stopped, or the page hung | Nothing. The next `browser_open` starts a new task. |
