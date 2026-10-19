# Connect Gmail and Google Calendar

Optional. Without a `google` block in `okc.config.json` the app has no Google tools, does not poll, and shows "Google is not configured" on the Google page. The first time takes about 10 minutes, then about 1 minute for each account.

## 1. Create the Google Cloud project (one time)

1. Open https://console.cloud.google.com and create a project, for example `ok-computer`.
2. **APIs & Services → Library**: turn on the **Gmail API** and the **Google Calendar API**.
3. **Google Auth Platform → Branding / Audience** (the OAuth consent screen):
   - User type **External**. App name `OK Computer`. Use your own address as the support and developer contact.
   - **Audience → Publish app**, so the status is **In production**. Do not submit it for verification. In **Testing** mode Google ends each sign-in after 7 days.
   - You do not need to add scopes here. The app asks for them at sign-in.
4. **Clients → Create client**, type **Desktop app**. Download the JSON file (`client_secret_….json`). Keep it on this computer. A **Web application** client does not work.

## 2. Configure the accounts

Add this block to `okc.config.json`. If the file does not exist, create it next to `README.md`.

```json
{
  "google": {
    "clientId": "1234567890-abc.apps.googleusercontent.com",
    "accounts": [
      { "alias": "personal", "email": "you@gmail.com" },
      { "alias": "school", "email": "you@school.edu" }
    ],
    "send": false,
    "sessions": ["main"],
    "pollMinutes": 15
  }
}
```

- `clientId`: the client ID of the Desktop app client (it ends in `.apps.googleusercontent.com`). It is not a secret.
- `alias`: at most 16 lower-case letters, digits and dashes, but not `all` (the agent uses `all` for every account). The agent names an account by its alias.
- `email` (optional, recommended): a sign-in with another Google account is refused, so an alias can never read the wrong mailbox.
- `send` (default `false`): when `true`, the sign-in also asks for permission to send mail, and the agent gets `gmail_send`. You approve each send. If you change it later, connect each account again. With `false` the agent has no send tool, but Google lets the "modify" permission send mail too, so the limit is in the app, not in the token.
- `sessions`: `main`, and also `auto` if your automations may use Gmail and Calendar, or `auto-read` if they may only read mail and the calendar (search, read, labels, events, free/busy).
- `pollMinutes` (default 15, at least 5).

Run `okc restart`. If the block is invalid, the app stops at start and the message names the field.

## 3. Store the client secret and connect each account

Open the dashboard on this computer (`okc open`), then go to **Google**.

1. Under **Accounts**, use **Upload the client file** and pick the downloaded `client_secret_….json`. The app checks that the client ID matches `clientId`. Only the secret is kept, in the system credential store: the Credential Manager on Windows (`google.client.ok-computer`), and the login Keychain on macOS (service `ok-computer`, account `google.client`). It never goes into the database.
2. Press **Connect** next to an account. A new tab opens the Google sign-in.
   - Pick the account that matches the alias. If your browser is signed in to several accounts, check the address.
   - Google says that the app is not verified. Click **Advanced → Go to OK Computer (unsafe)**. This is your own app.
   - **Keep every box checked.** If a permission is missing, the app saves nothing and the page names the permission.
3. The tab shows "Signed in as …". The link works once, for 10 minutes, and only on this computer (the answer goes to a port on `127.0.0.1`).
4. Repeat for each alias.

## 4. What happens next

- Every `pollMinutes`, the app reads the new inbox mail and the calendar changes of each signed-in account. Mail from before the sign-in is not news. Each poll is a run on the **Runs** page (trigger `poll`), with every request to Google and every classifier call.
- New items become **signals**. Code checks two things first: a date in a mail that no event of that day matches, and an event that starts within two hours. Then a cheap model labels each mail (`needs_reply`, `deadline`, `event_change`, `newsletter`, `noise`). The heartbeat reads at most 20 new signals (detector hits first) and tells you only what needs attention. When a signal makes two heartbeat runs fail (the model refuses it, or the run hits its step limit), later runs see it without its text; a model outage does not count. It runs for signals also when the heartbeat checklist is empty, so you only need `heartbeat.every`. Newsletters and noise without a detector hit are closed without a model call. The **Signals** page shows what happened to each signal.
- **Only the primary calendar** of each account is read and written. A deadline that is only on another calendar (a class calendar, a subscribed feed) is reported as not on the primary calendar, and free/busy ignores the other calendars. To have such deadlines count, add them to the primary calendar.
- **The heartbeat checklist** can be changed by a heartbeat run only when that run read no outside text. A heartbeat that saw new mail cannot change it; change it in chat or on the dashboard.
- **Approvals.** These always ask you: sending mail, unsubscribing, an event with guests (Google sends them invitations), and changing or deleting an event. The card shows the sender and the exact unsubscribe link, the recipients, or the current title of the event.
- **Write tools.** Archive, labels, mark as read, drafts and private events go to the reviewer model first. It reads your last message and the exact call, and it lets the call run or holds it; when the reviewer fails, the call asks you. An allow rule in `okc.policy.json` (next to `okc.config.json`) skips the reviewer:

  ```json
  {
    "rules": [
      { "tool": "google__gmail_draft", "effect": "allow" },
      { "tool": "google__calendar_create_event", "effect": "allow", "note": "private events only; an event with guests still asks" }
    ]
  }
  ```

  An allow rule on a write tool also holds after the agent read mail, and then nothing checks the call. Text in one mail could make the agent archive or mark as read your other mail, which hides it from your inbox. So do not add allow rules for `google__gmail_archive`, `google__gmail_mark_read` or `google__gmail_label` unless you accept that. An allow rule never lets an event invite people, and the label tool cannot move mail to the trash or to spam.
