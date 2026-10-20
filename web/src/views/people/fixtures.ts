import type { PeoplePage, PeopleStatus, PersonProfile, PersonSummary } from '../../../../src/dashboard/people-types.js';

// the answers of the people api for the web tests and for the stubs of the screenshots. they match the rows of
// test/seed-people.ts at its clock (2026-10-18 16:00 utc), so a page test and a route test can share one story.

export const maya: PersonSummary = {
  id: 1,
  name: 'Maya Lindqvist',
  displayName: 'Maya Lindqvist',
  primaryEmail: 'maya@northwind.example',
  emails: ['maya@northwind.example', 'maya.lindqvist@gmail.com'],
  organization: 'Northwind',
  organizationDomain: 'northwind.example',
  mailCount: 3,
  meetingCount: 1,
  firstContactAt: '2026-09-02T16:00:00.000Z',
  lastContactAt: '2026-10-17T17:00:00.000Z',
  nextMeetingAt: '2026-10-21T17:00:00.000Z',
};

export const tomas: PersonSummary = {
  id: 2,
  name: 'Tomas Okafor',
  displayName: 'Tomas Okafor',
  primaryEmail: 'tomas.okafor@gmail.com',
  emails: ['tomas.okafor@gmail.com'],
  organization: null,
  organizationDomain: null,
  mailCount: 2,
  meetingCount: 0,
  firstContactAt: '2026-10-10T16:00:00.000Z',
  lastContactAt: '2026-10-16T16:00:00.000Z',
  nextMeetingAt: null,
};

export const priya: PersonSummary = {
  id: 3,
  name: 'Priya',
  displayName: 'Priya',
  primaryEmail: 'praman@berkeley.edu',
  emails: ['praman@berkeley.edu'],
  organization: 'Berkeley',
  organizationDomain: 'berkeley.edu',
  mailCount: 1,
  meetingCount: 1,
  firstContactAt: '2026-10-01T16:00:00.000Z',
  lastContactAt: '2026-10-14T20:00:00.000Z',
  nextMeetingAt: '2026-10-22T20:00:00.000Z',
};

export const noName: PersonSummary = {
  id: 4,
  name: null,
  displayName: 'k.osei@fabrikam.example',
  primaryEmail: 'k.osei@fabrikam.example',
  emails: ['k.osei@fabrikam.example'],
  organization: 'Fabrikam',
  organizationDomain: 'fabrikam.example',
  mailCount: 2,
  meetingCount: 0,
  firstContactAt: '2026-10-12T16:00:00.000Z',
  lastContactAt: '2026-10-12T18:00:00.000Z',
  nextMeetingAt: null,
};

export const jonas: PersonSummary = {
  id: 5,
  name: 'Jonas Weber',
  displayName: 'Jonas Weber',
  primaryEmail: 'jonas.weber@outlook.com',
  emails: ['jonas.weber@outlook.com'],
  organization: null,
  organizationDomain: null,
  mailCount: 0,
  meetingCount: 0,
  firstContactAt: null,
  lastContactAt: null,
  nextMeetingAt: '2026-10-25T15:00:00.000Z',
};

// the default sort is recent: the last contact first, and a person with no past contact last.
export const peoplePage: PeoplePage = { people: [maya, tomas, priya, noName, jonas], next: null, total: 5 };
export const emptyPage: PeoplePage = { people: [], next: null, total: 0 };

export const mayaProfile: PersonProfile = {
  ...maya,
  names: [
    { name: 'Maya Lindqvist', count: 4, lastSeenAt: '2026-10-17T16:00:00.000Z' },
    { name: 'Maya L.', count: 1, lastSeenAt: '2026-09-20T16:00:00.000Z' },
  ],
  emailDetails: [
    { email: 'maya@northwind.example', isPrimary: true, firstSeenAt: '2026-09-02T16:00:00.000Z', lastSeenAt: '2026-10-17T16:00:00.000Z' },
    { email: 'maya.lindqvist@gmail.com', isPrimary: false, firstSeenAt: '2026-09-20T16:00:00.000Z', lastSeenAt: '2026-09-20T16:00:00.000Z' },
  ],
  upcoming: [{ account: 'personal', eventId: 'e-202', title: 'Design review', startAt: '2026-10-21T17:00:00.000Z', endAt: '2026-10-21T18:00:00.000Z', role: 'attendee' }],
  recentMeetings: [{ account: 'personal', eventId: 'e-201', title: 'Roadmap sync', startAt: '2026-10-17T17:00:00.000Z', endAt: '2026-10-17T17:30:00.000Z', role: 'organizer' }],
  openThreads: [],
  notes: [{ id: 2, kind: 'note', text: 'met at the design offsite', author: 'owner', runId: null, tainted: false, createdAt: '2026-10-05T16:00:00.000Z' }],
  preferences: [{ id: 3, kind: 'preference', text: 'prefers meetings before 11:00', author: 'agent', runId: 'run-people-2', tainted: false, createdAt: '2026-10-10T16:00:00.000Z' }],
  delegations: [],
};

export const tomasProfile: PersonProfile = {
  ...tomas,
  names: [{ name: 'Tomas Okafor', count: 2, lastSeenAt: '2026-10-16T16:00:00.000Z' }],
  emailDetails: [{ email: 'tomas.okafor@gmail.com', isPrimary: true, firstSeenAt: '2026-10-10T16:00:00.000Z', lastSeenAt: '2026-10-16T16:00:00.000Z' }],
  upcoming: [],
  recentMeetings: [],
  openThreads: [{ account: 'personal', threadId: 't-3', subject: 'Re: Lease for the new place', lastAt: '2026-10-16T16:00:00.000Z', messages: 2 }],
  notes: [{ id: 4, kind: 'note', text: 'waiting on the signed lease from Tomas', author: 'agent', runId: 'run-people-3', tainted: true, createdAt: '2026-10-16T16:00:00.000Z' }],
  preferences: [],
  delegations: [],
};

export const statusDone: PeopleStatus = {
  configured: true,
  people: 5,
  accounts: [
    { account: 'personal', backfill: 'done', backfillMessages: 420, backfillEvents: 85, backfilledAt: '2026-10-15T16:00:00.000Z', error: null },
    { account: 'school', backfill: 'running', backfillMessages: 250, backfillEvents: 0, backfilledAt: null, error: null },
  ],
};

// the first run: google is set up, and the backfill has not read anything yet.
export const statusFirstRun: PeopleStatus = {
  configured: true,
  people: 0,
  accounts: [
    { account: 'personal', backfill: 'pending', backfillMessages: 0, backfillEvents: 0, backfilledAt: null, error: null },
    { account: 'school', backfill: 'pending', backfillMessages: 0, backfillEvents: 0, backfilledAt: null, error: null },
  ],
};

export const statusNoGoogle: PeopleStatus = { configured: false, people: 0, accounts: [] };
