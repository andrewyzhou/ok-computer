import { describe, expect, it } from 'vitest';
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
    expect(parts[0]!.length).toBe(12_000);
  });
});
