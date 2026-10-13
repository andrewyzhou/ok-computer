import { describe, expect, it } from 'vitest';
import { bodyText } from './mime.js';

const htmlPart = (html: string) => ({ mimeType: 'text/html', body: { data: Buffer.from(html, 'utf8').toString('base64url') } });

describe('bodyText', () => {
  it('removes tags, script and style blocks, and the common entities', () => {
    const html = '<html><head><STYLE type="x">p { color: red }</style></head><body><p>Essay&nbsp;due</p><script>alert(1)</SCRIPT ><b>Friday</b> &amp; &lt;soon&gt;</body></html>';
    expect(bodyText(htmlPart(html)).trim()).toBe('Essay due Friday & <soon>');
    // a block without its close tag ends the text, so its content never shows.
    expect(bodyText(htmlPart('before<script>secret')).trim()).toBe('before');
    // lower case would make this text longer, and the positions of the scan must still fit.
    expect(bodyText(htmlPart('İİ<style>x</style>after')).trim()).toBe('İİafter');
  });

  // the sender writes the html. a quadratic pattern took 8 s on 120 kb of '<', and the whole process stopped.
  it('takes linear time on hostile html', () => {
    for (const html of ['<'.repeat(1_000_000), '<style>'.repeat(200_000), '<script<script'.repeat(100_000), `<a ${'x'.repeat(1_000_000)}`]) {
      const start = performance.now();
      bodyText(htmlPart(html));
      expect(performance.now() - start, html.slice(0, 14)).toBeLessThan(1_000);
    }
  });
});
