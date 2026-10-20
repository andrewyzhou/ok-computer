import { describe, expect, it } from 'vitest';
import { addressNoise, mailNoise, type MailNoiseHeaders } from './noise.js';
import type { NoiseReason } from './types.js';

describe('addressNoise', () => {
  const cases: Array<[string, string | null, NoiseReason | null, { resource?: boolean }?]> = [
    ['jane@acme.com', 'Jane Doe', null],
    ['jane@acme.com', null, null],
    ['not-an-address', null, 'invalid'],
    ['jane@', 'Jane', 'invalid'],
    // calendar resources and groups.
    ['room-4@resource.calendar.google.com', 'Room 4', 'calendar_resource'],
    ['abc123@group.calendar.google.com', 'Team', 'calendar_resource'],
    ['abc123@group.v.calendar.google.com', null, 'calendar_resource'],
    ['jane@acme.com', 'Jane', 'calendar_resource', { resource: true }],
    ['jane@acme.com', 'Jane', null, { resource: false }],
    // no-reply senders.
    ['noreply@acme.com', null, 'no_reply'],
    ['NoReply@acme.com', null, 'no_reply'],
    ['no-reply@acme.com', null, 'no_reply'],
    ['no_reply@acme.com', null, 'no_reply'],
    ['donotreply@acme.com', null, 'no_reply'],
    ['do-not-reply@acme.com', null, 'no_reply'],
    ['noreply+tag@acme.com', null, 'no_reply'],
    ['drive-shares-dm-noreply@google.com', null, 'no_reply'],
    ['billing.noreply@acme.com', null, 'no_reply'],
    ['mailer-daemon@acme.com', null, 'no_reply'],
    ['postmaster@acme.com', null, 'no_reply'],
    ['bounce@acme.com', null, 'no_reply'],
    ['bounces+123@acme.com', null, 'no_reply'],
    ['bounces-123@acme.com', null, 'no_reply'],
    ['msg+a1b2c3d4e5f6g7h8i9@acme.com', null, 'no_reply'],
    ['noreplyuclc@school.example', null, 'no_reply'],
    ['donotreplyteam@acme.com', null, 'no_reply'],
    ['norene@acme.com', null, null],
    ['bouncer@acme.com', null, null],
    ['jane+work@acme.com', null, null],
    // notifications.
    ['notifications@github.com', null, 'notification'],
    ['notification@acme.com', null, 'notification'],
    ['github-notifications@acme.com', null, 'notification'],
    ['alerts@acme.com', null, 'notification'],
    ['updates@acme.com', null, 'notification'],
    ['news@acme.com', null, 'notification'],
    ['newsletter@acme.com', null, 'notification'],
    ['digest@acme.com', null, 'notification'],
    ['calendar-notification@google.com', null, 'notification'],
    ['reply@reply.github.com', null, 'notification'],
    ['jane@acme.com', 'Jane (via Google Docs)', 'notification'],
    ['comments@acme.com', 'Jane Doe via Slack', 'notification'],
    ['jane@acme.com', 'Jane Doe', null],
    ['jane@acme.com', 'Jane via the stairs', null],
    ['newsom@acme.com', null, null],
    ['notionist@acme.com', null, null],
    // role addresses.
    ['info@acme.com', null, 'role_address'],
    ['Support@acme.com', null, 'role_address'],
    ['billing@acme.com', null, 'role_address'],
    ['team@acme.com', null, 'role_address'],
    ['hello@acme.com', null, 'role_address'],
    ['sales@acme.com', null, 'role_address'],
    ['admin@acme.com', null, 'role_address'],
    ['help@acme.com', null, 'role_address'],
    ['receipts@acme.com', null, 'role_address'],
    ['orders@acme.com', null, 'role_address'],
    ['security@acme.com', null, 'role_address'],
    ['informatics@acme.com', null, null],
    ['teamlead@acme.com', null, null],
    ['helena@acme.com', null, null],
    // automated senders of the real-data check, with the names changed.
    ['contact@scheduler.example', null, 'role_address'],
    ['notify@updates.notes.example', null, 'notification'],
    ['notify@notes.example', null, 'notification'],
    ['noti@acme.com', null, 'notification'],
    ['campus@warnme.school.example', null, 'notification'],
    ['jane@em123.acme.com', null, 'notification'],
    ['news.desk@news.paper.example', null, 'notification'],
    ['account@wifi.example', null, 'role_address'],
    ['accounts@acme.com', null, 'role_address'],
    ['scheduling@acme.com', null, 'role_address'],
    ['volunteer@org.example', null, 'role_address'],
    ['careers@acme.com', null, 'role_address'],
    ['jobs@acme.com', null, 'role_address'],
    ['events@acme.com', null, 'role_address'],
    ['university.recruiting@acme.com', null, 'role_address'],
    ['universityrecruiting2026@acme.com', null, 'role_address'],
    ['jane@emory.example', null, null],
    ['jane@newsroom.example', null, null],
    ['contactless@acme.com', null, null],
    // mailing lists that a calendar event lists as attendees.
    ['cs101-staff@lists.school.example', null, 'mailing_list'],
    ['eng@list.acme.com', null, 'mailing_list'],
    ['cs101@lists.cs.school.example', null, 'mailing_list'],
    ['dept@listserv.school.example', null, 'mailing_list'],
    ['eng@groups.acme.com', null, 'mailing_list'],
    ['club@googlegroups.com', null, 'mailing_list'],
    ['cs101-fa26@school.example', 'cs101-fa26', 'mailing_list'],
    ['cs101-staff2@school.example', 'CS101-Staff2', 'mailing_list'],
    ['cs101-fa26@school.example', null, null],
    ['jane@lists.example', null, null],
    ['jane@listening.acme.com', null, null],
    ['jane@mygroups.example', null, null],
    ['jane.doe@acme.com', 'jane.doe', null],
    ['jdoe2@acme.com', 'jdoe2', null],
  ];
  for (const [email, name, reason, options] of cases) {
    it(`gives ${String(reason)} for ${email}${name ? ` named ${name}` : ''}${options ? ` with ${JSON.stringify(options)}` : ''}`, () => {
      expect(addressNoise({ email, name }, options)).toBe(reason);
    });
  }

  it('reads the comment of a header part as part of the name for the via rule', () => {
    expect(addressNoise({ email: 'jane@x.com', name: 'Jane' }, { comment: 'via Slack' })).toBe('notification');
    expect(addressNoise({ email: 'jane@x.com', name: 'Jane' }, { comment: 'work' })).toBeNull();
    expect(addressNoise({ email: 'jane@x.com', name: 'Jane' }, { comment: null })).toBeNull();
  });

  it('checks the reasons in order: a resource no-reply address is a resource', () => {
    expect(addressNoise({ email: 'noreply@acme.com', name: null }, { resource: true })).toBe('calendar_resource');
    expect(addressNoise({ email: 'noreply-info@acme.com', name: 'Jane (via Slack)' })).toBe('no_reply');
    expect(addressNoise({ email: 'info@acme.com', name: 'Jane (via Slack)' })).toBe('notification');
  });
});

