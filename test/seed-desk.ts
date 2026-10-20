import type { Db } from '../src/db/index.js';
import { appendDelegationEvent, createDelegation, markChecked, updateDelegation, type ChangeBy, type NewDelegation } from '../src/desk/store.js';

// the desk on a seeded database. the rows go through the real store, so they have the shape that the tools and the
// routes write, and each history row has its own time. the dashboard seed (test/seed.ts) calls it, so the desk view,
// the screenshots and the route tests share one stable set: a test may depend on each id, count and value below.
//
// the times count from now, the clock of the seed. h is an hour and d a day.
//
// id status   title                                   waiting on                         due      follow-up  links
//  1 open     Book the Denver flights                 -                                  +3d      -          run run-1
//  2 waiting  Get the lease renewal from Dana         Dana Park <dana@landlord.example>  +5d      +1d        thread personal t-lease
//  3 waiting  Reschedule the dentist                  front@dentist.example              -1d      -1h        thread school t-dentist
//  4 blocked  Renew the passport                      -                                  +20d     -          doc doc-1
//  5 done     Send the thank-you note to Prof. Lee    -                                  -        -          -
//  6 dropped  Find a cheaper phone plan               -                                  -        -          -
//  7 open     (a long title, no due time)             -                                  -        -          event school ev-1
//  8 waiting  Ask Dana about the parking spot         Dana (name only)                   -        +2d        -
//
// 3 is overdue and its follow-up is due, so listDue(now) gives 3 only. listDue(now + 3d) gives 3, 1, 2 and 8 in that
// order: by dueAt, and 8 last because it has no due time (2 and 8 come in by their follow-up times). listWaiting gives
// 2, 3, 8. delegation 2 has one nudge draft (nudge 1, gmail draft d-nudge-1, follow-up -1d), nudgeCount 1, its next
// follow-up at +1d, and the history created, link_added, follow_up_checked, nudge_drafted, note. delegation 4 has the
// history created, link_added, updated (nextStep), status (open -> blocked). 5 closed two days ago and 6 five days ago.
// people with an active delegation: dana@landlord.example (2), front@dentist.example (3) and dana (8).

export const LONG_TITLE =
  'Collect every receipt of the October trip from mail and the photos, and put them into one expense report for the school';

const H = 3_600_000;
const D = 24 * H;

export function seedDesk(db: Db, now: Date): void {
  const at = (ms: number) => new Date(now.getTime() + ms);
  const iso = (ms: number) => at(ms).toISOString();
  const agent: ChangeBy = { actor: 'agent', runId: 'run-1' };
  const owner: ChangeBy = { actor: 'owner' };
  const system: ChangeBy = { actor: 'system' };
  const make = (input: NewDelegation, by: ChangeBy, when: number) => {
    const made = createDelegation(db, input, by, at(when));
    if (!made.ok) throw new Error(made.error);
    return made.value.id;
  };
  const change = (id: number, patch: Parameters<typeof updateDelegation>[2], by: ChangeBy, when: number) => {
    const changed = updateDelegation(db, id, patch, by, at(when));
    if (!changed.ok) throw new Error(changed.error);
  };

  make(
    {
      title: 'Book the Denver flights',
      details: 'Two seats, out on Oct 24 and back on Oct 27. Aisle seats when they cost the same.',
      nextStep: 'Compare the morning flights on Oct 24',
      dueAt: iso(3 * D),
      links: [{ kind: 'run', ref: 'run-1', label: 'The chat where you asked' }],
      createdBy: 'agent',
      sessionKey: 'main',
      runId: 'run-1',
    },
    agent,
    -2 * D,
  );

  const lease = make(
    {
      title: 'Get the lease renewal from Dana',
      nextStep: "Wait for Dana's reply with the new lease",
      waitingOn: { name: 'Dana Park', email: 'dana@landlord.example' },
      dueAt: iso(5 * D),
      nextFollowUpAt: iso(-1 * D),
      links: [{ kind: 'thread', ref: 't-lease', account: 'personal', label: 'Lease renewal' }],
      createdBy: 'agent',
      sessionKey: 'main',
      runId: 'run-1',
    },
    agent,
    -4 * D,
  );
  appendDelegationEvent(db, { delegationId: lease, kind: 'follow_up_checked', data: { threadId: 't-lease', account: 'personal' }, ...system }, at(-1 * D));
  db.prepare(
    `INSERT INTO delegation_nudges (delegationId, account, threadId, sourceMessageId, gmailDraftId, toAddress, subject, body, followUpAt, runId, createdAt)
     VALUES (?, 'personal', 't-lease', 'm-lease-2', 'd-nudge-1', 'dana@landlord.example', 'Re: Lease renewal', ?, ?, NULL, ?)`,
  ).run(lease, 'Hi Dana, I wanted to check in on the lease renewal. Could you send the new lease when it is ready? Thank you.', iso(-1 * D), iso(-1 * D));
  appendDelegationEvent(
    db,
    { delegationId: lease, kind: 'nudge_drafted', text: 'Saved a nudge to Dana in Gmail Drafts. It is not sent.', data: { nudgeId: 1, gmailDraftId: 'd-nudge-1', account: 'personal', threadId: 't-lease' }, ...system },
    at(-1 * D),
  );
  markChecked(db, lease, { nextFollowUpAt: iso(1 * D), nudged: true }, at(-1 * D));
  change(lease, { note: 'Dana said on the phone that the lease comes this week.' }, owner, -2 * H);

  make(
    {
      title: 'Reschedule the dentist',
      nextStep: 'Pick a time next week from the slots they send',
      waitingOn: { email: 'front@dentist.example' },
      dueAt: iso(-1 * D),
      nextFollowUpAt: iso(-1 * H),
      links: [{ kind: 'thread', ref: 't-dentist', account: 'school' }],
      createdBy: 'agent',
      sessionKey: 'main',
      runId: 'run-1',
    },
    agent,
    -3 * D,
  );

  const passport = make(
    { title: 'Renew the passport', details: 'The passport ends in March.', dueAt: iso(20 * D), links: [{ kind: 'doc', ref: 'doc-1', label: 'Passport checklist' }], createdBy: 'owner' },
    owner,
    -6 * D,
  );
  change(passport, { status: 'blocked', nextStep: 'Sign the form and choose a photo' }, agent, -1 * D);

  const thanks = make({ title: 'Send the thank-you note to Prof. Lee', createdBy: 'agent', sessionKey: 'main', runId: 'run-1' }, agent, -7 * D);
  change(thanks, { status: 'done', note: 'You sent it from Gmail.' }, agent, -2 * D);

  const phone = make({ title: 'Find a cheaper phone plan', createdBy: 'owner' }, owner, -10 * D);
  change(phone, { status: 'dropped', note: 'You chose to keep the plan.' }, owner, -5 * D);

  make({ title: LONG_TITLE, links: [{ kind: 'event', ref: 'ev-1', account: 'school', label: 'Trip review' }], createdBy: 'owner' }, owner, -1 * D);

  make({ title: 'Ask Dana about the parking spot', waitingOn: { name: 'Dana' }, nextFollowUpAt: iso(2 * D), createdBy: 'agent', sessionKey: 'main', runId: 'run-1' }, agent, -3 * H);
}
