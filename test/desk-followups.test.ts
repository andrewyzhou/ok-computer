import { afterEach, describe, expect, it } from 'vitest';
import { deskAutomation } from '../src/desk/index.js';
import { createDelegation, getDelegation, listDelegationEvents } from '../src/desk/store.js';
import { SCOPES } from '../src/google/config.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { toolStep, type FakeStep } from '../src/models/fake.js';
import { sessionTaint } from '../src/policy/store.js';
import { createTestApp } from './app-harness.js';
import { decoded, threadMessage } from './desk-harness.js';
import { startFakeGoogle, type FakeGoogle } from './fake-google.js';
import { CLIENT_ID, CLIENT_SECRET, refreshOf } from './google-harness.js';

// the follow-up job end to end: the whole app with the fake google and a scripted model, and the system automation
// "desk: follow-ups" run through the scheduler, as the app runs it every 15 minutes.

const START = '2026-10-13T16:00:00.000Z';
const H = 3_600_000;
const D = 24 * H;
const NUDGE = 'Hi Dana,\n\nI wanted to check on the lease renewal. Could you let me know where it stands?\n\nThank you.';

let fake: FakeGoogle | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  await fake?.close();
  stop = undefined;
  fake = undefined;
});

// the model steps of one nudge: the text of the nudge, then the verdict of the reviewer on the tool call.
const nudgeSteps = (body = NUDGE): FakeStep[] => [
  toolStep({ id: 'n1', name: 'write_nudge', input: { items: [{ id: 1, body }] } }),
  toolStep({ id: 'r1', name: 'review_verdict', input: { verdict: 'allow', reason: 'a nudge in the thread of the delegation is the task of the run' } }),
];

async function setup(steps: FakeStep[]) {
  fake = await startFakeGoogle();
  fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead];
  fake.addAccount('personal', 'personal@example.com', refreshOf('personal'));
  const now = { value: new Date(START) };
  const t = createTestApp(steps, {
    start: START,
    config: { slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, utility: { chain: ['fake/m'] } }, heartbeat: { every: '0' }, google: { clientId: CLIENT_ID, accounts: [{ alias: 'personal', email: 'personal@example.com' }] } },
    deps: {
      clock: () => now.value,
      background: false,
      secrets: createMemorySecretStore({ 'google.client': CLIENT_SECRET, 'google.personal': refreshOf('personal') }),
      googleEndpoints: { apiRoot: fake.url, tokenUrl: `${fake.url}token`, revokeUrl: `${fake.url}revoke`, authUrl: `${fake.url}auth` },
    },
  });
  t.db.prepare("UPDATE google_accounts SET status = 'ok', email = 'personal@example.com', authorizedAt = '2026-10-01T00:00:00Z', historyId = '1' WHERE alias = 'personal'").run();
  await t.app.start();
  stop = () => t.app.stop();
  const automation = deskAutomation(t.db, 'followups');
  if (!automation) throw new Error('the desk automation is not installed');
  const iso = (ms: number) => new Date(now.value.getTime() + ms).toISOString();
  // the delegation waits on Dana since four days ago, and the owner asked in the thread then.
  const made = createDelegation(
    t.db,
    {
      title: 'Get the lease renewal from Dana',
      waitingOn: { name: 'Dana Park', email: 'dana@landlord.example' },
      nextFollowUpAt: iso(-H),
      links: [{ kind: 'thread', ref: 't-lease', account: 'personal' }],
      createdBy: 'agent',
    },
    { actor: 'agent', runId: 'run-seed' },
    new Date(now.value.getTime() - 4 * D),
  );
  if (!made.ok) throw new Error(made.error);
  const id = made.value.id;
  fake.deliver(
    'personal',
    threadMessage({ id: 'm1', threadId: 't-lease', from: 'Andrew <personal@example.com>', to: 'dana@landlord.example', at: iso(-4 * D + 60_000), labelIds: ['SENT'], body: 'Could you send the lease renewal?' }),
  );
  return {
    t,
    id,
    now,
    iso,
    runNow: () => t.app.scheduler.runNow(automation.id),
    get: () => getDelegation(t.db, id)!,
    history: () => listDelegationEvents(t.db, id),
    drafts: () => [...fake!.mailbox('personal').drafts.values()].map((draft) => decoded(draft.message.body!)),
  };
}