describe('mailNoise', () => {
  const none: MailNoiseHeaders = { listId: '', listUnsubscribe: '', precedence: '', autoSubmitted: '', labels: ['INBOX', 'CATEGORY_PERSONAL'] };
  const cases: Array<[Partial<MailNoiseHeaders>, NoiseReason | null]> = [
    [{}, null],
    [{ listId: '<eng.lists.acme.com>' }, 'mailing_list'],
    [{ listId: '<eng.lists.acme.com>', listUnsubscribe: '<mailto:x@acme.com>' }, 'mailing_list'],
    [{ listUnsubscribe: '<https://acme.com/u>' }, 'bulk'],
    [{ labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, 'bulk'],
    [{ labels: ['CATEGORY_UPDATES'] }, 'bulk'],
    [{ labels: ['CATEGORY_SOCIAL'] }, 'bulk'],
    [{ labels: ['CATEGORY_FORUMS'] }, 'bulk'],
    [{ labels: ['CATEGORY_PERSONAL', 'IMPORTANT'] }, null],
    [{ precedence: 'bulk' }, 'bulk'],
    [{ precedence: ' List ' }, 'bulk'],
    [{ precedence: 'junk' }, 'bulk'],
    [{ precedence: 'first-class' }, null],
    [{ autoSubmitted: 'no' }, null],
    [{ autoSubmitted: 'No' }, null],
    [{ autoSubmitted: 'auto-generated' }, 'auto_submitted'],
    [{ autoSubmitted: 'auto-replied' }, 'auto_submitted'],
    [{ sender: 'Google Calendar <calendar-notification@google.com>' }, 'calendar_mail'],
    [{ sender: 'calendar-notification@google.com', listId: '<x.acme.com>' }, 'calendar_mail'],
    [{ messageId: '<calendar-6f1c2e@google.com>' }, 'calendar_mail'],
    [{ messageId: ' <Calendar-6F1C2E@Google.com> ' }, 'calendar_mail'],
    [{ sender: 'Jane Doe <jane@acme.com>' }, null],
    [{ messageId: '<calendar-6f1c2e@acme.com>' }, null],
  ];
  for (const [change, reason] of cases) {
    it(`gives ${String(reason)} for ${JSON.stringify(change)}`, () => expect(mailNoise({ ...none, ...change })).toBe(reason));
  }
});
