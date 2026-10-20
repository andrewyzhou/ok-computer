import { describe, expect, it } from 'vitest';
import { seedDocs, TRIP_V3 } from '../../test/docs-seed.js';
import { openDb } from '../db/index.js';
import { addVersion, createDoc, getDoc, getVersion, InvalidDocCursor, listComments, listDocs, listVersions, versionTaint } from './store.js';

const now = new Date('2026-10-12T12:00:00Z');

describe('the docs store', () => {
  it('keeps each change as a new version and the docs row as the newest', () => {
    const db = openDb(':memory:');
    const { tripId, laptopsId } = seedDocs(db);
    const trip = getDoc(db, tripId)!;
    expect(trip).toMatchObject({ title: 'Trip plan: Lisbon', kind: 'plan', version: 3, comments: 2, tainted: false, chars: TRIP_V3.length });
    expect(listVersions(db, tripId).map((each) => [each.version, each.note])).toEqual([
      [3, 'moved the hotel to Alfama and added packing'],
      [2, 'added the held flights'],
      [1, null],
    ]);
    expect(getVersion(db, tripId, 3)!.links).toHaveLength(2);
    expect(getDoc(db, laptopsId)!.tainted).toBe(true);
    expect(listComments(db, tripId).map((each) => [each.version, each.eventId])).toEqual([
      [2, null],
      [3, null],
    ]);
  });

  it('refuses a stale base version, an empty change and an unsafe link', () => {
    const db = openDb(':memory:');
    const id = (createDoc(db, { title: 'a', kind: 'notes', body: 'one', author: 'agent' }, now) as { ok: true; value: { id: number } }).value.id;
    expect(addVersion(db, id, { author: 'agent', body: 'two', baseVersion: 2 }, now)).toMatchObject({ ok: false });
    expect(addVersion(db, id, { author: 'agent', body: 'one' }, now)).toMatchObject({ ok: false });
    expect(addVersion(db, id, { author: 'agent', links: [{ label: 'x', href: 'javascript:alert(1)' }] }, now)).toMatchObject({ ok: false });
    expect(addVersion(db, 99, { author: 'agent', body: 'two' }, now)).toEqual({ ok: false, error: 'doc #99 not found' });
    expect(addVersion(db, id, { author: 'agent', body: 'two', baseVersion: 1 }, now)).toMatchObject({ ok: true, value: { version: 2 } });
  });

  it('keeps the taint of a doc in each later version', () => {
    const db = openDb(':memory:');
    const taint = [{ source: 'web_fetch: https://a.example', toolName: 'web_fetch', runId: null, toolCallId: 'c', at: now.toISOString() }];
    const id = (createDoc(db, { title: 'a', kind: 'notes', body: 'one', author: 'agent', taint }, now) as { ok: true; value: { id: number } }).value.id;
    addVersion(db, id, { author: 'agent', body: 'two' }, now);
    expect(versionTaint(db, id, 2).map((each) => each.source)).toEqual(['web_fetch: https://a.example']);
  });

  it('stops an update or a delete of a version', () => {
    const db = openDb(':memory:');
    seedDocs(db);
    expect(() => db.exec("UPDATE doc_versions SET body = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM doc_versions')).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM doc_comments')).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM docs')).toThrow(/never deleted/);
  });

  it('pages newest first and refuses a cursor it did not make', () => {
    const db = openDb(':memory:');
    seedDocs(db);
    const first = listDocs(db, { limit: 2 });
    expect(first.docs.map((each) => each.title)).toEqual(['Trip plan: Lisbon', 'Prep: 1:1 with Dana']);
    const second = listDocs(db, { limit: 10, cursor: first.nextCursor! });
    expect(second.docs.map((each) => each.title)).toEqual(['Morning brief, October 12', 'Notes on the essay', 'Laptop comparison']);
    expect(second.nextCursor).toBeNull();
    expect(listDocs(db, { limit: 10, kind: 'brief' }).docs).toHaveLength(1);
    expect(() => listDocs(db, { limit: 10, cursor: 'nope' })).toThrow(InvalidDocCursor);
  });
});
