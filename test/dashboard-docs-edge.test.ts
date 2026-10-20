import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportSlug } from '../src/dashboard/docs.js';
import type { DocDetail, DocsPage } from '../src/dashboard/docs-types.js';
import type { Db } from '../src/db/index.js';
import { diffVersions } from '../src/docs/diff.js';
import { searchDocs } from '../src/docs/fts.js';
import * as store from '../src/docs/store.js';
import { seedDashboard } from './seed.js';

// the search and the diff are built by other packages, so a test here never depends on them. the store is mocked with
// its real code, so a test can make one of its reads throw.
vi.mock('../src/docs/fts.js', () => ({ searchDocs: vi.fn(() => ({ mode: 'fts', docs: [] })) }));
vi.mock('../src/docs/diff.js', () => ({ diffVersions: vi.fn(() => ({ hunks: [] })) }));
vi.mock('../src/docs/store.js', async (original) => ({ ...(await original<typeof import('../src/docs/store.js')>()) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(searchDocs).mockClear();
  vi.mocked(diffVersions).mockClear();
});

type Dashboard = Awaited<ReturnType<typeof seedDashboard>>['dashboard'];

async function error(response: Response | Promise<Response>, status: number): Promise<string> {
  const answer = await response;
  expect(answer.status).toBe(status);
  expect(answer.headers.get('content-type')).toContain('application/json');
  const body = (await answer.json()) as { error: string };
  expect(Object.keys(body)).toEqual(['error']);
  return body.error;
}

// a row written with raw sql, as an old or a damaged database could hold it. the store would refuse such a title or
// such links, so the routes must still answer it.
function rawDoc(db: Db, fields: { title: string; body?: string; links?: string }): number {
  const at = '2026-10-01T10:00:00.000Z';
  const row = db
    .prepare("INSERT INTO docs (title, kind, links, author, version, createdAt, updatedAt) VALUES (?, 'notes', ?, 'agent', 1, ?, ?) RETURNING id")
    .get(fields.title, fields.links ?? '[]', at, at);
  const id = Number(row!.id);
  db.prepare("INSERT INTO doc_versions (docId, version, title, kind, body, links, author, createdAt) VALUES (?, 1, ?, 'notes', ?, ?, 'agent', ?)").run(
    id,
    fields.title,
    fields.body ?? 'text',
    fields.links ?? '[]',
    at,
  );
  return id;
}

const filename = async (dashboard: Dashboard, id: number) => {
  const response = await dashboard.request(`/api/docs/${id}/export`);
  expect(response.status).toBe(200);
  return response.headers.get('content-disposition');
};

describe('the docs routes refuse bad ids and versions', () => {
  it('answers 404 doc not found for an id that names no doc', async () => {
    const { dashboard } = await seedDashboard();
    for (const id of ['0', '-1', '01', '1e3', 'abc', '99999999999999999', '999']) {
      for (const path of [`/api/docs/${id}`, `/api/docs/${id}/export`, `/api/docs/${id}/diff?from=1&to=2`]) {
        expect(await error(dashboard.request(path), 404), path).toBe('doc not found');
      }
    }
  });

  it('answers 404 version not found for a version the doc does not have', async () => {
    const { dashboard, docs } = await seedDashboard();
    for (const version of ['0', '4', '2.5', 'x', '', '-1', '02']) {
      for (const path of [`/api/docs/${docs.tripId}?version=${version}`, `/api/docs/${docs.tripId}/export?version=${version}`]) {
        expect(await error(dashboard.request(path), 404), path).toBe('version not found');
      }
    }
  });

  it('answers 400 for a missing or bad diff number, and 404 for a version the doc lacks', async () => {
    const { dashboard, docs } = await seedDashboard();
    for (const query of ['', '?from=1', '?to=2', '?from=0&to=1', '?from=1&to=x', '?from=1.5&to=2', '?from=-1&to=2']) {
      expect(await error(dashboard.request(`/api/docs/${docs.tripId}/diff${query}`), 400), query).toBe('give from and to as version numbers');
    }
    expect(await error(dashboard.request(`/api/docs/${docs.tripId}/diff?from=1&to=4`), 404)).toBe('version not found');
    expect(await error(dashboard.request(`/api/docs/${docs.laptopsId}/diff?from=2&to=1`), 404)).toBe('version not found');
    expect(diffVersions).not.toHaveBeenCalled();
  });
});

describe('the docs list refuses a bad query', () => {
  it('answers 400 for a cursor that cannot be read', async () => {
    const { dashboard } = await seedDashboard();
    for (const cursor of ['nope', 'e30', Buffer.from('{"updatedAt":1,"id":"x"}').toString('base64url')]) {
      expect(await error(dashboard.request(`/api/docs?cursor=${cursor}`), 400)).toBe('give cursor as the nextCursor of the last page');
    }
  });

  it('answers 400 for a q of only spaces or nul characters, or of more than 200 characters', async () => {
    const { dashboard } = await seedDashboard();
    for (const q of ['', '%20%20%20', '%00', '%00%00%20%00', 'a'.repeat(201), `%20${'b'.repeat(201)}%20`]) {
      expect(await error(dashboard.request(`/api/docs?q=${q}`), 400), q).toBe('give q as 1 to 200 characters');
    }
    expect(searchDocs).not.toHaveBeenCalled();
    // 200 characters after the trim, and nul characters dropped inside, are fine.
    expect((await dashboard.request(`/api/docs?q=%20${'c'.repeat(200)}%20`)).status).toBe(200);
    expect((await dashboard.request('/api/docs?q=lis%00bon')).status).toBe(200);
    expect(vi.mocked(searchDocs).mock.calls.map((call) => call[1].q)).toEqual(['c'.repeat(200), 'lisbon']);
  });

  it('answers 400 for an unknown kind', async () => {
    const { dashboard } = await seedDashboard();
    for (const kind of ['memo', 'PLAN', '']) {
      expect(await error(dashboard.request(`/api/docs?kind=${kind}`), 400)).toBe('give kind as one of: brief, plan, notes, comparison, meeting_prep, other');
    }
  });

  it('clamps the limit and gives the default for a value that is not a number', async () => {
    const { dashboard } = await seedDashboard();
    expect((await (await dashboard.request('/api/docs?limit=0')).json() as DocsPage).docs).toHaveLength(1);
    expect((await (await dashboard.request('/api/docs?limit=500')).json() as DocsPage).docs).toHaveLength(5);
    expect((await (await dashboard.request('/api/docs?limit=many')).json() as DocsPage).docs).toHaveLength(5);
    await dashboard.request('/api/docs?q=abc&limit=500');
    expect(vi.mocked(searchDocs).mock.calls[0]![1].limit).toBe(100);
  });
});

describe('the export file name', () => {
  it('makes an ascii slug of the title', async () => {
    const { t, dashboard, docs } = await seedDashboard();
    expect(await filename(dashboard, docs.tripId)).toBe('attachment; filename="trip-plan-lisbon-v3.md"');
    expect(await filename(dashboard, rawDoc(t.db, { title: 'Café — notes' }))).toBe('attachment; filename="cafe-notes-v1.md"');
    expect(await filename(dashboard, rawDoc(t.db, { title: 'She said "hi" \\ to me' }))).toBe('attachment; filename="she-said-hi-to-me-v1.md"');
    const long = rawDoc(t.db, { title: `${'word '.repeat(60)}`.slice(0, 300).padEnd(300, 'x') });
    const name = (await filename(dashboard, long))!.match(/filename="(.*)-v1\.md"/)![1]!;
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const emoji = rawDoc(t.db, { title: '🎉🎉' });
    expect(await filename(dashboard, emoji)).toBe(`attachment; filename="doc-${emoji}-v1.md"`);
    const cjk = rawDoc(t.db, { title: '旅行計画' });
    expect(await filename(dashboard, cjk)).toBe(`attachment; filename="doc-${cjk}-v1.md"`);
  });

  it('cuts the slug at 60 characters and trims the dashes again', () => {
    expect(exportSlug('a'.repeat(300), 1)).toBe('a'.repeat(60));
    expect(exportSlug(`${'a'.repeat(59)} b`, 1)).toBe('a'.repeat(59));
    expect(exportSlug('--Hello,   World!--', 1)).toBe('hello-world');
    expect(exportSlug('Ｆｕｌｌ ｗｉｄｔｈ', 1)).toBe('full-width');
    expect(exportSlug('   ', 7)).toBe('doc-7');
  });

  it('keeps every byte of the body: carriage returns, unicode and a byte order mark', async () => {
    const { t, dashboard } = await seedDashboard();
    const body = '﻿# Notes\r\n\r\nCafé — 旅行 🎉\r\nline two';
    const id = rawDoc(t.db, { title: 'Raw body', body });
    const response = await dashboard.request(`/api/docs/${id}/export`);
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(body, 'utf8'))).toBe(true);
  });
});

