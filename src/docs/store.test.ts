import { describe, expect, it } from 'vitest';
import { seedDocs, TRIP_V3 } from '../../test/docs-seed.js';
import { openDb } from '../db/index.js';
import type { TaintSource } from '../policy/policy.js';
import {
  addVersion,
  BODY_CHARS,
  createDoc,
  getDoc,
  getVersion,
  HREF_CHARS,
  InvalidDocCursor,
  isSafeHref,
  LINKS_MAX,
  listComments,
  listDocs,
  listVersions,
  versionTaint,
  type NewDoc,
} from './store.js';

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

  it('takes a body of exactly the limit and refuses one more character', () => {
    const db = openDb(':memory:');
    expect(createDoc(db, { ...note, body: 'x'.repeat(BODY_CHARS) }, now)).toMatchObject({ ok: true, value: { chars: BODY_CHARS } });
    expect(createDoc(db, { ...note, body: 'x'.repeat(BODY_CHARS + 1) }, now)).toMatchObject({ ok: false });
    const id = must(createDoc(db, note, now));
    expect(addVersion(db, id, { author: 'agent', body: 'y'.repeat(BODY_CHARS + 1) }, now)).toMatchObject({ ok: false });
  });

  it('takes 20 links and refuses 21', () => {
    const db = openDb(':memory:');
    const links = (count: number) => Array.from({ length: count }, (_, index) => ({ label: `l${index}`, href: `#/runs/run-${index}` }));
    expect(LINKS_MAX).toBe(20);
    expect(createDoc(db, { ...note, links: links(20) }, now)).toMatchObject({ ok: true });
    expect(createDoc(db, { ...note, links: links(21) }, now)).toMatchObject({ ok: false, error: 'a doc has at most 20 links' });
  });

  it('takes only http(s) urls and #/ hashes as hrefs', () => {
    for (const href of ['HTTPS://a.example', 'http://a.example/x?y=1', '#/docs/1?version=2', '#/runs/run-1']) expect(isSafeHref(href), href).toBe(true);
    const refused = [
      'javascript:x',
      ' javascript:x',
      'JavaScript:x',
      'java\tscript:x',
      'data:text/html,x',
      '//evil.example',
      '#javascript:x',
      '#/x\\y',
      'mailto:a@b',
      '',
      ' https://a.example',
      'https://a.example\n',
      'https://a.ex\u0000ample',
      'ftp://a.example',
      `https://a.example/${'x'.repeat(HREF_CHARS)}`,
    ];
    for (const href of refused) expect(isSafeHref(href), JSON.stringify(href)).toBe(false);
    expect(isSafeHref(`https://a.example/${'x'.repeat(HREF_CHARS - 'https://a.example/'.length)}`)).toBe(true);
    const db = openDb(':memory:');
    expect(createDoc(db, { ...note, links: [{ label: 'x', href: 'data:text/html,x' }] }, now)).toMatchObject({ ok: false });
  });

  it('refuses a title of only spaces and stores a title trimmed', () => {
    const db = openDb(':memory:');
    expect(createDoc(db, { ...note, title: '   ' }, now)).toEqual({ ok: false, error: 'give the doc a title' });
    const id = must(createDoc(db, { ...note, title: '  Plan  ' }, now));
    expect(getDoc(db, id)!.title).toBe('Plan');
    expect(getVersion(db, id, 1)!.title).toBe('Plan');
    expect(addVersion(db, id, { author: 'agent', title: ' \t ' }, now)).toMatchObject({ ok: false });
    // a title with spaces around it that is the same once trimmed is no change.
    expect(addVersion(db, id, { author: 'agent', title: ' Plan ' }, now)).toMatchObject({ ok: false });
    // the limit counts the trimmed title, which is the one that is stored.
    expect(createDoc(db, { ...note, title: ` ${'t'.repeat(200)} ` }, now)).toMatchObject({ ok: true });
    expect(createDoc(db, { ...note, title: 't'.repeat(201) }, now)).toMatchObject({ ok: false });
  });

  it('refuses the second of two changes made from the same version', () => {
    const db = openDb(':memory:');
    const id = must(createDoc(db, note, now));
    expect(addVersion(db, id, { author: 'agent', body: 'from the agent', baseVersion: 1 }, now)).toMatchObject({ ok: true, value: { version: 2 } });
    const second = addVersion(db, id, { author: 'owner', body: 'from the owner', baseVersion: 1 }, now);
    expect(second).toEqual({ ok: false, error: `doc #${id} is at version 2, not 1. Read it again before you change it` });
    expect(getVersion(db, id, 2)!.body).toBe('from the agent');
    expect(listVersions(db, id)).toHaveLength(2);
  });

  it('keeps the first source of each name in the union of the taint', () => {
    const db = openDb(':memory:');
    const source = (name: string, toolCallId: string): TaintSource => ({ source: name, toolName: 'web_fetch', runId: null, toolCallId, at: now.toISOString() });
    const id = must(createDoc(db, { ...note, taint: [source('a', 'first'), source('b', 'first')] }, now));
    addVersion(db, id, { author: 'agent', body: 'two', taint: [source('b', 'second'), source('c', 'second')] }, now);
    expect(versionTaint(db, id, 2).map((each) => [each.source, each.toolCallId])).toEqual([
      ['a', 'first'],
      ['b', 'first'],
      ['c', 'second'],
    ]);
    // the owner's own version adds no source, but it keeps the ones before it.
    addVersion(db, id, { author: 'owner', body: 'three' }, now);
    expect(listVersions(db, id)[0]!.taint).toEqual(['a', 'b', 'c']);
    expect(getDoc(db, id)).toMatchObject({ tainted: true, author: 'owner' });
  });

  it('reads damaged taint as tainted and damaged links as no links', () => {
    const db = openDb(':memory:');
    const id = must(createDoc(db, note, now));
    const insert = db.prepare(
      `INSERT INTO doc_versions (docId, version, title, kind, body, links, author, taint, createdAt) VALUES (?, ?, 'a', 'notes', 'b', ?, 'agent', ?, ?)`,
    );
    const damaged = ['not json', '{}', '"x"', 'null', '7', '[1]', '[null]', '[{"name":"x"}]'];
    damaged.forEach((taint, index) => insert.run(id, index + 2, '{broken', taint, now.toISOString()));
    for (let version = 2; version < damaged.length + 2; version++) {
      expect(versionTaint(db, id, version).length, damaged[version - 2]).toBeGreaterThan(0);
      expect(getVersion(db, id, version)!.taint.length).toBeGreaterThan(0);
      expect(getVersion(db, id, version)!.links).toEqual([]);
    }
    // a list with one good source and one bad entry keeps the good source and still marks the bad one.
    insert.run(id, 20, '[{"label":"x","href":"javascript:x"},{"label":"ok","href":"#/x"}]', '[{"source":"s"},3]', now.toISOString());
    expect(getVersion(db, id, 20)!.taint).toEqual(['s', 'a doc version whose taint cannot be read']);
    expect(getVersion(db, id, 20)!.links).toEqual([{ label: 'ok', href: '#/x' }]);
    // the docs row that points at a damaged version reads as tainted in the list.
    db.exec(`UPDATE docs SET version = 2 WHERE id = ${id}`);
    expect(getDoc(db, id)!.tainted).toBe(true);
    expect(versionTaint(db, id, 1)).toEqual([]);
  });

  it('stops an update or a delete of a comment delivery', () => {
    const db = openDb(':memory:');
    const { tripId } = seedDocs(db);
    const event = db
      .prepare("INSERT INTO events (sessionKey, seq, type, payload, createdAt) VALUES ('main', 1, 'system_event', '{}', ?) RETURNING id")
      .get(now.toISOString())!;
    const comment = listComments(db, tripId)[0]!;
    db.prepare('INSERT INTO doc_comment_deliveries (commentId, eventId, deliveredAt) VALUES (?, ?, ?)').run(comment.id, Number(event.id), now.toISOString());
    expect(listComments(db, tripId)[0]).toMatchObject({ eventId: Number(event.id), deliveredAt: now.toISOString() });
    expect(() => db.exec("UPDATE doc_comment_deliveries SET deliveredAt = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM doc_comment_deliveries')).toThrow(/append-only/);
    expect(() => db.exec("UPDATE doc_comments SET text = 'x'")).toThrow(/append-only/);
  });

  it('keeps one search row for each doc, with the newest version', () => {
    const db = openDb(':memory:');
    const { tripId } = seedDocs(db);
    const id = must(createDoc(db, note, now));
    addVersion(db, id, { author: 'agent', body: 'two', kind: 'plan' }, now);
    addVersion(db, id, { author: 'agent', body: 'three', title: 'renamed' }, now);
    const rows = db.prepare('SELECT rowid AS id, title, body, kind FROM docs_fts ORDER BY rowid').all();
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => Number(row.id) === id)).toEqual({ id, title: 'renamed', body: 'three', kind: 'plan' });
    expect(rows.filter((row) => Number(row.id) === tripId)).toHaveLength(1);
    expect(rows.find((row) => Number(row.id) === tripId)!.body).toBe(TRIP_V3);
  });

  it('keeps the author of the newest version on the docs row', () => {
    const db = openDb(':memory:');
    const id = must(createDoc(db, note, now));
    addVersion(db, id, { author: 'owner', body: 'two' }, now);
    expect(db.prepare('SELECT author FROM docs WHERE id = ?').get(id)).toEqual({ author: 'owner' });
    expect(getDoc(db, id)!.author).toBe('owner');
  });
});

const note: NewDoc = { title: 'a', kind: 'notes', body: 'one', author: 'agent' };

function must(result: { ok: true; value: { id: number } } | { ok: false; error: string }): number {
  if (!result.ok) throw new Error(result.error);
  return result.value.id;
}
