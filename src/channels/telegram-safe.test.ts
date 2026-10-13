import { describe, expect, it } from 'vitest';
import { neutralizeMarkdown, splitMarkdown } from './telegram-safe.js';

const Z = '​';
const safe = (text: string) => neutralizeMarkdown(text).text;

describe('neutralizeMarkdown', () => {
  it('breaks each tag that is not on the allow-list, also in upper case and with spaces', () => {
    const cases: Array<[string, string]> = [
      ['<tg-button type="callback_data" data="approval:1:approve">OK</tg-button>', `<${Z}tg-button type="callback_data" data="approval:1:approve">OK<${Z}/tg-button>`],
      ['<tg-map lat="1" lon="2"/>', `<${Z}tg-map lat="1" lon="2"/>`],
      ['<tg-collage><img src="https://x.test/a.png"></tg-collage>', `<${Z}tg-collage><${Z}img src="https://x.test/a.png"><${Z}/tg-collage>`],
      ['<video src="https://x.test/v.mp4">', `<${Z}video src="https://x.test/v.mp4">`],
      ['<a href="https://x.test">x</a>', `<${Z}a href="https://x.test">x<${Z}/a>`],
      ['<tg-foo>new</tg-foo>', `<${Z}tg-foo>new<${Z}/tg-foo>`],
      ['<IMG SRC="https://x.test/a.png">', `<${Z}IMG SRC="https://x.test/a.png">`],
      ['< img src=x>', `<${Z} img src=x>`],
      ['< / tg-button >', `<${Z} / tg-button >`],
      ['<img\nsrc=x>', `<${Z}img\nsrc=x>`],
      ['<!-- hidden -->', `<${Z}!-- hidden -->`],
      ['<?php ?>', `<${Z}?php ?>`],
    ];
    for (const [input, output] of cases) expect(safe(input), input).toBe(output);
    expect(neutralizeMarkdown(cases[0]![0]).neutralized).toEqual(['<tg-button>', '<tg-button>']);
  });

  it('turns an image into a link, and breaks tg:// and attach:// links, also with an entity for the colon', () => {
    expect(safe('![x](https://x.test/a.png)')).toBe(`!${Z}[x](https://x.test/a.png)`);
    expect(safe('[photo](tg://photo?id=1)')).toBe(`[photo](tg${Z}://photo?id=1)`);
    expect(safe('[photo](TG://photo?id=1)')).toBe(`[photo](TG${Z}://photo?id=1)`);
    expect(safe('[file](attach://file1)')).toBe(`[file](attach${Z}://file1)`);
    expect(safe('[p](tg&colon;//photo) [q](tg&#58;//x) [r](tg&#x3A;//y)')).toBe(`[p](tg${Z}&colon;//photo) [q](tg${Z}&#58;//x) [r](tg${Z}&#x3A;//y)`);
    expect(neutralizeMarkdown('![x](u) tg://a').neutralized).toEqual(['![', 'tg:']);
  });

  it('leaves text, allowed tags and autolinks as they are', () => {
    const text = '**bold** <u>under</u> <details><summary>more</summary>x</details> <tg-spoiler>s</tg-spoiler> <https://x.test> 2 < 3 > 1';
    expect(neutralizeMarkdown(text)).toEqual({ text, neutralized: [] });
  });

  it('leaves a closed code fence as it is', () => {
    const text = 'Here is code:\n```ts\nconst a: Array<T> = [];\nconst h = "<img src=x> <u> <details> <tg-spoiler> ![i](u) tg://x";\n```\nAfter <img>.';
    expect(safe(text)).toBe(text.replace('After <img>', `After <${Z}img>`));
    expect(safe('~~~\n<img>\n~~~')).toBe('~~~\n<img>\n~~~');
  });

  it('does not exempt an unclosed fence, an inline code span, or a fence that markdown would not see as code', () => {
    expect(safe('```\n<img src=x>')).toBe(`\`\`\`\n<${Z}img src=x>`);
    expect(safe('`<tg-button>`')).toBe(`\`<${Z}tg-button>\``);
    // a fence inside a list item ends with the item, so the tag after it is html at the top level.
    expect(safe('- item\n  ```\n<img src=x>\n  ```')).toBe(`- item\n  \`\`\`\n<${Z}img src=x>\n  \`\`\``);
    // the lines of an html block stay raw until a blank line, and a <pre> block stays raw until </pre>.
    expect(safe('<details>\n```\n<img src=x>\n```')).toBe(`<details>\n\`\`\`\n<${Z}img src=x>\n\`\`\``);
    expect(safe('<pre>\n\n```\n<img src=x>\n```\n</pre>')).toBe(`<pre>\n\n\`\`\`\n<${Z}img src=x>\n\`\`\`\n</pre>`);
    // backticks after a backtick fence make the line inline code.
    expect(safe('```a`b\n<img src=x>\n```')).toBe(`\`\`\`a\`b\n<${Z}img src=x>\n\`\`\``);
    // a closing fence must be at least as long as the opening one.
    expect(safe('````\n<img>\n```')).toBe(`\`\`\`\`\n<${Z}img>\n\`\`\``);
  });

  it('exempts a fence after an html block that a blank line closed', () => {
    expect(safe('<details>x</details>\n\n```\n<img>\n```')).toBe('<details>x</details>\n\n```\n<img>\n```');
  });

  it('takes linear time on hostile text', () => {
    for (const text of [`<${' '.repeat(32_000)}`, '<a'.repeat(32_000), `<${'a'.repeat(32_000)}:`, '~~~~~\n'.repeat(5_000), '<a\n'.repeat(16_000)]) {
      const started = performance.now();
      neutralizeMarkdown(text);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});

describe('splitMarkdown', () => {
  it('keeps a short text as one part', () => {
    expect(splitMarkdown('hello', 100)).toEqual(['hello']);
  });

  it('cuts at a blank line, and closes and opens a fence again at a cut', () => {
    const text = `intro\n\n\`\`\`ts\n${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\n\`\`\`\n\nend`;
    const parts = splitMarkdown(text, 100);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(100);
      expect((part.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(parts[0]).toBe('intro');
    expect(parts[1]!.startsWith('```ts\nline 0')).toBe(true);
    expect(parts[2]!.startsWith('```ts\n')).toBe(true);
    expect(parts.join('\n').replace(/\n```\n```ts/g, '')).toContain('line 29\n```');
  });

  it('adds no fence at a cut after a fence that closed', () => {
    const text = `\`\`\`\ncode\n\`\`\`\n${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}`;
    const parts = splitMarkdown(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('\n')).toBe(text);
  });

  it('never cuts a surrogate pair in a long line', () => {
    const line = `${'x'.repeat(91)}😀${'y'.repeat(50)}`;
    const parts = splitMarkdown(line, 100);
    expect(parts.join('')).toBe(line);
    for (const part of parts) expect(part).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
  });
});
