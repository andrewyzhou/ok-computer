# The agent's browser

The agent searches the web and uses sites through its own Chrome profile in `data/browser/profile`. It is your installed Chrome with a separate profile. Your everyday profile, with its passwords and sign-ins, stays out of reach. Nothing to install: Chrome must be in its usual place. Without Chrome, the browser tools and `web_search` say so, and `web_fetch` still works.

## 1. Sign in to the sites the agent may use

```
okc browser login
okc browser login https://accounts.google.com/
```

A normal Chrome window opens on the agent profile. Sign in to the sites that the agent may use, then close the window. On macOS, quit Chrome with Command-Q instead, because Chrome on macOS keeps running after its last window closes. The sign-ins stay in the profile.

- Password saving and autofill are off in this profile. Sign in by hand. The agent never types or sends a password: a password field is masked in everything the agent reads, and the tools refuse it.
- Answer Google's consent page once here. Until then, searches go to DuckDuckGo, and the search result says so.
- If Google asks you to prove you are not a robot during searches, solve it here once. When the window closes, each paused search engine tries again at the next search.
- The window cannot open while the agent uses the browser. The agent closes the browser 10 minutes after its last browser action. Run `okc stop` first if you do not want to wait. The Browser page of the dashboard says whether the profile is open now.

## 2. What the agent can do

| Tool | Risk | What happens |
|---|---|---|
| `web_search` | read | Google in the agent profile, DuckDuckGo when Google shows a CAPTCHA, a consent page, or no result. At most 20 searches an hour for each engine, one at a time. |
| `web_fetch` | read | Gets a page without a browser and reads its main text (20,000 characters at most; longer text through a handle). |
| `browser_open`, `browser_snapshot`, `browser_back`, `browser_extract`, `browser_close` | read | Opens and reads pages. |
| `browser_click`, `browser_type`, `browser_select` | write | The reviewer model checks each call first. When the reviewer fails, you approve the call (see section 3). The card names the element. |
| `browser_submit` | external | Sends a form with its button or link, also in a frame of the page, or presses a button that sends data with a script. You approve each call, also when a rule of yours allows browser tools. The card shows the page address, the button and every field of its form with its value. If the page differs when you approve, nothing is sent. |
| `browser_allow_domain` | external | Adds a site to the allowlist of the open task. You approve each call, also when a rule in `okc.policy.json` allows external tools. |

Everything a page or a search shows is outside text: it taints the session, so a later `external` action always asks you.

One browser task runs at a time. Another conversation that wants the browser gets "busy" until the task ends (`browser_close`, or 10 minutes without an action). A task that waits for you to approve a submit or a new domain stays open until you answer. The task of a sub-agent or of an isolated automation run goes to the next conversation that uses the browser once that run ends, so the parent can check the page after it sends the form, and close it.

## 3. Clicks and typing

A click, a typed text and a choice in a list are `write` actions. The reviewer model checks each one against your last message. When it holds a call, the agent hears why; when the reviewer fails, the call becomes an approval card. An allow rule in `okc.policy.json` (next to `okc.config.json`) skips the reviewer:

```json
{
  "rules": [
    { "tool": "browser_click", "effect": "allow", "note": "clicks change only the page on this computer" },
    { "tool": "browser_select", "effect": "allow" }
  ]
}
```

What such a rule risks: the browser session is always tainted, and a rule for a `write` tool holds in a tainted session. A page can then lead the agent to click a link or a search form that carries text to a site on the task's allowlist in its address. A request that sends data (a form post, a script's `fetch` post, a beacon) is still blocked outside `browser_submit`, and other sites stay blocked. Be more careful with `browser_type`: allow it only if you accept that typed text can reach an allowlisted site through a search box, and any site through a script of the page, which can put the text in the address of an image. Each step on the Browser page lists the sites off the allowlist that its requests reached. With the reviewer, you do not need these rules.

## 4. Limits that always apply

