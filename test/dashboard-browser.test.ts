import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserOverview, BrowserTaskDetail } from '../src/dashboard/browser-types.js';
import { createBlobStore } from '../src/observability/blobs.js';
import { createByteStore } from '../src/observability/byte-blobs.js';
import { storeOutputs } from '../src/sandbox/files.js';
import { JPEG, seedBrowser } from './seed-browser.js';

describe('the browser api', () => {
  it('lists tasks with their blocked and sent counts, the engine pauses and the profile state', async () => {
    const { dashboard } = seedBrowser();
    const overview = (await (await dashboard.request('/api/browser')).json()) as BrowserOverview;
    expect(overview.tasks.map((task) => task.id)).toEqual(['bt_2', 'bt_1']);
    expect(overview.tasks[1]).toMatchObject({ allowlist: ['shop.example'], steps: 2, blocked: 1, sent: 1, hasTrace: true });
    expect(overview.engines).toEqual([
      { id: 'google', label: 'Google', paused: true, until: '2026-10-13T18:00:00Z', reason: 'a CAPTCHA', strikes: 2 },
      { id: 'duckduckgo', label: 'DuckDuckGo', paused: false, until: null, reason: null, strikes: 0 },
    ]);
    expect(overview.profileInUse).toBe(false);
  });

  // the count was of the steps with a block, next to a count of the sent requests (r7 probe).
  it('counts the blocked requests of a task, not its steps with a block', async () => {
    const { t, dashboard } = seedBrowser();
    const blocked = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ url: `https://evil.example/${i}`, reason: 'blocked' })));
    for (const n of [5, 1]) {
      t.db.prepare('INSERT INTO browser_steps (taskId, runId, action, urlBefore, urlAfter, blockedRequests, durationMs, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('bt_2', 'run-1', 'open', '', '', blocked(n), 1, '2026-10-13T17:02:01Z');
    }
    const overview = (await (await dashboard.request('/api/browser')).json()) as BrowserOverview;
    expect(overview.tasks[0]).toMatchObject({ id: 'bt_2', steps: 2, blocked: 6 });
  });

  it('gives the steps of a task, each joined to the risk and the policy decision of its tool call', async () => {
    const { dashboard, snapshot, shot } = seedBrowser();
    const detail = (await (await dashboard.request('/api/browser/tasks/bt_1')).json()) as BrowserTaskDetail;
    expect(detail.steps).toEqual([
      expect.objectContaining({ action: 'open', target: 'https://shop.example/', snapshotBlob: snapshot, screenshotBlob: shot, blockedRequests: [expect.objectContaining({ url: 'https://evil.example/x' })], sent: [], offsiteHosts: ['cdn.example'], decision: null }),
      expect.objectContaining({ action: 'submit', sent: [{ method: 'POST', url: 'https://shop.example/buy', form: true }], risk: 'external', decision: 'approve', rule: 'risk:external', approvalId: 7 }),
    ]);
  });

  it('serves a screenshot as a jpeg and never a text blob', async () => {
    const { dashboard, snapshot, shot } = seedBrowser();
    const image = await dashboard.request(`/api/browser/screenshots/${shot}`);
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(JPEG);
    expect((await dashboard.request(`/api/browser/screenshots/${snapshot}`)).status).toBe(404);
    expect((await dashboard.request('/api/browser/screenshots/..%2F..%2Fokc.sqlite')).status).toBe(404);
  });

  // the sandbox writes its files into the same blobs table. an svg that the code wrote is text with an image type, and
  // served here it ran its script at the origin of the dashboard.
  it('never serves a file of the sandbox, not even an svg that a step names', async () => {
    const { t, dashboard } = seedBrowser();
    const clock = () => new Date('2026-10-13T17:00:00Z');
    const stores = { blobs: createBlobStore(t.db, join(t.dataDir, 'blobs'), clock), bytes: createByteStore(t.db, join(t.dataDir, 'blobs'), clock) };
    const [svg, png] = storeOutputs(
      [
        { path: 'out/x.svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
        { path: 'out/chart.png', bytes: Buffer.from('89504e470d0a1a0a0000', 'hex') },
      ],
      stores,
    );
    expect(svg!.mime).toMatch(/^image\/svg\+xml/);
    expect((await dashboard.request(`/api/browser/screenshots/${svg!.blob}`)).status).toBe(404);
    // a raster file that no step names is not a screenshot either.
    expect((await dashboard.request(`/api/browser/screenshots/${png!.blob}`)).status).toBe(404);
    // a damaged step row that names the svg still gets no svg, because the type is checked too.
    t.db.prepare('INSERT INTO browser_steps (taskId, action, urlBefore, urlAfter, screenshotBlob, durationMs, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run('bt_2', 'open', '', '', svg!.blob, 1, '2026-10-13T17:02:01Z');
    expect((await dashboard.request(`/api/browser/screenshots/${svg!.blob}`)).status).toBe(404);
  });

  it('gives a trace zip, and a damaged row cannot name another file', async () => {
    const { dashboard } = seedBrowser();
    const zip = await dashboard.request('/api/browser/tasks/bt_1/trace');
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(await zip.text()).toBe('PK..');
    expect((await dashboard.request('/api/browser/tasks/bt_2/trace')).status).toBe(404);
  });
});
