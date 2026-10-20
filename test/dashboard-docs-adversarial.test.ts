import { describe, expect, it } from 'vitest';
import type { DocDetail, DocDiff, DocsPage } from '../src/dashboard/docs-types.js';
import { addVersion, createDoc } from '../src/docs/store.js';
import { seedDashboard } from './seed.js';

// tests that try to break the docs routes with odd ids, odd queries, odd titles and odd bytes. the search, the diff and
// the store are the real ones.

type Seeded = Awaited<ReturnType<typeof seedDashboard>>;

const at = new Date('2026-10-13T16:00:00Z');

function newDoc(t: Seeded['t'], title: string, body: string): number {
  const result = createDoc(t.db, { author: 'agent', title, kind: 'notes', body }, at);
  if (!result.ok) throw new Error(result.error);
  return result.value.id;
}

async function status(dashboard: Seeded['dashboard'], path: string, init?: RequestInit): Promise<number> {
  const response = await dashboard.request(path, init);
  await response.arrayBuffer();
  return response.status;
}

describe('the docs routes against odd input', () => {
  it('answers 404 for each path id or version that is not a positive whole number', async () => {
    const { dashboard, docs } = await seedDashboard();
    for (const id of ['0', '-1', '1.0', '01', '0x1', '1e0', 'abc', '99999999999999999999', '9007199254740993']) {
      expect(await status(dashboard, `/api/docs/${id}`), id).toBe(404);
      expect(await status(dashboard, `/api/docs/${id}/export`), id).toBe(404);
    }
    for (const version of ['0', '-1', '1.5', '01', '1e0', 'abc', '4', '']) {
      expect(await status(dashboard, `/api/docs/${docs.tripId}?version=${version}`), version).toBe(404);
      expect(await status(dashboard, `/api/docs/${docs.tripId}/export?version=${version}`), version).toBe(404);
    }
  });

  it('answers 400 for a bad query, a bad kind and a changed cursor, and clamps the limit', async () => {
    const { dashboard } = await seedDashboard();
    for (const query of ['q=', 'q=%20%20', 'q=%00%00', `q=${'a'.repeat(201)}`, 'kind=PLAN', 'kind=plan%00', 'cursor=!!!', 'cursor=eyJ4IjoxfQ']) {
      expect(await status(dashboard, `/api/docs?${query}`), query).toBe(400);
    }
    const one = (await (await dashboard.request('/api/docs?limit=-5')).json()) as DocsPage;
    expect(one.docs).toHaveLength(1);
    const huge = (await (await dashboard.request('/api/docs?limit=1e9')).json()) as DocsPage;
    expect(huge.docs.length).toBeGreaterThan(1);
    const words = (await (await dashboard.request('/api/docs?limit=abc')).json()) as DocsPage;
    expect(words.docs.length).toBeGreaterThan(1);
  });

  it('searches with fts syntax and like wildcards as plain text through the route', async () => {
    const { dashboard } = await seedDashboard();
    for (const q of ['"', 'a"b', 'NEAR(a b)', 'title:x', '%', '_', '\\', '*', 'a OR b', "'; DROP TABLE docs; --"]) {
      const response = await dashboard.request(`/api/docs?q=${encodeURIComponent(q)}`);
      expect(response.status, q).toBe(200);
      await response.json();
    }
    expect(await status(dashboard, '/api/docs')).toBe(200);
  });

  it('diffs a version with itself and backwards', async () => {
    const { dashboard, docs } = await seedDashboard();
    const same = (await (await dashboard.request(`/api/docs/${docs.tripId}/diff?from=2&to=2`)).json()) as DocDiff;
    expect(same).toMatchObject({ added: 0, removed: 0, hunks: [], title: null });
    const forward = (await (await dashboard.request(`/api/docs/${docs.tripId}/diff?from=1&to=3`)).json()) as DocDiff;
    const back = (await (await dashboard.request(`/api/docs/${docs.tripId}/diff?from=3&to=1`)).json()) as DocDiff;
    expect(back.added).toBe(forward.removed);
    expect(back.removed).toBe(forward.added);
    for (const query of ['from=1', 'to=1', 'from=0&to=1', 'from=1&to=x', 'from=1.0&to=2']) {
      expect(await status(dashboard, `/api/docs/${docs.tripId}/diff?${query}`), query).toBe(400);
    }
    expect(await status(dashboard, `/api/docs/${docs.tripId}/diff?from=1&to=9`)).toBe(404);
  });
});

