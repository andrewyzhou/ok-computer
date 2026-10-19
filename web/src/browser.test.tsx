// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedBrowser } from '../../test/seed-browser';
import { inMain, installEventSource, openApp, stubFetch } from './testing';

installEventSource();

let seeded: ReturnType<typeof seedBrowser>;
beforeEach(() => {
  seeded = seedBrowser();
  stubFetch(seeded.dashboard);
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

const details = () => within(screen.getByRole('complementary', { name: 'details' }));

describe('the browser pages', () => {
  it('lists the tasks with their status and request counts, and the pause of each search engine', async () => {
    openApp('#/browser');
    const main = inMain();
    expect(await main.findByText('shop.example')).toBeTruthy();
    expect(main.getByText('the browser stopped')).toBeTruthy();
    expect(main.getByText('1 blocked')).toBeTruthy();
    expect(main.getByText('1 sent')).toBeTruthy();
    // the nav also has a Google link, for the google integration page.
    const google = main.getByText('Google', { selector: 'li strong' }).closest('li')!;
    expect(google.textContent).toMatch(/paused.*a CAPTCHA, until .*\(pause 2 in a row\)/);
    expect(main.getByText('DuckDuckGo').closest('li')!.textContent).toContain('ready');
    expect(main.getByText(/okc browser login can open it now/)).toBeTruthy();
  });

  it('shows the summary of the selected task in the details panel, with a link to its replay', async () => {
    openApp('#/browser');
    const row = (await inMain().findByText('shop.example')).closest('tr')!;
    fireEvent.click(row);
    expect(await details().findByRole('heading', { name: 'Task bt_1' })).toBeTruthy();
    expect(details().getByText('the agent closed it')).toBeTruthy();
    expect(details().getByRole('link', { name: /trace zip/ }).getAttribute('href')).toBe('/api/browser/tasks/bt_1/trace');
    expect(details().getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('#/browser/bt_1');
  });

  it('shows what an approved submit sent, with its risk, decision and approval', async () => {
    openApp('#/browser/bt_1');
    const main = inMain();
    expect(await main.findByText("Sent after the owner's approval")).toBeTruthy();
    expect(main.getByText(/POST https:\/\/shop.example\/buy/)).toBeTruthy();
    expect(main.getByText('the form')).toBeTruthy();
    expect(main.getByText('external')).toBeTruthy();
    expect(main.getByText('approve')).toBeTruthy();
    expect(main.getByText('approval #7').getAttribute('href')).toBe('#/approvals');
    expect(within(screen.getByRole('navigation', { name: 'breadcrumb' })).getByRole('link', { name: 'Browser' }).getAttribute('href')).toBe('#/browser');
  });

  it('replays a task step by step, with the screenshot, the blocked request and the snapshot', async () => {
    openApp('#/browser/bt_1');
    const main = inMain();
    const [shot] = (await main.findAllByAltText(/page after step/)) as HTMLImageElement[];
    expect(shot!.getAttribute('src')).toBe(`/api/browser/screenshots/${seeded.shot}`);
    expect(main.getByAltText('page after step 2')).toBeTruthy();
    expect(main.getByText('https://evil.example/x')).toBeTruthy();
    expect(main.getByText('Also reached, off the allowlist: cdn.example')).toBeTruthy();
    expect(screen.getByRole('link', { name: /trace zip/ }).getAttribute('href')).toBe('/api/browser/tasks/bt_1/trace');
    fireEvent.click(main.getAllByRole('button', { name: /snapshot/ })[0]!);
    expect(await main.findByText('- button "Buy now" [ref=s1e7]')).toBeTruthy();
  });

  it('selects a step in the filmstrip and shows its facts in the details panel', async () => {
    openApp('#/browser/bt_1');
    const strip = within(await inMain().findByRole('list', { name: 'steps' }));
    const first = strip.getByRole('button', { name: 'Step 1, open, blocked' });
    const second = strip.getByRole('button', { name: 'Step 2, submit, sent' });
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(details().getByText('Selected step 1')).toBeTruthy();
    fireEvent.click(second);
    expect(second.getAttribute('aria-pressed')).toBe('true');
    expect(first.getAttribute('aria-pressed')).toBe('false');
    expect(details().getByText('Selected step 2')).toBeTruthy();
    expect(details().getByText('2, submit')).toBeTruthy();
    expect(details().getByText('external')).toBeTruthy();
    expect(screen.getByRole('region', { name: /Step 2/ }).className).toContain('is-selected');
  });

  it('opens the replay at the step of the query', async () => {
    openApp('#/browser/bt_1?step=2');
    expect(await details().findByText('Selected step 2')).toBeTruthy();
  });

  it('says why a crashed task has no trace', async () => {
    openApp('#/browser/bt_2');
    expect(await screen.findByText('the browser stopped before the trace was saved')).toBeTruthy();
    expect(inMain().getByText('No steps.')).toBeTruthy();
  });
});
