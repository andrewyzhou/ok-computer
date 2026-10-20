import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocDetail, DocDiff, DocListItem, DocsPage } from '../src/dashboard/docs-types.js';
import { createDashboard } from '../src/dashboard/server.js';
import { diffVersions } from '../src/docs/diff.js';
import { searchDocs } from '../src/docs/fts.js';
import { silentLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';
import { TRIP_V1, TRIP_V2, TRIP_V3 } from './docs-seed.js';
import { seedDashboard } from './seed.js';

// the search and the diff are built by other packages. the routes only pass the right input and answer the result.
vi.mock('../src/docs/fts.js', () => ({ searchDocs: vi.fn() }));
vi.mock('../src/docs/diff.js', () => ({ diffVersions: vi.fn() }));

afterEach(() => {
  vi.mocked(searchDocs).mockReset();
  vi.mocked(diffVersions).mockReset();
});

type Dashboard = Awaited<ReturnType<typeof seedDashboard>>['dashboard'];

async function get<T>(dashboard: Dashboard, path: string): Promise<T> {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

describe('the docs list', () => {
  it('lists the docs newest updatedAt first, with no snippet and no search mode', async () => {
    const { dashboard, docs } = await seedDashboard();
    const page = await get<DocsPage>(dashboard, '/api/docs');
    expect(page.mode).toBeNull();
    expect(page.nextCursor).toBeNull();
    expect(page.docs.map((doc) => doc.id)).toEqual([docs.tripId, docs.danaId, docs.briefId, docs.notesId, docs.laptopsId]);
    expect(page.docs[0]).toMatchObject({ title: 'Trip plan: Lisbon', kind: 'plan', author: 'agent', version: 3, chars: TRIP_V3.length, comments: 2, snippet: null, marks: [] });
    expect(page.docs.find((doc) => doc.id === docs.laptopsId)).toMatchObject({ tainted: true, comments: 0 });
    expect(page.docs.find((doc) => doc.id === docs.notesId)).toMatchObject({ author: 'owner', sessionKey: null, tainted: false });
    expect(searchDocs).not.toHaveBeenCalled();
  });

  it('pages through the docs with a cursor', async () => {
    const { dashboard, docs } = await seedDashboard();
    const first = await get<DocsPage>(dashboard, '/api/docs?limit=2');
    expect(first.docs.map((doc) => doc.id)).toEqual([docs.tripId, docs.danaId]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await get<DocsPage>(dashboard, `/api/docs?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.docs.map((doc) => doc.id)).toEqual([docs.briefId, docs.notesId]);
    const third = await get<DocsPage>(dashboard, `/api/docs?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`);
    expect(third.docs.map((doc) => doc.id)).toEqual([docs.laptopsId]);
    expect(third.nextCursor).toBeNull();
  });

  it('filters by kind', async () => {
    const { dashboard, docs } = await seedDashboard();
    const plans = await get<DocsPage>(dashboard, '/api/docs?kind=plan');
    expect(plans.docs.map((doc) => doc.id)).toEqual([docs.tripId]);
    const other = await get<DocsPage>(dashboard, '/api/docs?kind=other');
    expect(other).toEqual({ docs: [], nextCursor: null, mode: null });
  });

  it('gives a search to searchDocs and answers its hits with no cursor', async () => {
    const { dashboard, docs } = await seedDashboard();
    const hit = { id: docs.tripId, title: 'Trip plan: Lisbon', snippet: 'the hotel moved to Alfama', marks: [[18, 24]] } as unknown as DocListItem;
    vi.mocked(searchDocs).mockReturnValue({ mode: 'fts', docs: [hit] });
    const page = await get<DocsPage>(dashboard, '/api/docs?q=%20alfama%20&kind=plan&limit=5&cursor=ignored');
    expect(page).toEqual({ docs: [hit], nextCursor: null, mode: 'fts' });
    expect(searchDocs).toHaveBeenCalledTimes(1);
    expect(vi.mocked(searchDocs).mock.calls[0]![1]).toEqual({ q: 'alfama', kind: 'plan', limit: 5 });

    vi.mocked(searchDocs).mockReturnValue({ mode: 'like', docs: [] });
    expect(await get<DocsPage>(dashboard, '/api/docs?q=al')).toEqual({ docs: [], nextCursor: null, mode: 'like' });
    expect(vi.mocked(searchDocs).mock.calls[1]![1]).toEqual({ q: 'al', limit: 30 });
  });

  it('answers an empty list on the first run', async () => {
    const t = createTestApp([], { start: '2026-10-12T09:00:00-07:00' });
    const dashboard = createDashboard({ db: t.db, config: t.config, clock: t.clock, logger: silentLogger, app: t.app, webDir: join(t.dataDir, 'no-web') });
    expect(await get<DocsPage>(dashboard, '/api/docs')).toEqual({ docs: [], nextCursor: null, mode: null });
  });
});

describe('a doc', () => {
  it('gives the newest version with its history and comments', async () => {
    const { dashboard, docs } = await seedDashboard();
    const detail = await get<DocDetail>(dashboard, `/api/docs/${docs.tripId}`);
    expect(detail.doc).toMatchObject({ id: docs.tripId, version: 3, comments: 2 });
    expect(detail.version).toMatchObject({ version: 3, title: 'Trip plan: Lisbon', body: TRIP_V3, note: 'moved the hotel to Alfama and added packing' });
    expect(detail.version.links).toEqual([
      { label: 'The run that wrote it', href: '#/runs/run-1' },
      { label: 'Hotel booking page', href: 'https://hotel.example.com/alfama' },
    ]);
    expect(detail.versions.map((version) => version.version)).toEqual([3, 2, 1]);
    expect(detail.versions[0]).not.toHaveProperty('body');
    expect(detail.comments.map((comment) => [comment.version, comment.text])).toEqual([
      [2, 'Can we find a hotel closer to the old town?'],
      [3, 'Set a reminder for November 9 so I can still cancel.'],
    ]);
    expect(detail.comments[0]).toMatchObject({ author: 'owner', eventId: null, deliveredAt: null });
  });

  it('gives an older version when the query asks for it', async () => {
    const { dashboard, docs } = await seedDashboard();
    const detail = await get<DocDetail>(dashboard, `/api/docs/${docs.tripId}?version=2`);
    expect(detail.doc.version).toBe(3);
    expect(detail.version).toMatchObject({ version: 2, body: TRIP_V2, note: 'added the held flights', links: [{ label: 'The run that wrote it', href: '#/runs/run-1' }] });
    expect(detail.versions).toHaveLength(3);
  });

  it('gives the diff of two versions to diffVersions', async () => {
    const { dashboard, docs } = await seedDashboard();
    const diff: DocDiff = { docId: docs.tripId, from: 1, to: 3, added: 2, removed: 1, hunks: [], title: null, coarse: false };
    vi.mocked(diffVersions).mockReturnValue(diff);
    expect(await get<DocDiff>(dashboard, `/api/docs/${docs.tripId}/diff?from=1&to=3`)).toEqual(diff);
    expect(diffVersions).toHaveBeenCalledWith({
      docId: docs.tripId,
      from: { version: 1, title: 'Trip plan: Lisbon', body: TRIP_V1 },
      to: { version: 3, title: 'Trip plan: Lisbon', body: TRIP_V3 },
    });
    // from may be greater than to, and the route passes them in that order.
    await get<DocDiff>(dashboard, `/api/docs/${docs.tripId}/diff?from=2&to=1`);
    expect(vi.mocked(diffVersions).mock.calls[1]![0]).toMatchObject({ from: { version: 2, body: TRIP_V2 }, to: { version: 1, body: TRIP_V1 } });
  });
});

describe('the export', () => {
  it('downloads the newest version as markdown', async () => {
    const { dashboard, docs } = await seedDashboard();
    const response = await dashboard.request(`/api/docs/${docs.tripId}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="trip-plan-lisbon-v3.md"');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(TRIP_V3, 'utf8'))).toBe(true);
  });

  it('downloads an older version', async () => {
    const { dashboard, docs } = await seedDashboard();
    const response = await dashboard.request(`/api/docs/${docs.tripId}/export?version=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="trip-plan-lisbon-v1.md"');
    expect(await response.text()).toBe(TRIP_V1);
  });
});
