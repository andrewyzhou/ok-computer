// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { docLinksIn } from './DocLinkCard';
import { Markdown, renderParts, safeHref } from './Markdown';

// tests that try to break the safe markdown with text that a hostile mail could put in a doc.

afterEach(cleanup);

const show = (text: string) => render(<Markdown text={text} />).container.querySelector('.doc-markdown') as HTMLElement;

// every href and src on the page. none may run script or load a page by itself.
function addresses(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[href], [src], [srcset], [action], [formaction]')].flatMap((element) =>
    ['href', 'src', 'srcset', 'action', 'formaction'].map((name) => element.getAttribute(name)).filter((value): value is string => value !== null),
  );
}

describe('the safe href against hidden schemes', () => {
  it('refuses each address that hides a scheme or leaves the app', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'javascript&colon;alert(1)',
      '&#106;avascript:alert(1)',
      '&#x6A;avascript:alert(1)',
      'java&#x09;script:alert(1)',
      'java&#10;script:alert(1)',
      ' javascript:alert(1)',
      '\u0000javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      '//evil.example',
      '\\\\evil.example',
      'https:evil.example',
      'https:/evil.example',
      'mailto://evil.example',
      '#javascript:alert(1)',
      '/api/docs/1/export',
      'https://a.example/&#32;x',
      'https://a.example/\u007f',
    ]) {
      expect(safeHref(bad), bad).toBeUndefined();
    }
    expect(safeHref('#/docs/2')).toEqual({ href: '#/docs/2', external: false });
    expect(safeHref('HTTPS://A.example/x')).toEqual({ href: 'HTTPS://A.example/x', external: true });
    expect(safeHref('mailto:dana@example.com')).toEqual({ href: 'mailto:dana@example.com', external: false });
  });
});

describe('the markdown against hostile text', () => {
  it('shows raw html as text and makes no element of it', () => {
    const root = show(
      [
        '<script>alert(1)</script>',
        '',
        'Text <img src=x onerror="alert(1)"> and <a href="javascript:alert(1)">click</a> and <iframe src="https://evil.example"></iframe>',
        '',
        '<details open ontoggle=alert(1)><summary>x</summary></details>',
        '',
        '<svg><script>alert(1)</script></svg>',
        '',
        '<style>body { display: none }</style>',
        '',
        '<form action="https://evil.example"><button formaction="https://evil.example">Go</button></form>',
      ].join('\n'),
    );
    expect(root.querySelector('script, img, iframe, details, svg, style, form, button, a')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
    expect(root.textContent).toContain('onerror="alert(1)"');
    expect(addresses(root)).toEqual([]);
    for (const element of root.querySelectorAll('*')) {
      for (const attribute of element.attributes) expect(attribute.name.startsWith('on'), attribute.name).toBe(false);
    }
  });

  it('makes no live link of a javascript address in any link form', () => {
    const root = show(
      [
        '[inline](javascript:alert(1))',
        '[angle](<javascript:alert(1)>)',
        '[ref][evil]',
        '<javascript:alert(1)>',
        '[entity](javascript&colon;alert(1))',
        '[tab](java&#9;script:alert(1))',
        '[data](data:text/html,x)',
        '[proto](//evil.example/x)',
        '',
        '[evil]: javascript:alert(1)',
      ].join('\n'),
    );
    expect(root.querySelector('a')).toBeNull();
    expect(addresses(root)).toEqual([]);
    expect(root.textContent).toContain('inline');
  });

  it('opens an external link in a new tab without the opener or the referrer', () => {
    const root = show('[site](https://a.example/x?y=1) and www.example.com and https://b.example');
    const links = [...root.querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^https?:\/\//);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.getAttribute('rel')).toContain('noreferrer');
    }
  });

  it('loads no image with the page, and loads only an https image after a click', () => {
    const root = show(['![pixel](https://track.example/p.png?u=owner)', '![plain](http://track.example/p.png)', '![data](data:image/png;base64,AAAA)', '![svg](javascript:alert(1))'].join('\n\n'));
    expect(root.querySelector('img')).toBeNull();
    expect(addresses(root)).toEqual([]);
    const buttons = root.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    const image = root.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('https://track.example/p.png?u=owner');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('never takes the id of a part of the app with a heading', () => {
    const root = show('# root\n\n# __proto__\n\n# constructor\n\n# <script>');
    for (const heading of root.querySelectorAll('[id]')) expect(heading.id.startsWith('doc-'), heading.id).toBe(true);
  });

  it('renders very deep lists and quotes without a throw', () => {
    const deepList = Array.from({ length: 200 }, (_, index) => `${'  '.repeat(index)}- level ${index}`).join('\n');
    const deepQuote = `${'>'.repeat(3_000)} deep`;
    const nested = `${'['.repeat(2_000)}x${']'.repeat(2_000)}`;
    const emphasis = '*a '.repeat(20_000);
    for (const text of [deepList, deepQuote, nested, emphasis]) {
      expect(() => renderParts(text, 200)).not.toThrow();
    }
    expect(() => show(deepQuote)).not.toThrow();
  });

  it('shows the whole text of a long hostile doc, part by part', () => {
    const text = Array.from({ length: 300 }, (_, index) => `Line ${index} <b>x</b> [l](javascript:alert(${index}))`).join('\n\n');
    const parts = renderParts(text, 5_000);
    const root = render(<div>{parts}</div>).container;
    expect(root.textContent).toContain('Line 0 ');
    expect(root.textContent).toContain('Line 299 ');
    expect(root.querySelector('a, b')).toBeNull();
  });
});

describe('the doc links in a chat reply', () => {
  it('finds each doc once and leaves out look-alikes', () => {
    const text = [
      'Trip plan is ready: http://127.0.0.1:4318/#/docs/3',
      'old version #/docs/3?version=1',
      'not a doc #/docs/03 #/docs/4x #/docs/5/edit #/docs/0',
      'other host https://evil.example/#/docs/7?version=2',
      `huge #/docs/${'9'.repeat(30)}`,
    ].join('\n');
    expect(docLinksIn(text)).toEqual([{ id: 3 }, { id: 7, version: 2 }]);
  });
});
