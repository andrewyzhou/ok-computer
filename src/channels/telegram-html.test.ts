import { Lexer } from 'marked';
import { describe, expect, it, vi } from 'vitest';
import { htmlToPlain, markdownToHtmlParts } from './telegram-html.js';

const TAGS = ['b', 'i', 's', 'code', 'pre', 'a', 'blockquote'];

// each part must be complete html, so each tag that opens in a part also closes in it.
function balanced(html: string): boolean {
  return TAGS.every((tag) => (html.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length === (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length);
}

describe('markdownToHtmlParts', () => {
  it('turns the usual markdown into the tags that telegram knows', () => {
    const [html] = markdownToHtmlParts(
      ['# Plan for *today*', '', '**bold _it_**, ~~gone~~, `x<y`, [site](https://a.example/?q=1&r="2")', '', '```ts', 'const a = 1 < 2;', '```'].join('\n'),
    );
    expect(html).toBe(
      [
        '<b>Plan for <i>today</i></b>',
        '',
        '<b>bold <i>it</i></b>, <s>gone</s>, <code>x&lt;y</code>, <a href="https://a.example/?q=1&amp;r=&quot;2&quot;">site</a>',
        '',
        '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
      ].join('\n'),
    );
  });

  it('keeps model text from adding a tag, an attribute or a script link', () => {
    const [html] = markdownToHtmlParts('A & B < C, \\*not em\\*, <b onclick=x>raw</b>, [bad](javascript:alert(1)) and <a href="https://evil.example">x</a>');
    expect(html).toBe('A &amp; B &lt; C, *not em*, &lt;b onclick=x&gt;raw&lt;/b&gt;, bad and &lt;a href="https://evil.example"&gt;x&lt;/a&gt;');
  });

  // the references were escaped a second time, so the owner saw "&amp;" where the rich message showed "&".
  it('shows a character reference as its character, but not in code or after a backslash', () => {
    const [html] = markdownToHtmlParts(
      'Tom &amp; Jerry, &copy; 2026, x &lt; y, &#65;&#x42;, &bogus; and \\&amp; **b &amp; c** `a &amp; b` [l](https://a.example/?x=1&amp;y=2)',
    );
    expect(htmlToPlain(html!)).toBe('Tom & Jerry, © 2026, x < y, AB, &bogus; and &amp; b & c a &amp; b l');
    expect(html).toContain('<code>a &amp;amp; b</code>');
    expect(html).toContain('<a href="https://a.example/?x=1&amp;y=2">l</a>');
    // a decoded reference is still escaped, so it cannot make a tag.
    expect(markdownToHtmlParts('&lt;b&gt;x&lt;/b&gt; [s](jav&#97;script:alert(1))')).toEqual(['&lt;b&gt;x&lt;/b&gt; s']);
  });

  it('writes lists, tasks, tables and nested quotes in a form that telegram accepts', () => {
    const [html] = markdownToHtmlParts(['- one', '- two **b**', '  - nested', '', '1. first', '', '- [x] done', '', '> quote', '> > inner', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n'));
    expect(html).toContain('• one\n• two <b>b</b>\n   • nested');
    expect(html).toContain('1. first');
    expect(html).toContain('[x] done');
    // telegram refuses a blockquote inside a blockquote.
    expect(html).toContain('<blockquote>quote\ninner</blockquote>');
    expect(html).toContain('<pre>| a | b |\n|---|---|\n| 1 | 2 |</pre>');
  });

  it('splits between blocks, so no part cuts a tag, and keeps all the text', () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with **bold ${i}** and a [link](https://a.example/${i}).`);
    const parts = markdownToHtmlParts(paragraphs.join('\n\n'), 500);
    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts) {
      expect(htmlToPlain(part).length).toBeLessThanOrEqual(500);
      expect(balanced(part)).toBe(true);
    }
    const joined = parts.join('\n\n');
    for (let i = 0; i < 60; i++) expect(joined).toContain(`<b>bold ${i}</b>`);
  });

  it('cuts a block longer than a part into whole pieces of the same kind', () => {
    const code = Array.from({ length: 400 }, (_, i) => `line ${i} <tag>`).join('\n');
    const parts = markdownToHtmlParts(`Intro.\n\n\`\`\`\n${code}\n\`\`\``, 1000);
    expect(parts[0]).toBe('Intro.');
    for (const part of parts) {
      expect(htmlToPlain(part).length).toBeLessThanOrEqual(1000);
      expect(balanced(part)).toBe(true);
    }
    const pieces = parts.join('\n\n').match(/<pre>[^<]*<\/pre>/g)!;
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.map((piece) => htmlToPlain(piece)).join('\n')).toBe(code);
  });

  // the limit counts the text that telegram shows. text full of escapes was cut far too short when it counted html.
  it('counts the text that telegram shows, not the escapes', () => {
    const parts = markdownToHtmlParts('<'.repeat(3000), 4096);
    expect(parts).toHaveLength(1);
    // the lexer reads parts of 2,000 characters, so a very long line becomes two paragraphs.
    expect(parts[0]!.replace('\n\n', '')).toBe('&lt;'.repeat(3000));
    // a long link has a short visible text, so its block fits and keeps its format.
    const url = `https://a.example/${'y'.repeat(1500)}`;
    expect(markdownToHtmlParts(`See [the page](${url}).`, 1000)).toEqual([`See <a href="${url}">the page</a>.`]);
  });
});

describe('markdownToHtmlParts on hostile text', () => {
  // the lexer took seconds on this text, or overflowed the stack, when it read the whole reply at once.
  it('converts text that is slow for the lexer within a bound, and never throws', () => {
    for (const text of [`${'*'.repeat(32_000)}a`, '> '.repeat(16_000), `${'['.repeat(16_000)}a`, '- '.repeat(16_000)]) {
      const started = performance.now();
      const parts = markdownToHtmlParts(text);
      expect(performance.now() - started).toBeLessThan(1500);
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) expect(htmlToPlain(part).length).toBeLessThanOrEqual(4096);
    }
  });

  it('sends a part that the lexer cannot read as escaped text', () => {
    const lex = vi.spyOn(Lexer, 'lex').mockImplementationOnce(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    expect(markdownToHtmlParts('**a** <b>')).toEqual(['**a** &lt;b&gt;']);
    lex.mockRestore();
  });

  it('turns an image into a link and keeps only http, https and mailto links', () => {
    const [html] = markdownToHtmlParts('![cat](https://x.test/c.png) [p](tg://photo?id=1) [m](mailto:a@x.test) ![x](javascript:alert(1))');
    expect(html).toBe('<a href="https://x.test/c.png">cat</a> p <a href="mailto:a@x.test">m</a> x');
  });
});
