// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { inMain, installEventSource, openApp, stubFetch } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { fiveDigest, fiveDigests, fiveDrafts, fiveProposals, fiveSendersPage, fiveSubscriptionsPage } from './fixtures';

// the owner has five accounts, so each list says which account each row came from. a table shows the account in its
// own column from 1100px up, and as a badge under the name below that width, where the column is hidden. jsdom does
// not lay out the page, so these tests check that each row has both places and that the stylesheet shows each one
// at its own width. the screenshots check the layout itself.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

const routes = {
  'GET /api/inbox/digests/latest': () => fiveDigest,
  'GET /api/inbox/digests': () => fiveDigests,
  'GET /api/inbox/senders': () => fiveSendersPage,
  'GET /api/inbox/subscriptions': () => fiveSubscriptionsPage,
  'GET /api/inbox/drafts': () => fiveDrafts,
  'GET /api/inbox/proposals': () => fiveProposals,
};

// the account of each row of a table, read from the wide column and from the badge under the name.
function accountsOf(table: HTMLElement) {
  const rows = [...table.querySelectorAll('tbody tr')];
  return {
    wide: rows.map((row) => row.querySelector('td.hide-below-md .inbox-account')?.textContent),
    narrow: rows.map((row) => row.querySelector('.inbox-below-md .inbox-account')?.textContent),
  };
}

describe('the account of each row', () => {
  it('shows the account under the name only below the width where the account column hides', () => {
    const css = readFileSync(join(import.meta.dirname, 'inbox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.inbox-below-md\s*\{\s*display:\s*none;\s*\}/);
    expect(css).toMatch(/@media \(max-width: 1099\.98px\)\s*\{\s*\.inbox-below-md\s*\{\s*display:\s*flex;/);
  });

  it('labels each newsletter sender with its account at both widths', async () => {
    stubFetch(seeded.dashboard, routes);
    openApp('#/inbox/newsletters');
    await inMain().findByText('Chapter news');
    const table = inMain().getByRole('table', { name: 'newsletter senders' });
    expect(within(table).getByRole('columnheader', { name: 'Account' }).className).toContain('hide-below-md');
    // the same list in two accounts stays two rows, each with its own account.
    expect(accountsOf(table)).toEqual({ wide: ['a06', 'yurun', 'school', 'a581', 'hkn'], narrow: ['a06', 'yurun', 'school', 'a581', 'hkn'] });
    fireEvent.click(within(table).getByText('Chapter news'));
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect(panel.getByText('Account').nextElementSibling?.textContent).toBe('hkn');
  });

  it('labels each subscription with its account at both widths', async () => {
    stubFetch(seeded.dashboard, routes);
    openApp('#/inbox/subscriptions');
    await inMain().findByText('Streamly');
    const table = inMain().getByRole('table', { name: 'subscriptions' });
    expect(accountsOf(table)).toEqual({ wide: ['a06', 'yurun', 'a581'], narrow: ['a06', 'yurun', 'a581'] });
    fireEvent.click(inMain().getByRole('checkbox', { name: /Show rows with no repeating charge/ }));
    expect(accountsOf(table).narrow).toEqual(['a06', 'yurun', 'a581', 'school', 'hkn']);
    fireEvent.click(within(table).getByText('Gym Plus'));
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect(panel.getByText('Account').nextElementSibling?.textContent).toBe('a581');
  });

  it('labels each draft with its account at both widths, and keeps the account in the details', async () => {
    stubFetch(seeded.dashboard, routes);
    openApp('#/inbox/drafts');
    await inMain().findByText('Re: Meeting notes');
    const table = inMain().getByRole('table', { name: 'drafts' });
    expect(accountsOf(table)).toEqual({ wide: ['yurun', 'school', 'a581', 'a06', 'hkn'], narrow: ['yurun', 'school', 'a581', 'a06', 'hkn'] });
    fireEvent.click(within(table).getByText('Re: Meeting notes'));
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect((await panel.findByText('Account')).nextElementSibling?.textContent).toBe('hkn');
  });

  it('labels each proposal with its account, and keeps the account in the details', async () => {
    stubFetch(seeded.dashboard, routes);
    openApp('#/inbox/proposals');
    await inMain().findByText('Chapter meeting');
    const items = [...inMain().getByRole('list', { name: 'calendar proposals' }).querySelectorAll(':scope > li')];
    expect(items.map((item) => item.querySelector('.inbox-account')?.textContent)).toEqual(['school', 'a581', 'a06', 'yurun', 'hkn']);
    fireEvent.click(within(inMain().getByTestId('proposal-35')).getByRole('button', { name: 'Chapter meeting' }));
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect((await panel.findByText('Account')).nextElementSibling?.textContent).toBe('hkn');
  });

  it('labels each digest item with its account', async () => {
    stubFetch(seeded.dashboard, routes);
    openApp('#/inbox');
    await inMain().findByText('Dues for the fall term');
    const accounts = [...document.querySelectorAll('main .inbox-items .inbox-account')].map((badge) => badge.textContent);
    expect(accounts).toEqual(['school', 'yurun', 'school', 'a581', 'a06', 'a06']);
  });

  it('still shows the account when only one account is configured', async () => {
    const one = { ...fiveSendersPage, accounts: ['a06'], senders: fiveSendersPage.senders.slice(0, 1) };
    stubFetch(seeded.dashboard, { ...routes, 'GET /api/inbox/senders': () => one });
    openApp('#/inbox/newsletters');
    await inMain().findByText('Weekly Deals');
    expect(accountsOf(inMain().getByRole('table', { name: 'newsletter senders' }))).toEqual({ wide: ['a06'], narrow: ['a06'] });
  });
});