- **Unsubscribe** uses only the sender's own `List-Unsubscribe` header: a one-click link (only when Gmail saw a valid DKIM signature of the sender's domain that covers the unsubscribe headers, and never to an address inside your network) or a mail (only with `send: true`, only with the same DKIM check, and only to one address in the sender's own domain or a subdomain of it, so a sender cannot make your account mail a stranger; a list whose unsubscribe address is at another domain, or at a parent of the sender's domain, is refused). Otherwise the agent gives you the link.
- **Inbox jobs.** With a `google` block, the app adds three automations one time: **inbox: daily digest** (07:30 every day), **inbox: newsletter sweep** (09:00 on Saturday) and **inbox: subscription finder** (10:00 on Sunday), in the time zone of the app. Change the time or turn a job off on the **Automations** page; the app never adds a deleted one again. The pages under **Inbox** show the results, and their **Run the digest now**, **Sweep now** and **Scan now** buttons start a job at once. The jobs never send mail. An unsubscribe, an archive, a cancellation and a calendar event each ask you first. Draft replies go to Gmail Drafts after the reviewer checks them, and you send them yourself. An https unsubscribe or a cancellation opens a browser task, and each form it sends asks you; the row shows as pending until that task ends.

## 5. When something goes wrong

The Google page says what to do for each account.

- **"Google stopped accepting the sign-in of the X account"** (one Telegram message): the access was removed, the password changed, the account was unused for 6 months, or the client has more than 100 sign-ins. It also comes when the account was signed in with another OAuth client than the one in `clientId`. Press **Connect** for that account. The app does not retry a dead sign-in. It sends the message once; when Telegram could not take it, the next poll tries again.
- The message says **Testing mode**: the consent screen is not In production. Publish it (step 1.3) and connect again.
- **"Google refused the OAuth client"** (one message for all accounts): `clientId` or the secret is wrong, or the client was deleted. Fix `clientId`, restart, and upload the client file again. The accounts work again without a new sign-in.
- **"has failed 12 times in a row"**: Google or the network failed for about three hours. The app keeps polling and sends this once for each run of failures (again at the next poll when the send failed).
- To remove the access: https://myaccount.google.com/permissions, then delete the `google.<alias>` and `google.client` entries of the service `ok-computer` from the system credential store. On Windows:

  ```
  cmdkey /delete:google.<alias>.ok-computer
  cmdkey /delete:google.client.ok-computer
  ```

  On macOS:

  ```
  security delete-generic-password -s ok-computer -a google.<alias>
  security delete-generic-password -s ok-computer -a google.client
  ```

## 6. Manual checks against real Google

The tests use a fake Google server. Check these with your real accounts once, after the first sign-in:

1. **Calendar sync.** After the first poll, the account has a calendar sync token (the Google page shows no error). Change an event that someone else organized, and check that the next poll makes a signal. This checks that Google accepts a sync token after a first read with `timeMin`.
2. **Sign-in lifetime.** 8 days after a sign-in, the account still polls. This checks that the consent screen is In production.
3. **History gap.** Leave the app off for more than a week, then start it. The run of the first poll says that the mail history was too old and that only the mail of the last 2 days made signals.
4. **Unsubscribe.** Ask the agent to unsubscribe from a real newsletter. Check the card (sender and link), approve it, and check the poll run or the call on the Runs page for the POST to the sender.
5. **Send** (only with `send: true`). Ask the agent to send a short mail to yourself. Approve it and check that it arrived once.
6. **Invitation.** Ask for an event with a second address of yours as a guest. Check that it asks for approval, and that the invitation arrives after you approve it.
