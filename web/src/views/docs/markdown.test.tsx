// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Lexer } from 'marked';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRIP_V3 } from '../../../../test/docs-seed';
import { Markdown, renderParts, safeHref } from './Markdown';

afterEach(cleanup);

const show = (text: string) => render(<Markdown text={text} />).container.querySelector('.doc-markdown') as HTMLElement;

describe('the safe markdown of a doc', () => {
  it('shifts the headings one level down and gives each an id slug, deduped with -2 and -3', () => {
    const root = show('# Title\n\n## Days\n\n### Days\n\n#### Days\n\n##### Five\n\n###### Six\n\n# !!!');
    const headings = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) => [heading.tagName, heading.id, heading.textContent]);
    expect(headings).toEqual([
      ['H2', 'doc-title', 'Title'],
      ['H3', 'doc-days', 'Days'],
      ['H4', 'doc-days-2', 'Days'],
      ['H5', 'doc-days-3', 'Days'],
      ['H6', 'doc-five', 'Five'],
      ['H6', 'doc-six', 'Six'],
      ['H2', 'doc-section', '!!!'],
    ]);
    expect(root.querySelector('h1')).toBeNull();
  });

  it('dedupes the slugs across the parts of a long text', () => {
    const long = `## Same\n\n${'word '.repeat(600)}\n\n## Same\n\n${'more '.repeat(600)}\n\n## Same`;
    const ids = [...show(long).querySelectorAll('h3')].map((heading) => heading.id);
    expect(ids).toEqual(['doc-same', 'doc-same-2', 'doc-same-3']);
  });

  it('renders the inline tokens: strong, em, del, code spans, line breaks, escapes and references', () => {
    const root = show('A **bold** and *em* and ~~gone~~ and `a <b> &amp;` text.  \nnext \\*star\\* &amp; &copy; &#65;');
    const p = root.querySelector('p')!;
    expect(p.querySelector('strong')!.textContent).toBe('bold');
    expect(p.querySelector('em')!.textContent).toBe('em');
    expect(p.querySelector('del')!.textContent).toBe('gone');
    expect(p.querySelector('code')!.textContent).toBe('a <b> &amp;');
    expect(p.querySelector('br')).not.toBeNull();
    expect(p.textContent).toContain('next *star* & © A');
  });

  it('renders a code block that scrolls inside itself, with its text as text', () => {
    const root = show('```js\nconst a = "<script>";\n```');
    const pre = root.querySelector('pre.doc-code')!;
    expect(pre.querySelector('code')!.textContent).toBe('const a = "<script>";');
    expect(root.querySelector('script')).toBeNull();
  });

  it('renders quotes, lists with a start, task items and a horizontal rule', () => {
    const root = show('> quoted **text**\n\n- one\n- two\n\n3. three\n4. four\n\n- [ ] open\n- [x] done\n\n---\n\n1. first');
    expect(root.querySelector('blockquote strong')!.textContent).toBe('text');
    const lists = root.querySelectorAll('ul, ol');
    expect(lists[0]!.tagName).toBe('UL');
    expect([...lists[0]!.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect(lists[1]!.tagName).toBe('OL');
    expect(lists[1]!.getAttribute('start')).toBe('3');
    const boxes = within(lists[2] as HTMLElement).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((box) => [box.checked, box.disabled, box.getAttribute('aria-label')])).toEqual([
      [false, true, 'Not done'],
      [true, true, 'Done'],
    ]);
    expect(root.querySelector('hr')).not.toBeNull();
    expect(lists[3]!.getAttribute('start')).toBeNull();
  });

  it('renders a table with its alignment inside a box that scrolls sideways', () => {
    const root = show('| Left | Right | Center |\n| :--- | ---: | :---: |\n| a | **1** | c |');
    const wrap = root.querySelector('.doc-table-wrap')!;
    const table = wrap.querySelector('table')!;
    expect([...table.querySelectorAll('th')].map((th) => [th.textContent, (th as HTMLElement).style.textAlign])).toEqual([
      ['Left', 'left'],
      ['Right', 'right'],
      ['Center', 'center'],
    ]);
    expect(table.querySelector('td strong')!.textContent).toBe('1');
    expect((table.querySelectorAll('td')[1] as HTMLElement).style.textAlign).toBe('right');
  });

  it('renders nothing for a definition and for space, and keeps the referenced link', () => {
    const root = show('See [the site][s].\n\n\n\n[s]: https://example.com/a');
    expect(root.textContent).toBe('See the site (opens in a new tab).');
    expect(root.querySelector('a')!.getAttribute('href')).toBe('https://example.com/a');
  });

  it('shows the raw html of TRIP_V3 as text, with no script or img element', () => {
    const root = show(TRIP_V3);
    expect(root.textContent).toContain('<script>alert("x")</script>');
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('[onerror]')).toBeNull();
    const unsafe = within(root).getByText('link is unsafe');
    expect(unsafe.closest('a')).toBeNull();
    expect(unsafe.getAttribute('title')).toBe('javascript:alert(1)');
  });

  it('shows a block of raw html as text', () => {
    const root = show('<div onclick="x()">hi</div>\n\n<iframe src="https://evil.example"></iframe>');
    expect(root.querySelector('div[onclick]')).toBeNull();
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.textContent).toContain('<div onclick="x()">hi</div>');
    expect(root.textContent).toContain('<iframe src="https://evil.example"></iframe>');
  });

  it('makes javascript:, data:, vbscript:, //host and relative links plain text with the href in the title', () => {
    const hrefs = [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:msgbox',
      '//evil.example/x',
      'relative/path',
      'JaVaScRiPt:alert(2)',
      'javascript&#58;alert(3)',
    ];
    const root = show(hrefs.map((href, index) => `[l${index}](<${href}>)`).join(' '));
    expect(root.querySelector('a')).toBeNull();
    hrefs.forEach((href, index) => expect(within(root).getByText(`l${index}`).getAttribute('title')).toBe(href));
  });

  it('makes http, https, mailto and #/ links clickable, and only the external ones open a new tab', () => {
    const root = show('[h](http://a.example/x) [s](https://b.example/y) [m](mailto:me@example.com) [r](#/runs/run-1) <https://auto.example>');
    const links = within(root).getAllByRole('link');
    const view = links.map((link) => [link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]);
    expect(view).toEqual([
      ['http://a.example/x', '_blank', 'noopener noreferrer nofollow'],
      ['https://b.example/y', '_blank', 'noopener noreferrer nofollow'],
      ['mailto:me@example.com', null, null],
      ['#/runs/run-1', null, null],
      ['https://auto.example', '_blank', 'noopener noreferrer nofollow'],
    ]);
    expect(links[0]!.querySelector('svg')).not.toBeNull();
    expect(links[3]!.querySelector('svg')).toBeNull();
  });

  it('checks the href by the address the browser opens', () => {
    expect(safeHref('https://a.example')).toEqual({
      href: 'https://a.example',
      external: true,
    });
    expect(safeHref('#/docs/2')).toEqual({ href: '#/docs/2', external: false });
    expect(safeHref('java\tscript:alert(1)')).toBeUndefined();
    expect(safeHref(' https://a.example')).toBeUndefined();
    expect(safeHref('https:evil')).toBeUndefined();
    expect(safeHref('#top')).toBeUndefined();
    expect(safeHref('&#104;ttps://a.example')).toEqual({
      href: 'https://a.example',
      external: true,
    });
  });

  it('loads an https image only after a click, without a referrer', () => {
    const root = show('![A map](https://maps.example.com/lisbon.png)');
    expect(root.querySelector('img')).toBeNull();
    const button = within(root).getByRole('button', {
      name: 'Show image: A map (maps.example.com)',
    });
    fireEvent.click(button);
    const img = root.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://maps.example.com/lisbon.png');
    expect(img.getAttribute('alt')).toBe('A map');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(within(root).queryByRole('button')).toBeNull();
  });

  it('shows only the alt text of an image that is not https', () => {
    const root = show('![plain](http://a.example/i.png) ![data](data:image/png;base64,AAAA) ![js](javascript:alert(1))');
    expect(within(root).queryByRole('button')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toBe('plain data js');
  });

  it('shows an image inside a link as its text, so a click never does two things', () => {
    const root = show('[![logo](https://a.example/l.png)](https://a.example)');
    expect(within(root).queryByRole('button')).toBeNull();
    expect(root.querySelector('a')!.textContent).toContain('logo');
  });

  it('renders an empty text as nothing', () => {
    const root = show('');
    expect(root.textContent).toBe('');
    expect(root.children.length).toBe(0);
  });

  it('renders hostile input quickly and without throwing', async () => {
    const cases = [
      '>'.repeat(50_000),
      '*'.repeat(10_000),
      '*a '.repeat(66_667),
      '[x](a '.repeat(3000),
      Array(90).fill(TRIP_V3).join('\n\n').slice(0, 200_000),
    ];
    expect(cases[4]!.length).toBe(200_000);
    for (const text of cases) {
      const started = performance.now();
      const root = show(text);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(root.childNodes.length).toBeGreaterThan(0);
      // the rest of a long text renders in steps after the first paint, and it never throws either.
      await waitFor(() => expect(root.getAttribute('aria-busy')).toBeNull(), { timeout: 30_000 });
      cleanup();
    }
  }, 120_000);

  it('renders a long doc in steps, with the whole text and the heading ids in order at the end', async () => {
    const text = Array.from({ length: 40 }, (_, index) => `## Part\n\n${`Words of part ${index}. `.repeat(100)}`).join('\n\n');
    const root = show(text);
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(root.textContent).not.toContain('Words of part 39.');
    await waitFor(() => expect(root.getAttribute('aria-busy')).toBeNull());
    expect(root.textContent).toContain('Words of part 39.');
    const ids = [...root.querySelectorAll('h3')].map((heading) => heading.id);
    expect(ids).toEqual(['doc-part', ...Array.from({ length: 39 }, (_, index) => `doc-part-${index + 2}`)]);
  });

  it('shows the rest of the text as plain text once the lexer used its time budget', () => {
    const text = `# First\n\n${'a '.repeat(1500)}\n\n# Second\n\n**not bold**`;
    const { container } = render(<>{renderParts(text, 0)}</>);
    expect(container.querySelector('h2')!.textContent).toBe('First');
    expect(container.querySelectorAll('h2').length).toBe(1);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('# Second');
    expect(container.textContent).toContain('**not bold**');
  });

  it('shows a part that the lexer cannot read as plain text', () => {
    const lex = vi.spyOn(Lexer, 'lex').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    try {
      const { container } = render(<Markdown text={'# Title\n\n**bold**'} />);
      expect(container.querySelector('h2')).toBeNull();
      expect(container.textContent).toBe('# Title\n\n**bold**');
    } finally {
      lex.mockRestore();
    }
  });

  it('shows a part with quotes deeper than the cap as plain text without a lex', () => {
    const nodes = renderParts(`${'>'.repeat(30)} too deep`);
    const { container } = render(<>{nodes}</>);
    expect(container.querySelector('blockquote')).toBeNull();
    expect(container.textContent).toBe(`${'>'.repeat(30)} too deep`);
  });

  it('caps the depth of nested quotes and lists and shows the rest as source text', () => {
    const root = show('>'.repeat(40) + ' deep');
    let depth = 0;
    let node: Element | null = root.querySelector('blockquote');
    while (node) {
      depth += 1;
      node = node.querySelector(':scope > blockquote');
    }
    expect(depth).toBeLessThanOrEqual(12);
    expect(root.textContent).toContain('deep');
  });

  it('never sets inner html', () => {
    const root = show('<b>bold?</b> **real**');
    expect(root.querySelector('b')).toBeNull();
    expect(screen.getByText('real').tagName).toBe('STRONG');
  });
});
