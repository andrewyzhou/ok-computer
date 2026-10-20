import { afterEach, describe, expect, it } from 'vitest';
import type { FakeMessage } from '../../test/fake-google.js';
import { createInboxHarness, listMail, type InboxHarness } from '../../test/inbox-harness.js';
import type { InboxJob } from '../dashboard/types.js';
import { fakeResponse, toolStep } from '../models/fake.js';

// the inbox jobs on the five accounts of the owner. each job reads every account, an account that needs a sign-in is
// skipped with a note while the others still run, and a job fails only when no account could be read.

const ALIASES = ['personal', 'work', 'side', 'school', 'club'];
const LIST = 'GET /gmail/v1/users/me/messages';

let h: InboxHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

// a person mail for the digest, one in each account.
function personMail(alias: string): FakeMessage {
  const date = '2026-10-13T06:00:00Z';
  return {
    id: `m-${alias}`,
    threadId: `t-${alias}`,
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: String(Date.parse(date)),
    snippet: `A question for ${alias}`,
    body: 'Can you send me the notes? Thanks.',
    headers: { From: `Friend <friend.${alias}@example.com>`, To: `${alias}@example.com`, Subject: `A question for ${alias}`, Date: new Date(date).toUTCString() },
  };
}

async function setup(): Promise<InboxHarness> {
  const harness = await createInboxHarness({ accounts: ALIASES });
  // the fake does not parse gmail search syntax, so every search gives all the mail of the account.
  harness.google.fake.search = (_alias, _q, messages) => messages;
  for (const alias of ALIASES) {
    harness.google.fake.deliver(alias, personMail(alias));
    harness.google.fake.deliver(alias, listMail(`n-${alias}`, { from: `News <news@${alias}.example>` }));
  }
  // each model call of the digest and the scan sorts nothing, so no draft, proposal or receipt follows.
  for (let i = 0; i < 40; i++) {
    harness.script.push(async (call) => {
      const tool = call.tools?.[0]?.name ?? 'digest_items';
      return fakeResponse(toolStep({ id: `c${i}`, name: tool, input: { items: [] } }));
    });
  }
  return harness;
}

// the account of a request, from the access token that the fake gave it.
const aliasOf = (authorization: string | undefined) => /fake-access-(.+)-\d+-x+$/.exec(authorization ?? '')?.[1];

// the accounts whose message list the job asked for, in order and once each.
function listed(harness: InboxHarness, from: number): string[] {
  const seen: string[] = [];
  for (const request of harness.google.fake.requests.slice(from)) {
    if (!`${request.method} ${request.path}`.startsWith(LIST) || request.path.includes('/messages/')) continue;
    const alias = aliasOf(request.authorization);
    if (alias && !seen.includes(alias)) seen.push(alias);
  }
  return seen;
}

const JOBS: InboxJob[] = ['digest', 'newsletters', 'subscriptions'];

describe('the inbox jobs on five accounts', () => {
  for (const job of JOBS) {
    it(`the ${job} job reads every account`, async () => {
      h = await setup();
      const from = h.google.fake.requests.length;
      const result = await h.run(job);
      expect(result.status).toBe('completed');
      expect(listed(h, from)).toEqual(ALIASES);
      // each account also gave its messages, not only the list.
      for (const alias of ALIASES) {
        expect(h.google.fake.requests.slice(from).some((each) => each.path.includes('/messages/') && aliasOf(each.authorization) === alias)).toBe(true);
      }
      // the run is tainted with the mail of every account it read.
      const taint = h.rows("SELECT payload FROM events WHERE runId = ? AND type = 'system_event'", result.runId!).flatMap(
        (row) => (JSON.parse(String(row.payload)) as { taint?: Array<{ source: string }> }).taint ?? [],
      );
      expect(taint.map((each) => each.source)).toEqual(ALIASES.map((alias) => `gmail:${alias}`));
    });

    it(`the ${job} job skips an account that needs a sign-in, with a note, and reads the others`, async () => {
      h = await setup();
      h.google.db.prepare("UPDATE google_accounts SET status = 'needs_auth' WHERE alias = 'work'").run();
      const from = h.google.fake.requests.length;
      const result = await h.run(job);
      expect(result.status).toBe('completed');
      expect(result.error).toContain('work');
      expect(result.error).toMatch(/sign in/);
      expect(listed(h, from)).toEqual(ALIASES.filter((alias) => alias !== 'work'));
      expect(h.google.fake.requests.slice(from).some((each) => aliasOf(each.authorization) === 'work')).toBe(false);
    });

    it(`the ${job} job completes when only one account could be read, and fails when none could`, async () => {
      h = await setup();
      // the accounts are read one after the other, so the first four lists fail and the last one is read.
      h.google.fake.fault({ route: LIST, status: 400, times: 4 });
      const partly = await h.run(job);
      expect(partly.status).toBe('completed');
      for (const alias of ['personal', 'work', 'side', 'school']) expect(partly.error).toContain(alias);
      expect(partly.error).not.toMatch(/club/);

      h.google.fake.clearFaults();
      h.google.fake.fault({ route: LIST, status: 400 });
      const none = await h.run(job);
      expect(none.status).toBe('failed');
      for (const alias of ALIASES) expect(none.error).toContain(alias);
    });
  }

  it('the digest names every account that it read, and stores no digest when it could read none', async () => {
    h = await setup();
    await h.run('digest');
    expect(JSON.parse(String(h.rows('SELECT accounts FROM inbox_digests ORDER BY id DESC LIMIT 1')[0]!.accounts))).toEqual(ALIASES);
    h.google.fake.fault({ route: LIST, status: 400 });
    expect((await h.run('digest')).status).toBe('failed');
    expect(h.rows('SELECT COUNT(*) AS n FROM inbox_digests')).toEqual([{ n: 1 }]);
  });
});