describe('the docs routes with a token', () => {
  it('answer 401 without the token, and the export works with ?token=', async () => {
    const { dashboard, docs } = await seedDashboard({ token: 'secret-token' });
    for (const path of ['/api/docs', `/api/docs/${docs.tripId}`, `/api/docs/${docs.tripId}/diff?from=1&to=2`, `/api/docs/${docs.tripId}/export`]) {
      expect((await dashboard.request(path)).status, path).toBe(401);
    }
    const response = await dashboard.request(`/api/docs/${docs.tripId}/export?version=2&token=secret-token`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="trip-plan-lisbon-v2.md"');
    expect((await dashboard.request('/api/docs', { headers: { authorization: 'Bearer secret-token' } })).status).toBe(200);
  });
});

describe('a damaged row', () => {
  it('reads links that are not json as no links', async () => {
    const { t, dashboard } = await seedDashboard();
    const id = rawDoc(t.db, { title: 'Damaged links', links: '{not json' });
    const detail = (await (await dashboard.request(`/api/docs/${id}`)).json()) as DocDetail;
    expect(detail.version.links).toEqual([]);
    expect(detail.doc.title).toBe('Damaged links');
  });

  it('answers a read that throws with a 500 json error', async () => {
    const { dashboard, docs } = await seedDashboard();
    vi.spyOn(store, 'getVersion').mockImplementation(() => {
      throw new Error('the doc version row is damaged');
    });
    for (const path of [`/api/docs/${docs.tripId}`, `/api/docs/${docs.tripId}/export`, `/api/docs/${docs.tripId}/diff?from=1&to=2`]) {
      expect(await error(dashboard.request(path), 500), path).toBe('the doc version row is damaged');
    }
  });

  it('answers a list that throws with a 500 json error', async () => {
    const { dashboard } = await seedDashboard();
    vi.mocked(searchDocs).mockImplementationOnce(() => {
      throw new Error('the search index is damaged');
    });
    expect(await error(dashboard.request('/api/docs?q=lisbon'), 500)).toBe('the search index is damaged');
  });
});
