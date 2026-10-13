import { describe, expect, it } from 'vitest';
import type { BrowserOverview, BrowserTaskDetail } from '../src/dashboard/browser-types.js';
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

  it('gives the steps of a task, each joined to the risk and the policy decision of its tool call', async () => {
    const { dashboard, snapshot, shot } = seedBrowser();
    const detail = (await (await dashboard.request('/api/browser/tasks/bt_1')).json()) as BrowserTaskDetail;
    expect(detail.steps).toEqual([
      expect.objectContaining({ action: 'open', snapshotBlob: snapshot, screenshotBlob: shot, blockedRequests: [expect.objectContaining({ url: 'https://evil.example/x' })], sent: [], decision: null }),
      expect.objectContaining({ action: 'submit', sent: [{ method: 'POST', url: 'https://shop.example/buy' }], risk: 'external', decision: 'approve', rule: 'risk:external', approvalId: 7 }),
    ]);
  });

  it('serves a screenshot as a jpeg and never a text blob', async () => {
    const { dashboard, snapshot, shot } = seedBrowser();
    const image = await dashboard.request(`/api/browser/screenshots/${shot}`);
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(JPEG);
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
