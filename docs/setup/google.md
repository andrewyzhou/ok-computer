# Connect Gmail and Google Calendar

Optional. Without a `google` block in `okc.config.json` the app has no Google tools and does not poll. Takes about 10 minutes the first time, then about 1 minute for each account.

## 1. Create the Google Cloud project (one time)

1. Open https://console.cloud.google.com and create a project, for example `ok-computer`.
2. **APIs & Services → Library**: turn on the **Gmail API** and the **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**. App name `OK Computer`. Your own address as the support and developer contact.
   - **Audience → Publish app**, so the status is **In production**. Do not submit it for verification. In **Testing** mode Google ends each sign-in after 7 days.
   - You do not need to add scopes here; the app asks for them at sign-in.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Desktop app**. Download the JSON file. A **Web application** client does not work.

## 2. Configure the accounts

Add this to `okc.config.json` (create the file next to `README.md` if it is missing):

```json
{
  "google": {
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

- `alias`: at most 16 lower-case letters, digits and dashes. The agent names an account by its alias.
- `email` (optional, recommended): a sign-in with another Google account is refused, so an alias can never read the wrong mailbox.
- `send` (default `false`): when `true`, the sign-in also asks for `gmail.send`, and the agent gets `gmail_send`. Each send needs your approval. Changing it later needs a new sign-in of each account.
- `sessions`: `main`, and `auto` if your automations may use Gmail and Calendar.
- `pollMinutes` (default 15, at least 5).

Run `okc restart`. An invalid block stops the app at start with a message that names the field.

## 3. Store the client and connect each account

Open the dashboard on this PC (`okc open`). Until the page has buttons for these steps, use a terminal on the PC:

```powershell
# store the downloaded client file (the file stays in the Windows Credential Manager, never in the database)
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4317/api/google/client -ContentType application/json -InFile "$HOME\Downloads\client_secret_XXXX.json"

# start the sign-in of one account, then open the link in the browser of this PC
(Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4317/api/google/personal/connect -ContentType application/json -Body '{}').url
```

Add `-Headers @{ Authorization = "Bearer $env:DASHBOARD_TOKEN" }` when `DASHBOARD_TOKEN` is set.

On the Google page:

1. Pick the account that matches the alias. If you are signed in to several accounts in the browser, check the address.
2. Google says the app is not verified: **Advanced → Go to OK Computer (unsafe)**. This is your own app.
3. **Tick every box.** A sign-in without one of the permissions is refused, and the app says which one is missing.

The browser then shows "Signed in as …". The link works once and for 10 minutes. Repeat for each alias. `GET /api/google` shows each account and its last poll.

## What happens next

- Every `pollMinutes`, the app reads new inbox mail and calendar changes of each signed-in account. The first poll after a sign-in starts from the moment of the sign-in; older mail is not news.
- New items become signals. A cheap model labels them (`needs_reply`, `deadline`, `event_change`, `newsletter`, `noise`), and code checks for a date in a mail that is not on your calendar and for an event that starts within two hours. The heartbeat reads at most 20 new signals and tells you only what needs attention. You need a heartbeat interval (`heartbeat.every`) for this; a checklist is not needed.
- **Approvals:** sending mail, unsubscribing, and changing or deleting a calendar event always ask you. Archiving, labels, drafts and new events on your own calendar ask you too until the reviewer model exists, unless an `okc.policy.json` rule allows them.
- **Unsubscribe** works only through the sender's own `List-Unsubscribe` header: a one-click link (only when Gmail saw a valid DKIM signature) or a mail (only with `send: true`). The approval card shows the exact link or address.

## When something goes wrong

- **"Google stopped accepting the sign-in of the X account"** (one Telegram message): the token was revoked, the password changed, the account was unused for 6 months, or more than 100 sign-ins exist for the client. Connect that account again. The app does not retry a dead token and does not send the message again.
- The message says **Testing mode**: the consent screen is not In production. Publish it (step 1.3) and connect again.
- **"has failed 12 times in a row"**: Google or the network has failed for about three hours. The app keeps polling and sends this once per failure streak.
- The tokens never appear in the logs, the database or the blob store. To remove the app's access, use https://myaccount.google.com/permissions, then delete the `google.<alias>.ok-computer` entries in the Credential Manager.