describe('the export against odd titles and bytes', () => {
  it('keeps every byte of the body, also a byte order mark and carriage returns', async () => {
    const seeded = await seedDashboard();
    const body = '﻿# Title\r\nline\r\ntab\there\r\n😀 東京\n';
    const id = newDoc(seeded.t, 'Bytes', body);
    const response = await seeded.dashboard.request(`/api/docs/${id}/export`);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.from(bytes).equals(Buffer.from(body, 'utf8'))).toBe(true);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('gives a file name that a header carries safely, for hostile and non-latin titles', async () => {
    const seeded = await seedDashboard();
    const cases: Array<[string, RegExp]> = [
      ['"; filename="evil.exe', /^attachment; filename="filename-evil-exe-v1\.md"$/],
      ['Report\r\nSet-Cookie: x=1', /^attachment; filename="report-set-cookie-x-1-v1\.md"$/],
      ['../../etc/passwd', /^attachment; filename="etc-passwd-v1\.md"$/],
      ['東京の旅', /^attachment; filename="doc-\d+-v1\.md"$/],
      ['Café Crème', /^attachment; filename="cafe-creme-v1\.md"$/],
      ['ÅNGSTRÖM', /^attachment; filename="angstrom-v1\.md"$/],
      ['😀😀😀', /^attachment; filename="doc-\d+-v1\.md"$/],
      ['CON', /^attachment; filename="con-v1\.md"$/],
    ];
    for (const [title, expected] of cases) {
      const result = createDoc(seeded.t.db, { author: 'agent', title, kind: 'notes', body: 'x' }, at);
      if (!result.ok) throw new Error(result.error);
      const response = await seeded.dashboard.request(`/api/docs/${result.value.id}/export`);
      expect(response.status, title).toBe(200);
      expect(response.headers.get('content-disposition'), title).toMatch(expected);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('exports an older version under its own title', async () => {
    const seeded = await seedDashboard();
    const id = newDoc(seeded.t, 'First name', 'one');
    const changed = addVersion(seeded.t.db, id, { author: 'agent', title: 'Second name', body: 'two' }, at);
    expect(changed.ok).toBe(true);
    const old = await seeded.dashboard.request(`/api/docs/${id}/export?version=1`);
    expect(await old.text()).toBe('one');
    expect(old.headers.get('content-disposition')).toBe('attachment; filename="first-name-v1.md"');
    const detail = (await (await seeded.dashboard.request(`/api/docs/${id}?version=1`)).json()) as DocDetail;
    expect(detail).toMatchObject({ doc: { version: 2, title: 'Second name' }, version: { version: 1, title: 'First name', body: 'one' } });
  });
});

describe('the comment route against odd bodies', () => {
  const post = (dashboard: Seeded['dashboard'], path: string, body: string) =>
    dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  it('answers 400 for a body of the wrong shape and stores nothing', async () => {
    const { t, dashboard, docs } = await seedDashboard();
    const path = `/api/docs/${docs.tripId}/comments`;
    const before = t.db.prepare('SELECT count(*) AS n FROM doc_comments').get();
    for (const body of [
      '[]',
      'null',
      '"text"',
      '{',
      JSON.stringify({ text: 'x', version: '3' }),
      JSON.stringify({ text: 'x', version: 3.5 }),
      JSON.stringify({ text: 'x', version: 0 }),
      JSON.stringify({ text: null, version: 3 }),
      JSON.stringify({ text: 'x', version: 3, quote: null }),
      JSON.stringify({ text: 'x', version: 3, author: 'agent' }),
      JSON.stringify({ text: 'x', version: 3, sessionKey: 'auto:inbox' }),
      JSON.stringify({ text: ['x'], version: 3 }),
    ]) {
      const response = await post(dashboard, path, body);
      expect(response.status, body).toBe(400);
      expect(Object.keys((await response.json()) as object)).toEqual(['error']);
    }
    expect(t.db.prepare('SELECT count(*) AS n FROM doc_comments').get()).toEqual(before);
  });

  it('answers 404 for a doc that does not exist and a version from the future', async () => {
    const { dashboard, docs } = await seedDashboard();
    expect((await post(dashboard, '/api/docs/9999/comments', JSON.stringify({ text: 'x', version: 1 }))).status).toBe(404);
    expect((await post(dashboard, '/api/docs/01/comments', JSON.stringify({ text: 'x', version: 1 }))).status).toBe(404);
    expect((await post(dashboard, `/api/docs/${docs.tripId}/comments`, JSON.stringify({ text: 'x', version: 4 }))).status).toBe(404);
  });

  it('keeps hostile text of a comment as text in the stored row', async () => {
    const { t, dashboard, docs } = await seedDashboard();
    const text = '<script>alert(1)</script>\r\n‮evil';
    const response = await post(dashboard, `/api/docs/${docs.tripId}/comments`, JSON.stringify({ text, version: 3 }));
    expect(response.status).toBe(201);
    await t.app.idle();
    const row = t.db.prepare('SELECT text FROM doc_comments ORDER BY id DESC LIMIT 1').get();
    expect(row).toEqual({ text: text.trim() });
  });
});
