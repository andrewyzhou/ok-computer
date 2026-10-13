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

  // markdown decodes a backslash escape and a character reference in a link destination, so these are tg: and attach:.
  it('breaks a scheme with an escaped colon or a letter as a character reference', () => {
    expect(safe(String.raw`[o](tg\://resolve)`)).toBe(String.raw`[o](tg` + Z + String.raw`\://resolve)`);
    expect(safe(String.raw`[o](attach\://file)`)).toBe(String.raw`[o](attach` + Z + String.raw`\://file)`);
    expect(safe('[o](&#116;g://resolve)')).toBe(`[o](&#116;g${Z}://resolve)`);
    expect(safe('[o](t&#x67;://resolve)')).toBe(`[o](t&#x67;${Z}://resolve)`);
    expect(safe('[o](t&#103;://x) [p](att&#x61;ch://y) [q](&#84;G&#58;//z)')).toBe(`[o](t&#103;${Z}://x) [p](att&#x61;ch${Z}://y) [q](&#84;G${Z}&#58;//z)`);
    expect(neutralizeMarkdown('&#116;g: att&#x61;ch:').neutralized).toEqual(['tg:', 'attach:']);
    // a longer word that ends in tg is not the scheme.
    expect(safe('xtg://a')).toBe('xtg://a');
  });

  it('leaves text, allowed tags and autolinks as they are', () => {
    const text = '**bold** <u>under</u> <details><summary>more</summary>x</details> <tg-spoiler>s</tg-spoiler> <https://x.test> 2 < 3 > 1';
    expect(neutralizeMarkdown(text)).toEqual({ text, neutralized: [] });
  });

  // the scanner once kept the lines of a fence as they were. each input below made the scanner and a markdown
  // parser disagree on where the fence ended, so a live tag passed as code.
  it('changes the text in a code fence too, because only a full parser knows where a fence ends', () => {
    const IMG = '<img src="https://x.test/p.png?d=1">';
    const F = '```';
    const inputs = [
      [F, '<img>', F],
      [` ${F}`, F, IMG, F],
      ['  ~~~', '~~~', '<tg-button data="approval:1:approve">OK</tg-button>', '~~~'],
      [F, 'x', `${F}\u00a0`, F, IMG, F],
      [F, 'x', `${F}\u2003`, F, IMG, F],
      [F, `${F}\r`, IMG, F],
      ['<details>', '\u00a0', F, IMG, F],
      ['- item', `  ${F}`, 'x', `  ${F}`, F, IMG, F],
      [F, '![x](https://x.test/p.png)', F],
    ].map((lines) => lines.join('\n'));
    for (const input of inputs) {
      const result = neutralizeMarkdown(input);
      expect(result.neutralized.length, JSON.stringify(input)).toBeGreaterThan(0);
      expect(result.text, JSON.stringify(input)).not.toMatch(/<(?:img|tg-button)|!\[/);
    }
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

  // a cut at an earlier blank line keeps the lines after it, and the next line could then make the part too long.
  it('keeps each part within the limit after a cut at an earlier blank line', () => {
    const parts = splitMarkdown(`aaaaa\n\n${'b'.repeat(60)}\n${'c'.repeat(60)}\nd`, 100);
    expect(parts.map((part) => part.length)).toEqual([5, 60, 62]);
    let seed = 7;
    const next = (n: number) => (seed = (seed * 48_271) % 2_147_483_647) % n;
    const pieces = ['', '```', '```ts', '~~~', '- item'];
    for (let round = 0; round < 3000; round++) {
      const lines = Array.from({ length: 1 + next(12) }, () => (next(3) === 0 ? pieces[next(pieces.length)]! : 'x'.repeat(next(130))));
      for (const part of splitMarkdown(lines.join('\n'), 100)) expect(part.length).toBeLessThanOrEqual(100);
    }
  });
});
