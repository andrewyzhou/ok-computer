import type { Db } from '../src/db/index.js';
import { addVersion, createDoc } from '../src/docs/store.js';
import type { DocChange, NewDoc } from '../src/docs/store.js';

// the docs of the seeded dashboard (phase 6 t4). seedDashboard calls seedDocs, so the docs pages, the shots and the
// route tests share one set: five docs of five kinds, one long doc with three versions and two comments, one doc with
// taint, and one doc of the owner. the long body holds raw html and a javascript: link, so a page that renders it
// shows that both stay inert.

const at = (time: string, day: string) => new Date(`${day}T${time}:00-07:00`);

function must<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const tripDays = (hotel: string) =>
  ['Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday'].flatMap((day, index) => [
    `### ${day}, November ${14 + index}`,
    '',
    `- Morning: ${index === 0 ? 'land at 09:40 and take the metro to the hotel' : `walk to the ${['old town', 'river front', 'market', 'tile museum'][index - 1]}`}.`,
    `- Lunch near ${hotel}, about 25 EUR for two.`,
    '- Afternoon: one free block, so the day never feels packed.',
    `- Evening: dinner at ${['a small fish place', 'the rooftop bar', 'a fado house', 'the bakery café', 'the airport'][index]}.`,
    '',
  ]);

export const TRIP_V1 = ['# Trip plan: Lisbon', '', 'Five days in Lisbon, November 14 to 18.', '', '## Days', '', ...tripDays('Hotel Baixa')].join('\n');

export const TRIP_V2 = [
  '# Trip plan: Lisbon',
  '',
  'Five days in Lisbon, November 14 to 18. Flights are held, not booked: **nothing is paid yet**.',
  '',
  '## Flights',
  '',
  '| Leg | Flight | Departs | Arrives | Price |',
  '| --- | --- | --- | --- | ---: |',
  '| SFO → LIS | TP 238 | Nov 13, 19:05 | Nov 14, 09:40 | $612 |',
  '| LIS → SFO | TP 237 | Nov 18, 12:30 | Nov 18, 16:15 | $598 |',
  '',
  '## Days',
  '',
  ...tripDays('Hotel Baixa'),
].join('\n');

// the newest version is long, so the reader shows how a long doc reads at 390.
export const TRIP_V3 = [
  '# Trip plan: Lisbon',
  '',
  'Five days in Lisbon, November 14 to 18. Flights are held, not booked: **nothing is paid yet**. The hotel moved to Alfama, closer to the walks.',
  '',
  '## Flights',
  '',
  '| Leg | Flight | Departs | Arrives | Price |',
  '| --- | --- | --- | --- | ---: |',
  '| SFO → LIS | TP 238 | Nov 13, 19:05 | Nov 14, 09:40 | $612 |',
  '| LIS → SFO | TP 237 | Nov 18, 12:30 | Nov 18, 16:15 | $598 |',
  '',
  '## Hotel',
  '',
  '> Memmo Alfama, four nights, 189 EUR a night with breakfast. Free cancellation until November 10.',
  '',
  'The booking page is [on the hotel site](https://hotel.example.com/alfama). The old plan is in [version 2](#/docs/1?version=2).',
  '',
  '## Days',
  '',
  ...tripDays('Alfama'),
  '## Packing',
  '',
  '1. A light rain jacket: November has rain on about ten days.',
  '2. Walking shoes, because the hills are steep.',
  '3. A travel adapter (type F).',
  '',
  '## Checks before you go',
  '',
  '- [ ] Book the flights before the hold ends on October 25.',
  '- [ ] Tell the bank about the trip.',
  '- [x] Passport is valid until 2029.',
  '',
  '## Notes',
  '',
  'A very long word to test wrapping: Lisbonpublictransportdaypasswithunlimitedmetroandtramridesfortwentyfourhours.',
  '',
  'The model wrote this html, and the page must show it as text: <script>alert("x")</script> <img src=x onerror=alert(1)>.',
  '',
  'This [link is unsafe](javascript:alert(1)) and must not be clickable.',
  '',
  '```',
  'metro: Aeroporto → Baixa-Chiado, red line then blue line, about 25 minutes',
  '```',
].join('\n');