- **Allowlist per task.** A task starts at its first `browser_open`, and that site (with its subdomains) is its allowlist. A page, a frame, a redirect, a refresh tag or a script cannot move the tab to another site. A link that opens a new tab or window is refused, and a web socket needs the allowlist too. Each block is recorded on the step, and the tab goes back to the page it was on. Only `http` and `https` addresses open, and a task cannot start on a public suffix such as `com` or `co.uk`.
- **Sending data.** Every request with a body, and every request other than GET, HEAD or OPTIONS, is blocked outside an approved `browser_submit`: a form post, a script's `fetch` or XHR post, a beacon. The form that a submit sends must hold exactly the fields that the check read; a page that changes a field at the click sends nothing. During a submit, data goes only to the sites on the task's allowlist. A site that sends its form with a script can send other data to its own site; the Browser page marks the request of the form ("the form") apart from the others ("sent by the page") and shows the start of each sent body. A submit waits up to 5 seconds for the request of the form, and then until the page sends nothing for a second. When the form does not leave, the submit says that the form was not sent, also when the page sent other data such as a beacon. When the form left but the page then tried to go to a page that was blocked, the submit is an error, because the page may not have finished; a blocked beacon after the form left shows on the step, but it is not an error. When a page sends its form with a script in another shape (for example JSON), the submit names the requests that the page sent and does not say that the form was sent, so check the page before you send again. When more than one button has the name (an "Add to cart" for each product), the agent gives the ref of the one to press. A search box (a GET form) and the button of a dialog (for example a cookie notice) still work with `browser_click`. A button that sends data with a script, such as "Add to cart" outside a form, also needs `browser_submit`; such a button sends what the page chooses, so the approval card shows no fields, and the step on the Browser page shows the start of each body that it sent. A submit that redirects its post to another site is blocked at the hop. A link that sends a form (for example an ASP.NET page) works with `browser_submit`; its script may set the hidden fields of the form, but not a field that the card shows. When a page asks a question (`confirm`) during an approved submit, the browser says yes; at any other moment it says no. Each step names the question.
- **Your own network.** No page, image, frame, script, worker, web socket or redirect can reach this computer or your local network (the dashboard, the router, a printer). Your network is the private address ranges, each address of this computer, and the IPv6 subnet (/64) of this computer. If your router gives your network more than one IPv6 subnet, the other subnets count as public. The agent browser connects only through a small proxy inside the app, which checks the address of each connection and connects to that address, so a name cannot point there either. `web_fetch` checks each connection the same way. Shared workers, page preloading, WebRTC and the reporting of Chrome (which sends reports outside the page) are off. Each step lists the sites off the allowlist that any connection of the browser reached.
- **Leaving a page.** When a task closes, for any reason, the tab first goes to an empty page while the checks still hold, so the data that a page sends as it goes away (a beacon in `pagehide` or `unload`) is blocked and recorded in a last `close` step.
- **A page that keeps sending.** Each step keeps the first 200 blocked requests and counts the others.
- **Refs.** Each snapshot numbers its refs (`s3e12`). A ref of an older snapshot is refused, so an approval that comes hours later can never click another element.
- **Limits on bad pages.** `web_fetch` reads at most 5 MB (also after decompression), 5 redirects and 20 seconds. Text extraction runs in a worker thread with a 5-second limit. A hung page closes its tab, and the task ends.

## 5. What you see on the dashboard

The **Browser** page shows the state of each search engine (ready, or paused with the reason and the end of the pause), whether the agent profile is open, and each task and search with its blocked requests (red) and the requests that an approved submit sent (orange). A task opens to its steps: the action, the address before and after, the risk and the policy decision of the tool call with its approval, the screenshot, the snapshot that the agent read, the blocked and sent requests, and console errors.

A finished task has a Playwright trace zip. Open it with `npx playwright-core show-trace <file>` or at https://trace.playwright.dev (the file stays on your computer).

- **The trace holds** a screenshot of each action, the list of actions with their addresses, what the agent typed (the same text as the tool call on the run page), and console messages with the address of their page. A page can write anything to its console, also a password value, its cookies or its HTML, and the trace then keeps it. A `web_search` of any conversation that runs while a task is open also shows in that task's trace (frames of the search page and its console messages, with the query). For this reason `browser_open` and `web_search` refuse an address or a query that holds text with the shape of a secret, such as an API key.
- **The trace leaves out** cookies and request headers, the network log, response bodies, the page HTML and DOM, and password values, unless the page writes them to its console.
- **Screenshots are not redacted.** A screenshot shows the page as it was: your account name, an order, a message. A password field shows dots. Keep `DASHBOARD_TOKEN` set when the dashboard is reachable from another device.

Nothing removes screenshots and traces yet. Screenshots grow in `data/blobs`, and trace zips in `data/browser/traces`. A prune command is planned (DESIGN-NEXT 2.1).

## 6. When something goes wrong

| You see | Why | What to do |
|---|---|---|
| "The agent browser profile is in use by another Chrome window" | `okc browser login` is open | Close that window (on macOS, quit that Chrome with Command-Q). |
| "The browser runs only in the background app" | The message came from `npm run chat` | Use Telegram or the background app. |
| "The browser is busy with a task of another session" | Another conversation has the open task, and its run still works or a submit of it waits for you | Wait, or tell that conversation to call `browser_close`. The task of a sub-agent or an isolated automation that finished is never busy: the next conversation takes it over. |
| "Google is paused until 14:15 (a CAPTCHA)" | Google asked for a CAPTCHA | Nothing; DuckDuckGo answers until then. Each new CAPTCHA makes the pause longer: 15 minutes, 1 hour, 6 hours, then a day. To end it sooner, solve one with `okc browser login https://www.google.com/`; closing that window (on macOS, quitting that Chrome with Command-Q) ends the pause. A pause that ends on another day shows its date. |
| A submit you approved says "the form was not sent" | The page did not send the form, for example because it opens a new tab, a script changed a field at the click, or the page sent its data to a site off the allowlist | Look at the blocked and sent requests of the step on the Browser page. The form was not sent; a request marked "sent by the page" did leave. |
| A submit you approved says "the form was sent, but the gate refused ... later requests" | The page sent the form, then something more that was blocked, for example a post to a site off the allowlist or a post more than a second later | Look at the step on the Browser page, and check on the site whether the order or message went through. |
| A step has no snapshot: "more than 200" password fields | A page with that many filled password fields is not a page a person uses | Nothing. The screenshot is still kept. |
| A submit you approved says "No page is open" | The task ended (`browser_close`, 10 minutes idle before the agent asked you, or a restart) before you approved | Ask the agent to open the page again; it asks you again. |
| A task is `interrupted` | The app stopped during the task | Nothing. Its steps are kept. Its trace is lost. |
| A task is `crashed` | Chrome or the tab stopped, or the page hung | Nothing. The next `browser_open` starts a new task. |
