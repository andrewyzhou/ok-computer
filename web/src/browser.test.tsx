// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedBrowser } from '../../test/seed-browser';
import { App } from './App';

vi.stubGlobal(
  'EventSource',
  class {
    onmessage = null;
  },
);

let seeded: ReturnType<typeof seedBrowser>;
beforeEach(() => {
  seeded = seedBrowser();
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => seeded.dashboard.request(String(input), init));
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

describe('the browser pages', () => {
  it('lists the tasks with their status and block counts', async () => {
    location.hash = '#/browser';
    render(<App />);
    expect(await screen.findByText('shop.example')).toBeTruthy();
    expect(screen.getByText('the browser stopped')).toBeTruthy();
  });

  it('replays a task step by step, with the screenshot, the blocked request and the snapshot', async () => {
    location.hash = '#/browser/bt_1';
    render(<App />);
    const shot = (await screen.findByAltText(/page after step/)) as HTMLImageElement;
    expect(shot.getAttribute('src')).toBe(`/api/browser/screenshots/${seeded.shot}`);
    expect(screen.getByText('https://evil.example/x')).toBeTruthy();
    expect(screen.getByText(/trace zip/).getAttribute('href')).toBe('/api/browser/tasks/bt_1/trace');
    fireEvent.click(screen.getByRole('button', { name: /snapshot/ }));
    expect(await screen.findByText('- button "Buy now" [ref=e7]')).toBeTruthy();
  });

  it('says why a crashed task has no trace', async () => {
    location.hash = '#/browser/bt_2';
    render(<App />);
    expect(await screen.findByText('the browser stopped before the trace was saved')).toBeTruthy();
  });
});
