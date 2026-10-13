import { Lexer, type Token, type Tokens } from 'marked';
import { splitMarkdown } from './telegram-safe.js';
import { splitMessage, TELEGRAM_LIMIT } from './telegram.js';

// telegram html knows only a few tags. every other text is escaped, so the model text cannot add a tag or an
// attribute.
export const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttribute = (text: string) => escapeHtml(text).replaceAll('"', '&quot;');
const SAFE_HREF = /^(https?:|mailto:)/i;

// the text that telegram shows, without tags. its limit counts this text, not the html.
export const htmlToPlain = (html: string) =>
  html.replace(/<[^>]*>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');

// the lexer gets parts of this size. it takes quadratic time on some text and can overflow the stack on deep quotes,
// and the model writes the text. a part of this size takes some milliseconds in the worst case.
const LEX_LIMIT = 2000;

// the fallback converts each top-level block on its own, so each block is complete html. a part then holds whole
// blocks, and a cut never falls inside a tag. a block that is longer than one part loses its inline format and is cut
// as plain text. a part that the lexer cannot read becomes escaped text.
export function markdownToHtmlParts(markdown: string, limit = TELEGRAM_LIMIT): string[] {
  const blocks = splitMarkdown(markdown, LEX_LIMIT)
    .flatMap((part) => {
      try {
        return Lexer.lex(part).map((token) => {
          const code = token.type === 'code';
          return { html: block(token, false), code, plain: code ? (token as Tokens.Code).text : plainText(token) };
        });
      } catch {
        return [{ html: escapeHtml(part), code: false, plain: part }];
      }
    })
    .filter((each) => each.html !== '');
  const parts: string[] = [];
  let current = '';
  let shown = 0;
  const push = (html: string) => {
    const length = htmlToPlain(html).length;
    if (current && shown + 2 + length <= limit) {
      current += `\n\n${html}`;
      shown += 2 + length;
    } else {
      if (current) parts.push(current);
      current = html;
      shown = length;
    }
  };
  for (const { html, code, plain } of blocks) {
    if (htmlToPlain(html).length <= limit) {
      push(html);
      continue;
    }
    for (const piece of splitMessage(plain, limit)) {
      push(code ? `<pre>${escapeHtml(piece)}</pre>` : escapeHtml(piece));
    }
  }
  if (current) parts.push(current);
  return parts;
}

// telegram refuses a blockquote inside a blockquote, so a nested quote keeps only its text.
function block(token: Token, quoted: boolean): string {
  switch (token.type) {
    case 'paragraph':
    case 'text':
      return inline(token);
    case 'heading':
      return `<b>${inline(token)}</b>`;
    case 'code': {
      const code = token as Tokens.Code;
      const language = code.lang?.match(/^[\w+-]+/)?.[0];
      return language
        ? `<pre><code class="language-${language}">${escapeHtml(code.text)}</code></pre>`
        : `<pre>${escapeHtml(code.text)}</pre>`;
    }
    case 'blockquote': {
      const inner = blocks((token as Tokens.Blockquote).tokens, true);
      return quoted ? inner : `<blockquote>${inner}</blockquote>`;
    }
    case 'list': {
      const list = token as Tokens.List;
      const start = typeof list.start === 'number' ? list.start : 1;
      return list.items
        .map((item, i) => {
          const mark = item.task ? (item.checked ? '[x]' : '[ ]') : list.ordered ? `${start + i}.` : '•';
          const body = blocks(item.tokens.filter((child) => child.type !== 'checkbox'), quoted);
          return `${mark} ${body.replaceAll('\n', '\n   ')}`;
        })
        .join('\n');
    }
    // telegram html has no table. the source text in a monospace block keeps the columns readable.
    case 'table':
      return `<pre>${escapeHtml(token.raw.trimEnd())}</pre>`;
    case 'hr':
      return '———';
    case 'space':
    case 'def':
      return '';
    default:
      return escapeHtml(token.raw.trim());
  }
}

const blocks = (tokens: Token[], quoted: boolean) =>
  tokens
    .map((token) => block(token, quoted))
    .filter(Boolean)
    .join('\n');

function inline(token: Token): string {
  const children = 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : undefined;
  const inner = () => (children ? children.map(inline).join('') : escapeHtml('text' in token ? String(token.text) : token.raw));
  switch (token.type) {
    case 'strong':
      return `<b>${inner()}</b>`;
    case 'em':
      return `<i>${inner()}</i>`;
    case 'del':
      return `<s>${inner()}</s>`;
    case 'codespan':
      return `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`;
    case 'br':
      return '\n';
    case 'link': {
      const link = token as Tokens.Link;
      // a link to another scheme, for example javascript: or tg:, keeps only its text.
      return SAFE_HREF.test(link.href) ? `<a href="${escapeAttribute(link.href)}">${inner()}</a>` : inner();
    }
    // an image becomes a link, so the telegram servers do not fetch it before the owner clicks. the adapter turns
    // off the link preview, which would fetch the link too.
    case 'image': {
      const image = token as Tokens.Image;
      const text = escapeHtml(image.text || image.href);
      return SAFE_HREF.test(image.href) ? `<a href="${escapeAttribute(image.href)}">${text}</a>` : text;
    }
    // raw html from the model is text, never a tag.
    case 'html':
      return escapeHtml(token.raw);
    default:
      return inner();
  }
}

function plainText(token: Token): string {
  const children = 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : undefined;
  if (children) return children.map(plainText).join('');
  if (token.type === 'list') return (token as Tokens.List).items.map((item) => item.text).join('\n');
  return 'text' in token ? String(token.text) : token.raw;
}
