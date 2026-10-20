import type {
  DocComment,
  DocDetail,
  DocDiff,
  DocListItem,
  DocsPage,
  DocSummary,
  DocVersion,
  DocVersionMeta,
} from '../../../../src/dashboard/docs-types';
import { TRIP_V2, TRIP_V3 } from '../../../../test/docs-seed';

// the fixtures of the docs tests. they have the shapes of docs-types.ts and the texts of test/docs-seed.ts, so a test
// that stubs a route and a test that reads the seeded dashboard see the same docs. the scaffold owns this file; a
// part that needs another fixture builds it from these helpers in its own test.

export function docSummary(id: number, overrides: Partial<DocSummary> = {}): DocSummary {
  return {
    id,
    title: `Doc ${id}`,
    kind: 'notes',
    author: 'agent',
    tainted: false,
    version: 1,
    chars: 120,
    comments: 0,
    sessionKey: 'main',
    createdAt: '2026-10-12T15:00:00.000Z',
    updatedAt: '2026-10-12T15:00:00.000Z',
    ...overrides,
  };
}

export function docItem(id: number, overrides: Partial<DocListItem> = {}): DocListItem {
  return { ...docSummary(id), snippet: null, marks: [], ...overrides };
}

export function versionMeta(version: number, overrides: Partial<DocVersionMeta> = {}): DocVersionMeta {
  return {
    version,
    title: 'Trip plan: Lisbon',
    kind: 'plan',
    author: 'agent',
    note: null,
    runId: 'run-1',
    toolCallId: `call-doc-${version}`,
    chars: 1000,
    taint: [],
    createdAt: '2026-10-12T15:00:00.000Z',
    ...overrides,
  };
}

export function docComment(id: number, overrides: Partial<DocComment> = {}): DocComment {
  return {
    id,
    docId: 1,
    version: 3,
    quote: null,
    text: `Comment ${id}`,
    author: 'owner',
    sessionKey: 'main',
    eventId: null,
    deliveredAt: null,
    createdAt: '2026-10-13T01:10:00.000Z',
    ...overrides,
  };
}

export const tripVersions: DocVersionMeta[] = [
  versionMeta(3, { note: 'moved the hotel to Alfama and added packing', chars: TRIP_V3.length, createdAt: '2026-10-13T00:45:00.000Z' }),
  versionMeta(2, { note: 'added the held flights', chars: TRIP_V2.length, createdAt: '2026-10-10T17:30:00.000Z' }),
  versionMeta(1, { createdAt: '2026-10-10T16:00:00.000Z' }),
];

export const tripVersion: DocVersion = {
  ...tripVersions[0]!,
  body: TRIP_V3,
  links: [
    { label: 'The run that wrote it', href: '#/runs/run-1' },
    { label: 'Hotel booking page', href: 'https://hotel.example.com/alfama' },
  ],
};

export const tripComments: DocComment[] = [
  docComment(1, { version: 2, text: 'Can we find a hotel closer to the old town?', eventId: 41, deliveredAt: '2026-10-10T19:00:05.000Z', createdAt: '2026-10-10T19:00:00.000Z' }),
  docComment(2, { version: 3, quote: 'Free cancellation until November 10.', text: 'Set a reminder for November 9 so I can still cancel.' }),
];

export const tripDetail: DocDetail = {
  doc: docSummary(1, {
    title: 'Trip plan: Lisbon',
    kind: 'plan',
    version: 3,
    chars: TRIP_V3.length,
    comments: 2,
    createdAt: '2026-10-10T16:00:00.000Z',
    updatedAt: '2026-10-13T00:45:00.000Z',
  }),
  version: tripVersion,
  versions: tripVersions,
  comments: tripComments,
};

// a doc of one version whose text the writing session read from a web page.
export const taintedDetail: DocDetail = {
  doc: docSummary(2, { title: 'Laptop comparison', kind: 'comparison', tainted: true }),
  version: {
    ...versionMeta(1, { title: 'Laptop comparison', kind: 'comparison', taint: ['web_fetch: https://reviews.example.com/laptops'] }),
    body: '# Laptop comparison\n\n| Model | Price |\n| --- | ---: |\n| Air 13 | $1,099 |\n\n**Pick:** the Air 13.',
    links: [],
  },
  versions: [versionMeta(1, { title: 'Laptop comparison', kind: 'comparison', taint: ['web_fetch: https://reviews.example.com/laptops'] })],
  comments: [],
};

export const docsList: DocListItem[] = [
  docItem(1, { title: 'Trip plan: Lisbon', kind: 'plan', version: 3, comments: 2, updatedAt: '2026-10-13T00:45:00.000Z' }),
  docItem(3, { title: 'Prep: 1:1 with Dana', kind: 'meeting_prep', updatedAt: '2026-10-12T15:00:00.000Z' }),
  docItem(4, { title: 'Morning brief, October 12', kind: 'brief', sessionKey: 'auto:brief:run-1', updatedAt: '2026-10-12T14:30:00.000Z' }),
  docItem(5, { title: 'Notes on the essay', kind: 'notes', author: 'owner', sessionKey: null, updatedAt: '2026-10-12T03:00:00.000Z' }),
  docItem(2, { title: 'Laptop comparison', kind: 'comparison', tainted: true, updatedAt: '2026-10-11T18:05:00.000Z' }),
];

export const docsPage: DocsPage = { docs: docsList, nextCursor: null, mode: null };

export const emptyDocsPage: DocsPage = { docs: [], nextCursor: null, mode: null };

export const searchPage: DocsPage = {
  docs: [docItem(1, { title: 'Trip plan: Lisbon', kind: 'plan', version: 3, snippet: '…The hotel moved to Alfama, closer to the walks…', marks: [[20, 26]] })],
  nextCursor: null,
  mode: 'fts',
};

export const tripDiff: DocDiff = {
  docId: 1,
  from: 2,
  to: 3,
  added: 3,
  removed: 1,
  title: null,
  coarse: false,
  hunks: [
    {
      fromStart: 1,
      fromLines: 4,
      toStart: 1,
      toLines: 6,
      lines: [
        { op: 'same', text: '# Trip plan: Lisbon', fromLine: 1, toLine: 1 },
        { op: 'same', text: '', fromLine: 2, toLine: 2 },
        { op: 'del', text: 'Five days in Lisbon, November 14 to 18. Flights are held, not booked: **nothing is paid yet**.', fromLine: 3, toLine: null },
        {
          op: 'add',
          text: 'Five days in Lisbon, November 14 to 18. Flights are held, not booked: **nothing is paid yet**. The hotel moved to Alfama, closer to the walks.',
          fromLine: null,
          toLine: 3,
        },
        { op: 'add', text: '## Hotel', fromLine: null, toLine: 4 },
        { op: 'add', text: '', fromLine: null, toLine: 5 },
        { op: 'same', text: '', fromLine: 4, toLine: 6 },
      ],
    },
  ],
};
