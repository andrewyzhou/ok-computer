import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText, mailText, textLinks, tidyText } from './mailtext.js';
import { mailMessage } from './testdata/build.js';
import { CORPUS, corpusMessages } from './testdata/corpus.js';

describe('htmlToText', () => {
  it('keeps the lines of the blocks and puts the cells of a row on one line', () => {
    const { text } = htmlToText('<table><tr><td>Premium plan</td><td>$15.49/month</td></tr><tr><td><b>Total</b></td><td>$15.49</td></tr></table><p>Thanks</p>');
    expect(text).toBe('Premium plan $15.49/month\nTotal $15.49\nThanks');
  });

  it('writes a link after its label and lists the links once each', () => {
    const { text, links } = htmlToText('<p><a href="https://shop.example/a?x=1&amp;y=2">Manage</a> or <a href=\'https://shop.example/a?x=1&y=2\'>again</a></p><a href="https://shop.example/b">https://shop.example/b</a>');
    expect(text).toBe('Manage <https://shop.example/a?x=1&y=2> or again <https://shop.example/a?x=1&y=2>\nhttps://shop.example/b');
    expect(links).toEqual(['https://shop.example/a?x=1&y=2', 'https://shop.example/b']);
  });

  it('drops links that are not http or https, and links with spaces', () => {
    const { text, links } = htmlToText('<a href="javascript:alert(1)">x</a> <a href="mailto:a@b.example">mail</a> <a href="https://a.example/x y">sp</a>');
    expect(links).toEqual([]);
    expect(text).toBe('x mail sp');
  });

  it('leaves out the head, styles, scripts and comments, and keeps image alt text', () => {
    const { text } = htmlToText('<html><head><title>t</title><STYLE>.a{}</STYLE></head><body><!-- hidden --><script>x()</script><img alt="Logo" src="x">Hello</body></html>');
    expect(text).toBe('Logo Hello');
  });

  it('decodes the entities and removes the invisible padding of a preview text', () => {
    const { text } = htmlToText('<span>A new sign-in&zwnj;&nbsp;&#847;&zwnj;</span><p>you don&#39;t &amp; can&#x2019;t &unknown;</p>');
    expect(text).toBe('A new sign-in\nyou don\'t & can’t &unknown;');
  });

  it('takes a lone < as text', () => {
    expect(htmlToText('a < b <i>c</i>').text).toBe('a < b c');
  });

  it('ends the text at a block that never closes', () => {
    expect(htmlToText('before<script>never closes').text).toBe('before');
    expect(htmlToText('before<!-- never closes').text).toBe('before');
  });

  // the sender writes the html, so a hostile shape must not take quadratic time.
  it('reads hostile html in linear time', () => {
    const shapes = ['<'.repeat(200_000) + '>', '<script>'.repeat(50_000), '<a href="https://x.example">'.repeat(30_000), '<!--'.repeat(50_000), `${'<b'.repeat(100_000)}>`];
    for (const html of shapes) {
      const started = performance.now();
      htmlToText(html);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});

describe('mailText', () => {
  it('uses the plain part when it holds the text', () => {
    const message = mailMessage({ id: 'm', headers: {}, plain: 'x'.repeat(10) + ' word'.repeat(60), html: '<p>other</p>' });
    expect(mailText(message)).toMatchObject({ html: false });
  });

  it('uses the html part when the plain part is a stub', () => {
    const message = mailMessage({ id: 'm', headers: {}, plain: 'View this mail in your browser.', html: '<p>Total charged: $15.49</p>' });
    expect(mailText(message)).toEqual({ text: 'Total charged: $15.49', links: [], html: true });
  });

  it('reads an html-only mail and cuts the text to the limit', () => {
    const message = mailMessage({ id: 'm', headers: {}, html: `<p>${'a'.repeat(50)}</p>` });
    expect(mailText(message, 10).text).toBe('a'.repeat(10));
  });

  it('gives an empty text for a mail without a text part', () => {
    expect(mailText({ id: 'm', payload: { mimeType: 'multipart/mixed', parts: [] } })).toEqual({ text: '', links: [], html: false });
  });

  it('skips a file part that is html', () => {
    const message = mailMessage({ id: 'm', headers: {}, plain: 'hello' });
    message.payload = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/html', filename: 'page.html', body: { data: Buffer.from('<p>file</p>').toString('base64url') } }, message.payload!] };
    expect(mailText(message).text).toBe('hello');
  });

  it('reads every mail of the corpus', () => {
    for (const { mail, message } of corpusMessages().values()) {
      const text = mailText(message).text;
      expect(text.length, mail.name).toBeGreaterThan(0);
      expect(text, mail.name).not.toMatch(/<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i);
    }
    expect(corpusMessages().size).toBe(CORPUS.length);
  });

  it('keeps the cancel link of an html receipt in the text', () => {
    const { message } = corpusMessages().get('monthly plan receipt, html only')!;
    const { text, links } = mailText(message);
    expect(text).toContain('<https://streamly.example/account/cancel>');
    expect(links).toEqual(['https://streamly.example/account/cancel']);
  });
});

describe('the small helpers', () => {
  it('decodeEntities drops a code point that is not a character', () => {
    expect(decodeEntities('a&#xD800;b&#1114112;c&#160;d')).toBe('ab' + 'c d');
  });

  it('tidyText keeps at most one empty line in a row', () => {
    expect(tidyText('  a \t b \n\n\n\n c \r\n​\n')).toBe('a b\n\nc');
  });

  it('textLinks finds the links of plain text without the closing marks', () => {
    expect(textLinks('see https://a.example/x. and (https://b.example/y) and https://a.example/x')).toEqual(['https://a.example/x', 'https://b.example/y']);
  });
});
