// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { stubFetch } from '../../testing';
import { hunkHeader } from './DiffView';
import { DocLinkCards, DocLinkText } from './DocLinkCard';
import { versionMeta } from './fixtures';
import { Markdown, withoutTitle } from './Markdown';
import { VersionHistory, VERSIONS_SHOWN } from './VersionHistory';

// the fixes of the review of the docs track: the links of a tainted version, the reference links of a long doc, the
// title of the body, the doc links in a chat text, the diff header and the version list.

afterEach(cleanup);

const show = (text: string, tainted = false) => render(<Markdown text={text} tainted={tainted} />).container.querySelector('.doc-markdown') as HTMLElement;

describe('the links of a tainted version', () => {
  it('shows a link that carries data as text with its full address, and opens a plain one', () => {
    const root = show('[Confirm booking](https://evil.example/c?d=calendar-of-the-owner) and [the hotel](https://hotel.example.com/alfama)', true);
    expect(root.querySelector('a[href*="evil.example"]')).toBeNull();
    expect(root.textContent).toContain('Confirm booking (https://evil.example/c?d=calendar-of-the-owner)');
    expect(within(root).getByRole('link', { name: /the hotel/ }).getAttribute('href')).toBe('https://hotel.example.com/alfama');
  });

  it('holds a long path, a fragment and a user name too, and keeps a doc hash', () => {
    const long = `https://evil.example/${'a'.repeat(60)}`;
    const root = show(`[a](${long}) [b](https://evil.example/x#data) [c](https://user:pw@evil.example/) [d](#/docs/2)`, true);
    expect(root.querySelectorAll('a')).toHaveLength(1);
    expect(root.querySelector('a')!.getAttribute('href')).toBe('#/docs/2');
    expect(root.textContent).toContain(long);
  });

  it('shows the address of a held autolink once', () => {
    const root = show('See <https://evil.example/c?d=data> now.', true);
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent!.split('https://evil.example/c?d=data')).toHaveLength(2);
  });

  it('opens no mail link, also one with a body', () => {
    const root = show('[write](mailto:a@evil.example?body=the-data) [plain](mailto:dana@example.com)', true);
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('mailto:a@evil.example?body=the-data');
  });

  it('never offers to load an image with a query, and still offers a plain one', () => {
    const root = show('![map](https://evil.example/p.png?d=data) ![photo](https://images.example.com/a.png)', true);
    const buttons = within(root).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toContain('photo');
    expect(root.textContent).toContain('https://evil.example/p.png?d=data');
    fireEvent.click(buttons[0]!);
    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(root.querySelector('img')!.getAttribute('src')).toBe('https://images.example.com/a.png');
  });

  it('opens the same links in a clean version', () => {
    const root = show('[Confirm](https://a.example/c?d=1) [write](mailto:dana@example.com)');
    expect(root.querySelectorAll('a')).toHaveLength(2);
  });
});

describe('the reference links of a long doc', () => {
  it('resolves a definition that comes after the 2,000th character', () => {
    const text = `See [the plan][plan] and ![map][img].\n\n${'word '.repeat(600)}\n\n[plan]: https://plan.example.com/a\n[img]: https://images.example.com/m.png`;
    expect(text.indexOf('[plan]:')).toBeGreaterThan(2_000);
    const root = show(text);
    expect(within(root).getByRole('link', { name: /the plan/ }).getAttribute('href')).toBe('https://plan.example.com/a');
    expect(within(root).getByRole('button', { name: /map/ })).toBeTruthy();
    expect(root.textContent).not.toContain('[the plan]');
  });
});

describe('the title of the body', () => {
  it('leaves out a first h1 that equals the title, in any case', () => {
    expect(withoutTitle('# Trip plan: Lisbon\n\nFive days.', 'Trip plan: Lisbon')).toBe('\nFive days.');
    expect(withoutTitle('\n  #  trip PLAN: lisbon  #\nFive days.', ' Trip plan: Lisbon ')).toBe('Five days.');
    expect(withoutTitle('# Another title\n\nFive days.', 'Trip plan: Lisbon')).toBe('# Another title\n\nFive days.');
    expect(withoutTitle('Intro\n# Trip plan: Lisbon', 'Trip plan: Lisbon')).toBe('Intro\n# Trip plan: Lisbon');
    expect(withoutTitle('## Trip plan: Lisbon', 'Trip plan: Lisbon')).toBe('## Trip plan: Lisbon');
  });
});

describe('the doc links in a chat text', () => {
  it('shows each doc link as a short link to the local hash', () => {
    render(
      <p>
        <DocLinkText text="Plan ready: http://127.0.0.1:4242/#/docs/1. I also compared in #/docs/2?version=3 for you." />
      </p>,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['doc #1', '#/docs/1'],
      ['doc #2, version 3', '#/docs/2?version=3'],
    ]);
    expect(document.body.textContent).toBe('Plan ready: doc #1. I also compared in doc #2, version 3 for you.');
  });

  it('keeps a text with no doc link as it is', () => {
    render(<DocLinkText text="No link here, only https://example.com/a" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.textContent).toBe('No link here, only https://example.com/a');
  });

  it('says how many docs the cards leave out, and links them', () => {
    stubFetch(null, { 'GET /api/docs/:id': () => new Promise(() => undefined) });
    render(<DocLinkCards text="#/docs/1 #/docs/2 #/docs/3 #/docs/4 #/docs/5" />);
    const more = screen.getByText(/^and 2 more docs/);
    expect(within(more).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['#/docs/4', '#/docs/5']);
  });
});

describe('the diff and the versions', () => {
  it('names the lines of a hunk in words', () => {
    expect(hunkHeader({ fromStart: 1, fromLines: 40, toStart: 1, toLines: 77 })).toBe('Lines 1–40 → 1–77');
    expect(hunkHeader({ fromStart: 7, fromLines: 1, toStart: 0, toLines: 0 })).toBe('Lines 7 → none');
  });

  it('shows the newest versions and the shown one, and all of them on a click', () => {
    const versions = Array.from({ length: 14 }, (_, index) => versionMeta(14 - index));
    render(<VersionHistory docId={1} versions={versions} current={2} />);
    const list = () => within(screen.getByRole('list', { name: 'Versions' }));
    expect(list().getAllByRole('listitem')).toHaveLength(VERSIONS_SHOWN + 1);
    expect(list().getByRole('link', { name: 'Version 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 14 versions' }));
    expect(list().getAllByRole('listitem')).toHaveLength(14);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('starts the compare form at the diff on the page', () => {
    const versions = [3, 2, 1].map((version) => versionMeta(version));
    render(<VersionHistory docId={1} versions={versions} current={3} diffFrom={1} />);
    const form = within(screen.getByRole('form', { name: 'Compare two versions' }));
    expect((form.getByLabelText('From') as HTMLSelectElement).value).toBe('1');
    expect((form.getByLabelText('To') as HTMLSelectElement).value).toBe('3');
  });

  it('labels a tainted version with a word and not only a color', () => {
    render(<VersionHistory docId={1} versions={[versionMeta(2, { taint: ['web: a page'] }), versionMeta(1)]} current={2} />);
    expect(within(screen.getByRole('list', { name: 'Versions' })).getAllByText('outside text')).toHaveLength(1);
  });
});
