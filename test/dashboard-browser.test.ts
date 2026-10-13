import { describe, expect, it } from 'vitest';
import type { BrowserTaskDetail, BrowserTaskSummary } from '../src/dashboard/browser-types.js';
import { PNG, seedBrowser } from './seed-browser.js';

describe('the browser api', () => {
  it('lists tasks with their step and block counts, and gives the steps of one task', async () => {
    const { dashboard, snapshot, shot } = seedBrowser();
    const list = (await (await dashboard.request('/api/browser/tasks')).json()) as BrowserTaskSummary[];
    expect(list.map((task) => task.id)).toEqual(['bt_2', 'bt_1']);
    expect(list[1]).toMatchObject({ allowlist: ['shop.example'], steps: 1, blocked: 1, hasTrace: true });
    const detail = (await (await dashboard.request('/api/browser/tasks/bt_1')).json()) as BrowserTaskDetail;
    expect(detail.steps).toEqual([
      expect.objectContaining({ action: 'open', snapshotBlob: snapshot, screenshotBlob: shot, blockedRequests: [expect.objectContaining({ url: 'https://evil.example/x' })] }),
    ]);
  });

  it('serves a screenshot as an image and never a text blob', async () => {
    const { dashboard, snapshot, shot } = seedBrowser();
    const image = await dashboard.request(`/api/browser/screenshots/${shot}`);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    expect((await dashboard.request(`/api/browser/screenshots/${snapshot}`)).status).toBe(404);
    expect((await dashboard.request('/api/browser/screenshots/..%2F..%2Fokc.sqlite')).status).toBe(404);
  });

  it('gives a trace zip, and a damaged row cannot name another file', async () => {
    const { dashboard } = seedBrowser();
    const zip = await dashboard.request('/api/browser/tasks/bt_1/trace');
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(await zip.text()).toBe('PK..');
    expect((await dashboard.request('/api/browser/tasks/bt_2/trace')).status).toBe(404);
  });
});
