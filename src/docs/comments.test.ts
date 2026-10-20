import { describe, expect, it } from 'vitest';
import { seedDocs } from '../../test/docs-seed.js';
import { openDb, type Db } from '../db/index.js';
import { listEvents } from '../events/log.js';
import { silentLogger } from '../observability/logger.js';
import { createRunQueue } from '../sessions/queue.js';
import { COMMENT_CHARS, commentEventText, createDocComments, QUOTE_CHARS } from './comments.js';
import { listComments } from './store.js';

const now = new Date('2026-10-13T09:00:00Z');

function setup(db: Db = openDb(':memory:')) {
  const queue = createRunQueue();
  const comments = createDocComments({ db, queue, clock: () => now, logger: silentLogger });
  return { db, queue, comments };
}

const commentEvents = (db: Db) => listEvents(db, 'main').filter((each) => each.type === 'system_event');
const deliveries = (db: Db) => Number(db.prepare('SELECT count(*) AS n FROM doc_comment_deliveries').get()!.n);

describe('the doc comments', () => {
  it('stores a comment at once and sends its event through the queue', async () => {
    const { db, queue, comments } = setup();
    const { tripId } = seedDocs(db);
    const added = comments.add({ docId: tripId, version: 3, text: '  Book the earlier flight.\nAnd a window seat.  ' });
    expect(added).toMatchObject({
      ok: true,
      value: { docId: tripId, version: 3, text: 'Book the earlier flight.\nAnd a window seat.', quote: null, author: 'owner', sessionKey: 'main', eventId: null, deliveredAt: null, createdAt: now.toISOString() },
    });
    expect(commentEvents(db)).toHaveLength(0);
    await queue.drain();
    const events = commentEvents(db);
    expect(events).toHaveLength(1);
    const stored = listComments(db, tripId).at(-1)!;
    expect(stored).toMatchObject({ eventId: events[0]!.id, deliveredAt: now.toISOString() });
    expect(events[0]!.payload).toEqual({
      text: [
        `The owner commented on doc #${tripId}, version 3.`,
        'The comment:\nBook the earlier flight.\nAnd a window seat.',
        'Read it with doc_read before you answer, and answer with doc_update or in the chat.',
      ].join('\n\n'),
    });
  });

  it('names the doc by its id, never by its title, and has no taint', async () => {
    const { db, queue, comments } = setup();
    const { laptopsId } = seedDocs(db);
    comments.add({ docId: laptopsId, version: 1, text: 'Which one is lightest?', quote: '  Pro 14  ' });
    await queue.drain();
    const event = commentEvents(db)[0]!;
    if (event.type !== 'system_event') throw new Error('not a system event');
    expect(event.payload.taint).toBeUndefined();
    expect(event.payload.text).not.toContain('Laptop comparison');
    expect(event.payload.text).toContain(`doc #${laptopsId}`);
    expect(event.payload.text).toContain('The comment is about this part of the doc:\n> Pro 14');
  });

  it('says when the doc has a newer version than the one the owner read', () => {
    const base = { id: 1, docId: 4, quote: 'line one\nline two', text: 'Fix this.', author: 'owner' as const, sessionKey: 'main', eventId: null, deliveredAt: null, createdAt: '' };
    const text = commentEventText({ ...base, version: 2 }, 3);
    expect(text).toMatch(/^The owner commented on doc #4, version 2; the doc is now at version 3\./);
    expect(text).toContain('> line one\n> line two');
    expect(text.indexOf('line two')).toBeLessThan(text.indexOf('Fix this.'));
    expect(commentEventText({ ...base, version: 3, quote: null }, 3)).not.toContain('now at version');
  });

  it('trims the quote, drops an empty one and refuses a long one', () => {
    const { db, comments } = setup();
    const { tripId } = seedDocs(db);
    expect(comments.add({ docId: tripId, version: 3, text: 'x', quote: '   ' })).toMatchObject({ ok: true, value: { quote: null } });
    expect(comments.add({ docId: tripId, version: 3, text: 'x', quote: ' a b ' })).toMatchObject({ ok: true, value: { quote: 'a b' } });
    expect(comments.add({ docId: tripId, version: 3, text: 'x', quote: 'q'.repeat(QUOTE_CHARS) })).toMatchObject({ ok: true });
    expect(comments.add({ docId: tripId, version: 3, text: 'x', quote: 'q'.repeat(QUOTE_CHARS + 1) })).toEqual({ ok: false, error: 'the quote has more than 500 characters' });
  });

  it('refuses an empty or a long text, a missing doc and a missing version', () => {
    const { db, comments } = setup();
    const { tripId } = seedDocs(db);
    expect(comments.add({ docId: tripId, version: 3, text: ' \n ' })).toMatchObject({ ok: false, error: expect.stringContaining('4,000') });
    expect(comments.add({ docId: tripId, version: 3, text: 'y'.repeat(COMMENT_CHARS) })).toMatchObject({ ok: true });
    expect(comments.add({ docId: tripId, version: 3, text: 'y'.repeat(COMMENT_CHARS + 1) })).toEqual({ ok: false, error: 'the comment has more than 4,000 characters' });
    expect(comments.add({ docId: 99, version: 1, text: 'x' })).toEqual({ ok: false, error: 'doc not found' });
    expect(comments.add({ docId: tripId, version: 4, text: 'x' })).toEqual({ ok: false, error: 'version not found' });
    expect(comments.add({ docId: tripId, version: 0, text: 'x' })).toEqual({ ok: false, error: 'version not found' });
    // the two comments of the seed and the one of 4,000 characters.
    expect(listComments(db, tripId)).toHaveLength(3);
  });

  it('delivers a comment one time when start runs after add', async () => {
    const { db, queue, comments } = setup();
    const { tripId } = seedDocs(db);
    comments.add({ docId: tripId, version: 3, text: 'one' });
    // start finds the same comment still waiting, so it queues a second delivery of it.
    comments.start();
    comments.start();
    await queue.drain();
    expect(commentEvents(db)).toHaveLength(3);
    expect(deliveries(db)).toBe(3);
    expect(commentEvents(db).filter((each) => each.type === 'system_event' && each.payload.text.includes('\none\n'))).toHaveLength(1);
  });

  it('sends at start only the comments that wait, oldest first', async () => {
    const { db, queue, comments } = setup();
    const { tripId } = seedDocs(db);
    comments.start();
    await queue.drain();
    const events = commentEvents(db);
    expect(events.map((each) => (each.type === 'system_event' ? each.payload.text.split('\n')[0] : ''))).toEqual([
      `The owner commented on doc #${tripId}, version 2; the doc is now at version 3.`,
      `The owner commented on doc #${tripId}, version 3.`,
    ]);
    expect(listComments(db, tripId).map((each) => each.eventId)).toEqual(events.map((each) => each.id));
    comments.start();
    await queue.drain();
    expect(commentEvents(db)).toHaveLength(2);
  });

  it('does not send a comment twice when a second process starts on the same database', async () => {
    const first = setup();
    seedDocs(first.db);
    const second = setup(first.db);
    first.comments.start();
    second.comments.start();
    await Promise.all([first.queue.drain(), second.queue.drain()]);
    expect(commentEvents(first.db)).toHaveLength(2);
    expect(deliveries(first.db)).toBe(2);
  });
});
