import type { gmail_v1 } from '@googleapis/gmail';
import { headOf } from '../text.js';

// the text of a mail for the inbox jobs. much real mail is html only, and bodyText of src/google/mime.ts turns html
// into one long line without the links. the jobs need the lines of a receipt, the dates of a deadline and the links of
// a plan, so this module keeps the line breaks of the blocks, decodes the entities and writes each link after its
// label as <url>. the mail is untrusted, so each step takes linear time in the size of the html.

export interface MailText {
  // the text, with one line for each block of the html. it is cut to the limit that the caller gave.
  text: string;
  // the http and https links of the html, in order, each one time. a plain text mail gives the links of its text.
  links: string[];
  // true when the text came from the html part.
  html: boolean;
}

// a plain part with fewer letters than this is a stub such as "view this mail in a browser", so the html is used.
const STUB_LETTERS = 200;
// the most links that one mail gives.
const LINK_LIMIT = 200;
const LINK_LENGTH = 2000;

// the tags that start a new line. a cell of a table gives a space, so a row of a receipt stays on one line.
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'center', 'dd', 'div', 'dl', 'dt', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'tfoot', 'thead', 'title', 'tr', 'ul']);
const CELL = new Set(['td', 'th']);
// the tags whose content is never text. a block without its close tag ends the text, as in bodyText.
const SKIPPED = new Set(['script', 'style', 'head', 'noscript', 'template', 'svg']);

const NAMED: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  times: '×',
  zwnj: '',
  zwj: '',
  shy: '',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
};

// the characters that senders put in the preview text to pad it. they carry no meaning.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁪-⁯ㅤ﻿ﾠ]/g;