describe('the desk follow-ups through the scheduler', () => {
  it('saves a nudge as a draft in a tainted run, sends no mail, and tells the owner once', async () => {
    const s = await setup(nudgeSteps());
    const result = await s.runNow();
    expect(result).toMatchObject({ status: 'completed' });
    const runId = result!.runId!;

    // the draft is in the mailbox, and nothing left it.
    const drafts = s.drafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.headers).toContain('To: dana@landlord.example');
    expect(drafts[0]!.headers).toContain('Subject: Re: Lease renewal');
    expect(drafts[0]!.body).toBe(NUDGE);
    expect(fake!.sent).toEqual([]);
    expect(fake!.requests.filter((each) => /\/send\b/.test(each.path))).toEqual([]);

    // the run and its session: the task first, then the taint of the mail, and the reviewer's model call.
    const [run] = s.t.rows('SELECT sessionKey, status FROM runs WHERE id = ?', runId);
    expect(run).toEqual({ sessionKey: `desk:followups:${runId}`, status: 'completed' });
    expect(sessionTaint(s.t.db, `desk:followups:${runId}`).map((each) => each.source)).toEqual(['gmail:personal']);
    const [call] = s.t.rows("SELECT name, isError FROM tool_calls WHERE runId = ? AND name = 'desk_draft_nudge'", runId);
    expect(call).toEqual({ name: 'desk_draft_nudge', isError: 0 });
    expect(s.t.rows('SELECT decision, reviewerVerdict, approvalId FROM policy_decisions WHERE runId = ?', runId)).toEqual([{ decision: 'review', reviewerVerdict: 'allow', approvalId: null }]);

    // the history and the delegation.
    expect(s.history().map((each) => each.kind)).toEqual(['created', 'link_added', 'nudge_drafted']);
    expect(s.get()).toMatchObject({ status: 'waiting', nudgeCount: 1, nextFollowUpAt: s.iso(3 * D) });
    expect(s.t.rows('SELECT toAddress, runId FROM delegation_nudges')).toEqual([{ toAddress: 'dana@landlord.example', runId }]);

    // one owner message with the desk link.
    const printed = s.t.printed();
    expect(printed.match(/Desk follow-ups:/g)).toHaveLength(1);
    expect(printed).toContain(`#${s.id} "Get the lease renewal from Dana": no reply from Dana Park yet`);
    expect(printed).toContain(`/#/desk?id=${s.id}`);

    // a second run at the same time drafts nothing and writes no run.
    const runs = s.t.rows('SELECT id FROM runs').length;
    expect(await s.runNow()).toMatchObject({ status: 'skipped' });
    expect(s.drafts()).toHaveLength(1);
    expect(s.t.rows('SELECT id FROM runs')).toHaveLength(runs);
    expect(s.t.model.calls).toHaveLength(2);
  }, 60_000);

  it('opens the delegation with reply_seen when a reply came', async () => {
    const s = await setup([]);
    fake!.deliver('personal', threadMessage({ id: 'm2', threadId: 't-lease', from: 'Dana Park <dana@landlord.example>', at: s.iso(-D), body: 'Here is the renewal.' }));
    expect(await s.runNow()).toMatchObject({ status: 'completed' });
    expect(s.get()).toMatchObject({ status: 'open', nextStep: 'Read the reply from Dana Park <dana@landlord.example>', nextFollowUpAt: null });
    expect(s.history().find((each) => each.kind === 'reply_seen')).toMatchObject({ data: { messageId: 'm2', threadId: 't-lease', account: 'personal' } });
    expect(s.drafts()).toEqual([]);
    expect(s.t.printed()).toContain('Dana Park <dana@landlord.example> replied.');
    expect(s.t.model.calls).toEqual([]);
  }, 60_000);

  it('blocks the delegation after three nudges without a reply', async () => {
    const s = await setup([...nudgeSteps('First nudge.'), ...nudgeSteps('Second nudge.'), ...nudgeSteps('Third nudge.')]);
    for (let nudge = 1; nudge <= 3; nudge++) {
      expect(await s.runNow()).toMatchObject({ status: 'completed' });
      expect(s.get()).toMatchObject({ status: 'waiting', nudgeCount: nudge, nextFollowUpAt: s.iso(3 * D) });
      s.now.value = new Date(Date.parse(s.get().nextFollowUpAt!) + 60_000);
    }
    expect(s.drafts().map((draft) => draft.body)).toEqual(['First nudge.', 'Second nudge.', 'Third nudge.']);
    expect(await s.runNow()).toMatchObject({ status: 'completed' });
    expect(s.get()).toMatchObject({ status: 'blocked', nudgeCount: 3, nextFollowUpAt: null, nextStep: 'No reply from Dana Park after 3 nudges. Decide what to do next.' });
    expect(s.drafts()).toHaveLength(3);
    expect(fake!.sent).toEqual([]);
    expect(s.history().filter((each) => each.kind === 'nudge_drafted')).toHaveLength(3);
    expect(s.t.printed()).toContain('after 3 nudges, so it is blocked');
    // nothing is due any more.
    expect(await s.runNow()).toMatchObject({ status: 'skipped' });
  }, 60_000);
});
