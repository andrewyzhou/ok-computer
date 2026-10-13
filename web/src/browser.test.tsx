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
  it('lists the tasks with their status and request counts, and the pause of each search engine', async () => {
    location.hash = '#/browser';
    render(<App />);
    expect(await screen.findByText('shop.example')).toBeTruthy();
    expect(screen.getByText('the browser stopped')).toBeTruthy();
    expect(screen.getByText('1 blocked')).toBeTruthy();
    expect(screen.getByText('1 sent')).toBeTruthy();
    const google = screen.getByText('Google').closest('li')!;
    expect(google.textContent).toMatch(/paused.*a CAPTCHA, until .*\(pause 2 in a row\)/);
    expect(screen.getByText('DuckDuckGo').closest('li')!.textContent).toContain('ready');
    expect(screen.getByText(/okc browser login can open it now/)).toBeTruthy();
  });

  it('shows what an approved submit sent, with its risk, decision and approval', async () => {
    location.hash = '#/browser/bt_1';
    render(<App />);
    expect(await screen.findByText("Sent after the owner's approval")).toBeTruthy();
    expect(screen.getByText(/POST https:\/\/shop.example\/buy/)).toBeTruthy();
    expect(screen.getByText('external')).toBeTruthy();
    expect(screen.getByText('approve')).toBeTruthy();
    expect(screen.getByText('approval #7').getAttribute('href')).toBe('#/approvals');
  });

  it('replays a task step by step, with the screenshot, the blocked request and the snapshot', async () => {
    location.hash = '#/browser/bt_1';
    render(<App />);
    const [shot] = (await screen.findAllByAltText(/page after step/)) as HTMLImageElement[];
    expect(shot!.getAttribute('src')).toBe(`/api/browser/screenshots/${seeded.shot}`);
    expect(screen.getByText('https://evil.example/x')).toBeTruthy();
    expect(screen.getByRole('link', { name: /trace zip/ }).getAttribute('href')).toBe('/api/browser/tasks/bt_1/trace');
    fireEvent.click(screen.getAllByRole('button', { name: /snapshot/ })[0]!);
    expect(await screen.findByText('- button "Buy now" [ref=s1e7]')).toBeTruthy();
  });

  it('says why a crashed task has no trace', async () => {
    location.hash = '#/browser/bt_2';
    render(<App />);
    expect(await screen.findByText('the browser stopped before the trace was saved')).toBeTruthy();
  });
});