// decodeEntities decodes the named entities above and every numeric entity. an unknown name stays as it is.
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return code === 0xa0 ? ' ' : String.fromCodePoint(code);
    }
    const value = NAMED[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

// the lines of a text without the invisible padding, with single spaces and at most one empty line in a row.
export function tidyText(text: string): string {
  const lines = text
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim());
  const out: string[] = [];
  for (const line of lines) if (line || (out.length && out[out.length - 1] !== '')) out.push(line);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

// a link of the html that the jobs may read: http or https, without spaces, at most 2,000 characters.
function linkOf(raw: string): string | undefined {
  const link = decodeEntities(raw).trim();
  if (link.length > LINK_LENGTH || /\s/.test(link) || !/^https?:\/\//i.test(link)) return undefined;
  return link;
}

// htmlToText turns html into lines of text and keeps its links. a link whose label is not the link itself is written
// after the label as <url>, so a check that a link is in the text of the mail finds it.
export function htmlToText(html: string): { text: string; links: string[] } {
  let out = '';
  const links: string[] = [];
  const seen = new Set<string>();
  const keep = (link: string) => {
    if (seen.has(link) || links.length >= LINK_LIMIT) return;
    seen.add(link);
    links.push(link);
  };
  let href: string | undefined;
  let label = '';
  let at = 0;
  let lineStart = true;
  // the next '>' after a position. the positions only grow, so the search starts again only when the scan passed the
  // last one it found, and the whole scan reads each character a few times at most.
  let closeAt = -1;
  const closeAfter = (from: number) => {
    if (closeAt !== html.length && closeAt < from) {
      const found = html.indexOf('>', from);
      closeAt = found < 0 ? html.length : found;
    }
    return closeAt === html.length ? -1 : closeAt;
  };
  while (at < html.length) {
    const open = html.indexOf('<', at);
    const text = open < 0 ? html.slice(at) : html.slice(at, open);
    out += text;
    if (/\S/.test(text)) lineStart = false;
    if (href !== undefined) label += text;
    if (open < 0) break;
    // a comment ends at its own close, and one without a close ends the text.
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      if (close < 0) break;
      at = close + 3;
      continue;
    }
    // a '<' that no letter, '/', '!' or '?' follows is text, as an html parser reads it: "Orders < $50" keeps its words.
    if (!/[a-z/!?]/i.test(html[open + 1] ?? '')) {
      out += '<';
      lineStart = false;
      if (href !== undefined) label += '<';
      at = open + 1;
      continue;
    }
    const close = closeAfter(open + 1);
    if (close < 0) break;
    // a second '<' before the '>' means that the first one was text.
    const next = html.indexOf('<', open + 1);
    if (next >= 0 && next < close) {
      out += '<';
      lineStart = false;
      if (href !== undefined) label += '<';
      at = open + 1;
      continue;
    }
    const tag = html.slice(open + 1, close);
    at = close + 1;
    const name = (/^\/?\s*([a-z][a-z0-9]*)/i.exec(tag)?.[1] ?? '').toLowerCase();
    const closing = tag.trimStart().startsWith('/');
    if (!closing && SKIPPED.has(name) && !tag.trimEnd().endsWith('/')) {
      // the search is case blind without a lower-case copy of the html, which could change its length.
      const end = new RegExp(`</${name}`, 'gi');
      end.lastIndex = at;
      const found = end.exec(html);
      if (!found) break;
      const after = closeAfter(end.lastIndex);
      if (after < 0) break;
      at = after + 1;
      continue;
    }
    if (name === 'a') {
      if (!closing) {
        const match = HREF.exec(tag);
        href = match ? linkOf(match[1] ?? match[2] ?? match[3] ?? '') : undefined;
        label = '';
        if (href) keep(href);
        else href = undefined;
      } else if (href !== undefined) {
        const shown = decodeEntities(label).trim();
        if (shown !== href) {
          out += ` <${href}>`;
          lineStart = false;
        }
        href = undefined;
        label = '';
      }
      continue;
    }
    if (name === 'img') {
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const value = alt ? (alt[1] ?? alt[2] ?? '').trim() : '';
      if (value) {
        out += ` ${value} `;
        lineStart = false;
      }
      continue;
    }
    // a br always ends a line, so two of them give an empty line. the edge of another block ends the line only when
    // the line holds text, so the close of one row and the open of the next give one line break.
    if (name === 'br' || (BLOCK.has(name) && !lineStart)) {
      out += '\n';
      lineStart = true;
    } else if (CELL.has(name)) out += ' ';
  }
  return { text: tidyText(decodeEntities(out)), links };
}

// the http and https links of a plain text, in order, each one time.
export function textLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const link = match[0].replace(/[.,;:!?]+$/, '');
    if (link.length <= LINK_LENGTH && !links.includes(link)) links.push(link);
    if (links.length >= LINK_LIMIT) break;
  }
  return links;
}

function findPart(part: gmail_v1.Schema$MessagePart | undefined | null, mimeType: string): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType?.toLowerCase() === mimeType && part.body?.data && !part.filename) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

const decode = (part: gmail_v1.Schema$MessagePart) => Buffer.from(part.body?.data ?? '', 'base64url').toString('utf8');
const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

// mailText gives the text of a message, cut to limit characters. it uses the plain part, unless the plain part is a
// stub and the message has an html part. a message with neither gives an empty text.
export function mailText(message: gmail_v1.Schema$Message, limit = Number.POSITIVE_INFINITY): MailText {
  const plain = findPart(message.payload, 'text/plain');
  const html = findPart(message.payload, 'text/html');
  const plainText = plain ? tidyText(decode(plain)) : '';
  if (plain && (!html || letters(plainText) >= STUB_LETTERS)) {
    return { text: Number.isFinite(limit) ? headOf(plainText, limit) : plainText, links: textLinks(plainText), html: false };
  }
  if (html) {
    const converted = htmlToText(decode(html));
    return { text: Number.isFinite(limit) ? headOf(converted.text, limit) : converted.text, links: converted.links, html: true };
  }
  return { text: '', links: [], html: false };
}
