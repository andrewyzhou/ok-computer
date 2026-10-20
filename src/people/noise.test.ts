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
    ['noreplyjane@acme.com', null, null],
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
  ];
  for (const [email, name, reason, options] of cases) {
    it(`gives ${String(reason)} for ${email}${name ? ` named ${name}` : ''}${options ? ` with ${JSON.stringify(options)}` : ''}`, () => {
      expect(addressNoise({ email, name }, options)).toBe(reason);
    });
  }

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
  ];
  for (const [change, reason] of cases) {
    it(`gives ${String(reason)} for ${JSON.stringify(change)}`, () => expect(mailNoise({ ...none, ...change })).toBe(reason));
  }
});