const LAPTOPS = [
  '# Laptop comparison',
  '',
  'Three laptops under $1,500 for writing and light photo work.',
  '',
  '| Model | Weight | Battery | Price |',
  '| --- | ---: | ---: | ---: |',
  '| Air 13 | 1.24 kg | 18 h | $1,099 |',
  '| Slim 14 | 1.39 kg | 14 h | $1,249 |',
  '| Pro 14 | 1.55 kg | 17 h | $1,499 |',
  '',
  '**Pick:** the Air 13, because it is the lightest and the battery lasts a full day.',
  '',
  'Source: [a review site](https://reviews.example.com/laptops).',
].join('\n');

const DANA = [
  '# Prep: 1:1 with Dana',
  '',
  'Tuesday at 10:00, 30 minutes.',
  '',
  '## Topics',
  '',
  '- The essay draft is due on Friday.',
  '- Ask about the reading group in November.',
].join('\n');

const BRIEF = ['# Morning brief, October 12', '', '- 3 events today, the first at 09:30.', '- 2 mails need a reply.', '- The essay goal is due at 21:00.'].join('\n');

const NOTES = ['# Notes on the essay', '', 'The second part needs a better example. Keep it under 2,000 words.'].join('\n');

export interface SeededDocs {
  tripId: number;
  laptopsId: number;
  danaId: number;
  briefId: number;
  notesId: number;
}

export function seedDocs(db: Db): SeededDocs {
  const doc = (input: NewDoc, when: Date) => must(createDoc(db, input, when)).id;
  const change = (id: number, input: DocChange, when: Date) => must(addVersion(db, id, input, when));
  const agent = { author: 'agent' as const, sessionKey: 'main', runId: 'run-1' };

  const tripId = doc(
    { ...agent, title: 'Trip plan: Lisbon', kind: 'plan', body: TRIP_V1, links: [{ label: 'The run that wrote it', href: '#/runs/run-1' }] },
    at('09:00', '2026-10-10'),
  );
  change(tripId, { ...agent, body: TRIP_V2, note: 'added the held flights' }, at('10:30', '2026-10-10'));
  change(
    tripId,
    {
      ...agent,
      body: TRIP_V3,
      note: 'moved the hotel to Alfama and added packing',
      links: [
        { label: 'The run that wrote it', href: '#/runs/run-1' },
        { label: 'Hotel booking page', href: 'https://hotel.example.com/alfama' },
      ],
    },
    at('17:45', '2026-10-12'),
  );
  const laptopsId = doc(
    {
      ...agent,
      title: 'Laptop comparison',
      kind: 'comparison',
      body: LAPTOPS,
      taint: [{ source: 'web_fetch: https://reviews.example.com/laptops', toolName: 'web_fetch', runId: 'run-1', toolCallId: 'call-fetch', at: at('11:00', '2026-10-11').toISOString() }],
    },
    at('11:05', '2026-10-11'),
  );
  const danaId = doc({ ...agent, title: 'Prep: 1:1 with Dana', kind: 'meeting_prep', body: DANA }, at('08:00', '2026-10-12'));
  const briefId = doc({ ...agent, sessionKey: 'auto:brief:run-1', title: 'Morning brief, October 12', kind: 'brief', body: BRIEF }, at('07:30', '2026-10-12'));
  const notesId = doc({ author: 'owner', title: 'Notes on the essay', kind: 'notes', body: NOTES }, at('20:00', '2026-10-11'));

  // two comments of the owner that wait for the session queue. the seed writes them as rows, so it sends no event and
  // the chats of the seed stay as they are.
  const comment = db.prepare('INSERT INTO doc_comments (docId, version, quote, text, author, sessionKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
  comment.run(tripId, 2, null, 'Can we find a hotel closer to the old town?', 'owner', 'main', at('12:00', '2026-10-10').toISOString());
  comment.run(tripId, 3, 'Free cancellation until November 10.', 'Set a reminder for November 9 so I can still cancel.', 'owner', 'main', at('18:10', '2026-10-12').toISOString());
  return { tripId, laptopsId, danaId, briefId, notesId };
}
