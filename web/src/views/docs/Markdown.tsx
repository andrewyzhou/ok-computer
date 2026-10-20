import { Lexer, type MarkedOptions, type Token, type Tokens } from 'marked';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { splitMarkdown } from '../../../../src/channels/telegram-safe';
import { linkSignal } from '../../../../src/policy/link-signal';
import { Icon } from '../../icons';

// the safe markdown of a doc. the model writes the text, so the renderer makes react elements from the tokens of
// marked and never sets html: raw html shows as text, an image loads only after a click, and only an http(s), mailto
// or #/ link is clickable. the text goes to the lexer in parts of LEX_LIMIT characters, because the lexer takes
// quadratic time on some text and can overflow the stack on deep quotes. a part that the lexer cannot read shows as
// plain text, so the renderer never throws.

const LEX_LIMIT = 2000;

// a quote or a list deeper than this shows its source as text. a deep tree reads badly, and each level costs a frame
// of the stack.
const MAX_DEPTH = 12;

// the options of the lexer are fixed here, so a change to the global options of marked elsewhere does not reach the
// docs.
const LEX_OPTIONS: MarkedOptions = {
  gfm: true,
  breaks: false,
  pedantic: false,
  async: false,
};

// marked decodes a numeric character reference in text, but it keeps a named one. the table has the names that a
// model writes, and other names stay as text. a reference in a link destination is decoded too, because the check
// of the scheme must read the address that the browser opens.
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  larr: '←',
  rarr: '→',
  ne: '≠',
  le: '≤',
  ge: '≥',
  colon: ':',
};

export function decodeReferences(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (ref, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name] ?? ref;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
  });
}

// the kinds of address that a doc may open. a hash of the web app stays on the page, and an http(s) or mailto address
// is external. every other address, for example javascript:, data:, vbscript:, //host or a relative path, gives
// undefined.
export type SafeHref = { href: string; external: boolean };

export function safeHref(raw: string): SafeHref | undefined {
  const href = decodeReferences(raw);
  // a control character or a space can hide a scheme from a check that reads the text.
  if (/[\u0000- \u007f]/.test(href)) return undefined;
  if (href.startsWith('#/')) return { href, external: false };
  if (/^mailto:[^/]/i.test(href)) return { href, external: false };
  if (!/^https?:\/\/[^/]/i.test(href)) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? { href, external: true } : undefined;
  } catch {
    return undefined;
  }
}

// a version that a tainted session wrote can hold a link that carries the owner's data out, for example
// https://evil.example/c?d=<data>. the reply guard judges such a link in a chat reply, but it lets a doc link through,
// so the reader judges the links of a tainted version itself, with the same test (linkSignal of link-signal.ts). a
// mailto address can carry data in its address and its body, so a tainted version opens none. heldReason gives the
// reason that a link of a tainted version does not open, or undefined when it can open.
export function heldReason(safe: SafeHref, tainted: boolean): string | undefined {
  if (!tainted || safe.href.startsWith('#/')) return undefined;
  if (/^mailto:/i.test(safe.href)) return 'a mail link of a doc written after reading outside content does not open';
  try {
    const signal = linkSignal(new URL(safe.href));
    return signal ? `this link can carry data out (${signal}), and the doc was written after reading outside content` : undefined;
  } catch {
    return 'the address cannot be read';
  }
}

// a link that does not open shows its text and its full address as text, so the owner can still read the address and
// copy it on purpose.
function HeldLink({ href, reason, children }: { href: string; reason: string; children: ReactNode }) {
  // an autolink such as <https://a.example/?d=1> has the address as its text, so the address shows once.
  const text = Array.isArray(children) && children.length === 1 ? children[0] : children;
  const same = typeof text === 'string' && decodeReferences(text) === href;
  return (
    <span className="doc-held-link" title={reason}>
      {same ? null : <>{children} </>}
      <span className="doc-held-url">{same ? href : `(${href})`}</span>
      <span className="sr-only"> (link not opened: {reason})</span>
    </span>
  );
}

// a link of a doc. an unsafe address shows its text, with the address in the tooltip, so the owner still sees it.
// tainted is true for a version that a tainted session wrote.
export function DocAnchor({ href, tainted = false, children }: { href: string; tainted?: boolean; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe)
    return (
      <span className="doc-unsafe-link" title={href}>
        {children}
      </span>
    );
  const held = heldReason(safe, tainted);
  if (held)
    return (
      <HeldLink href={safe.href} reason={held}>
        {children}
      </HeldLink>
    );
  if (!safe.external) return <a href={safe.href}>{children}</a>;
  return (
    <a href={safe.href} target="_blank" rel="noopener noreferrer nofollow" className="doc-external">
      {children}
      <Icon name="external" size={12} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

// an image never loads with the page, because a load tells its host that the owner read the doc. a click shows it,
// and only an https image loads, without a referrer. in a tainted version an image whose address can carry data never
// loads, and its address shows as text.
function DocImage({ href, alt, tainted }: { href: string; alt: string; tainted: boolean }) {
  const [shown, setShown] = useState(false);
  let url: URL | undefined;
  try {
    const decoded = decodeReferences(href);
    if (/^https:\/\//i.test(decoded) && !/[\u0000- \u007f]/.test(decoded)) url = new URL(decoded);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:')
    return (
      <span className="doc-image-alt" title={href}>
        {alt || 'image'}
      </span>
    );
  const held = heldReason({ href: url.href, external: true }, tainted);
  if (held)
    return (
      <HeldLink href={url.href} reason={held}>
        {alt || 'image'}
      </HeldLink>
    );
  if (!shown)
    return (
      <button type="button" className="doc-image-button" onClick={() => setShown(true)}>
        Show image: {alt || 'no description'} ({url.host})
      </button>
    );
  return <img className="doc-image" src={url.href} alt={alt} referrerPolicy="no-referrer" loading="lazy" />;
}

// the slugs of the headings of one render. a second heading with the same slug gets -2, a third -3. each id starts
// with doc-, so a heading never takes the id of a part of the app or the name of a global.
class Slugs {
  private seen = new Map<string, number>();
  next(text: string): string {
    const base =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/, '') || 'section';
    const count = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, count);
    return count === 1 ? `doc-${base}` : `doc-${base}-${count}`;
  }
}

const childrenOf = (token: Token): Token[] | undefined => ('tokens' in token && Array.isArray(token.tokens) ? (token.tokens as Token[]) : undefined);

function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens
    .map((token) => {
      const children = childrenOf(token);
      if (children) return plainText(children);
      if (token.type === 'text' || token.type === 'escape' || token.type === 'codespan') return decodeReferences(String((token as Tokens.Text).text));
      return 'text' in token ? String(token.text) : token.raw;
    })
    .join('');
}

function inline(tokens: Token[] | undefined, inLink: boolean, tainted: boolean): ReactNode[] {
  return (tokens ?? []).map((token, index) => inlineToken(token, index, inLink, tainted));
}

function inlineToken(token: Token, key: number, inLink: boolean, tainted: boolean): ReactNode {
  const children = childrenOf(token);
  switch (token.type) {
    case 'text':
      return children ? <Fragment key={key}>{inline(children, inLink, tainted)}</Fragment> : decodeReferences(String((token as Tokens.Text).text));
    case 'escape':
      return (token as Tokens.Escape).text;
    case 'strong':
      return <strong key={key}>{inline(children, inLink, tainted)}</strong>;
    case 'em':
      return <em key={key}>{inline(children, inLink, tainted)}</em>;
    case 'del':
      return <del key={key}>{inline(children, inLink, tainted)}</del>;
    // a code span shows a reference as text, as markdown does.
    case 'codespan':
      return <code key={key}>{(token as Tokens.Codespan).text}</code>;
    case 'br':
      return <br key={key} />;
    case 'link': {
      const link = token as Tokens.Link;
      const body = inline(children, true, tainted);
      // a link inside a link cannot open, so it shows its text.
      if (inLink) return <span key={key}>{body}</span>;
      return (
        <DocAnchor key={key} href={link.href} tainted={tainted}>
          {body}
        </DocAnchor>
      );
    }
    case 'image': {
      const image = token as Tokens.Image;
      const alt = decodeReferences(image.text);
      // a button inside a link would open the link, so an image there shows its text.
      if (inLink) return <span key={key}>{alt || 'image'}</span>;
      return <DocImage key={key} href={image.href} alt={alt} tainted={tainted} />;
    }
    // raw html from the model is text, never a tag.
    case 'html':
      return token.raw;
    default:
      return children ? <Fragment key={key}>{inline(children, inLink, tainted)}</Fragment> : token.raw;
  }
}

// the state of one render: the slugs of its headings, and whether a tainted session wrote the text.
interface RenderState {
  slugs: Slugs;
  tainted: boolean;
}

function blocks(tokens: Token[], state: RenderState, depth: number): ReactNode[] {
  return tokens.map((token, index) => block(token, index, state, depth));
}

function block(token: Token, key: number, state: RenderState, depth: number): ReactNode {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading;
      // the title of the page is the h1, so the h1 of a doc is an h2.
      const level = Math.min(Math.max(heading.depth, 1) + 1, 6);
      const Tag = `h${level}` as 'h2';
      return (
        <Tag key={key} id={state.slugs.next(plainText(heading.tokens))} className="doc-heading">
          {inline(heading.tokens, false, state.tainted)}
        </Tag>
      );
    }
    case 'paragraph':
      return <p key={key}>{inline((token as Tokens.Paragraph).tokens, false, state.tainted)}</p>;
    case 'text': {
      const children = childrenOf(token);
      return <Fragment key={key}>{children ? inline(children, false, state.tainted) : decodeReferences(String((token as Tokens.Text).text))}</Fragment>;
    }
    case 'code':
      return (
        <pre key={key} className="doc-code">
          <code>{(token as Tokens.Code).text}</code>
        </pre>
      );
    case 'blockquote':
      if (depth >= MAX_DEPTH)
        return (
          <p key={key} className="doc-source">
            {token.raw}
          </p>
        );
      return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, state, depth + 1)}</blockquote>;
    case 'list': {
      if (depth >= MAX_DEPTH)
        return (
          <p key={key} className="doc-source">
            {token.raw}
          </p>
        );
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => {
        const body = blocks(
          item.tokens.filter((child) => child.type !== 'checkbox'),
          state,
          depth + 1,
        );
        if (!item.task) return <li key={index}>{body}</li>;
        return (
          <li key={index} className="doc-task">
            <input type="checkbox" disabled checked={Boolean(item.checked)} readOnly aria-label={item.checked ? 'Done' : 'Not done'} />
            <div className="doc-task-body">{body}</div>
          </li>
        );
      });
      const task = list.items.some((item) => item.task);
      const className = task ? 'doc-task-list' : undefined;
      if (!list.ordered)
        return (
          <ul key={key} className={className}>
            {items}
          </ul>
        );
      const start = typeof list.start === 'number' && list.start !== 1 ? list.start : undefined;
      return (
        <ol key={key} className={className} start={start}>
          {items}
        </ol>
      );
    }
    case 'table': {
      const table = token as Tokens.Table;
      const align = (index: number) => table.align[index] ?? undefined;
      return (
        <div key={key} className="doc-table-wrap">
          <table className="doc-table">
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th key={index} style={align(index) ? { textAlign: align(index)! } : undefined}>
                    {inline(cell.tokens, false, state.tainted)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={align(index) ? { textAlign: align(index)! } : undefined}>
                      {inline(cell.tokens, false, state.tainted)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'hr':
      return <hr key={key} />;
    case 'escape':
      return (token as Tokens.Escape).text;
    case 'space':
    case 'def':
      return null;
    // a block of raw html is text, never a tag.
    case 'html':
      return (
        <p key={key} className="doc-source">
          {token.raw.trim()}
        </p>
      );
    default: {
      const children = childrenOf(token);
      return children ? (
        <div key={key}>{inline(children, false, state.tainted)}</div>
      ) : (
        <p key={key} className="doc-source">
          {token.raw}
        </p>
      );
    }
  }
}

// a line that opens more quotes than MAX_DEPTH. the lexer reads each level of a quote with a new frame of the stack, so
// such a part shows as text without a lex.
const DEEP_QUOTE = new RegExp(`^(?: {0,3}>){${MAX_DEPTH + 1}}`, 'm');

// the lexer takes quadratic time on some inline text, for example a long run of "*a ", so a part can take a few
// hundred milliseconds. after this much time in the lexer, the rest of the text shows as plain text, so a hostile doc
// cannot hang the page.
const LEX_BUDGET_MS = 1000;

const source = (part: string, key: number) => (
  <p key={key} className="doc-source">
    {part}
  </p>
);

// a reference link ([text][name]) resolves only against a definition ([name]: url) of the same part, and a model often
// puts the definitions at the end of a long doc. so the renderer collects the definitions of the whole text and adds
// them to each part. the limits keep a hostile doc from making each part long.
const DEFINITION = /^ {0,3}\[[^\]\n]{1,200}\]:[ \t]*\S[^\n]*$/gm;
const DEFINITIONS_MAX = 200;
const DEFINITION_CHARS = 20_000;

function definitionsOf(text: string): string {
  const found: string[] = [];
  let chars = 0;
  for (const match of text.matchAll(DEFINITION)) {
    if (found.length >= DEFINITIONS_MAX || chars + match[0].length > DEFINITION_CHARS) break;
    found.push(match[0]);
    chars += match[0].length + 1;
  }
  return found.join('\n');
}

// a long doc renders in steps of this many parts, so the top of the page shows at once and the browser stays
// responsive while the rest renders. 10 parts are about 20,000 characters.
const STEP_PARTS = 10;

// the parts of one text, lexed and rendered on demand and kept. the slugs of the headings go in the order of the
// parts, so a doc that renders in steps gets the same ids as a doc that renders at once.
export class PartRenderer {
  private readonly parts: string[];
  private readonly done: ReactNode[] = [];
  private readonly state: RenderState;
  private readonly definitions: string;
  private spent = 0;

  constructor(text: string, private readonly budgetMs = LEX_BUDGET_MS, tainted = false) {
    this.parts = splitMarkdown(text, LEX_LIMIT).filter((part) => part.trim() !== '');
    this.state = { slugs: new Slugs(), tainted };
    this.definitions = this.parts.length > 1 ? definitionsOf(text) : '';
  }

  get total(): number {
    return this.parts.length;
  }

  // the elements of the first count parts.
  upTo(count: number): ReactNode[] {
    while (this.done.length < Math.min(count, this.parts.length)) this.done.push(this.render(this.parts[this.done.length]!, this.done.length));
    return this.done.slice(0, count);
  }

  private render(part: string, key: number): ReactNode {
    if (DEEP_QUOTE.test(part) || this.spent > this.budgetMs) return source(part, key);
    const started = performance.now();
    try {
      const tokens = Lexer.lex(this.definitions ? `${part}\n\n${this.definitions}` : part, LEX_OPTIONS);
      return <Fragment key={key}>{blocks(tokens, this.state, 0)}</Fragment>;
    } catch {
      return source(part, key);
    } finally {
      this.spent += performance.now() - started;
    }
  }
}

// renderParts makes the elements of a whole text at once.
export function renderParts(text: string, budgetMs = LEX_BUDGET_MS, tainted = false): ReactNode[] {
  const renderer = new PartRenderer(text, budgetMs, tainted);
  return renderer.upTo(renderer.total);
}

// the page shows the title of the doc, and a model often starts the body with the same title as an h1. that h1 would
// show the title twice, so it is left out when it equals the title, after a trim and in any case.
export function withoutTitle(body: string, title: string): string {
  const match = /^(?:[ \t]*\r?\n)*[ \t]{0,3}#[ \t]+([^\r\n]*?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)/.exec(body);
  if (!match || match[1]!.trim().toLowerCase() !== title.trim().toLowerCase()) return body;
  return body.slice(match[0].length);
}

export function Markdown({ text, tainted = false }: { text: string; tainted?: boolean }) {
  const renderer = useMemo(() => new PartRenderer(text, LEX_BUDGET_MS, tainted), [text, tainted]);
  const [progress, setProgress] = useState({ renderer, shown: STEP_PARTS });
  const shown = progress.renderer === renderer ? progress.shown : STEP_PARTS;
  useEffect(() => {
    if (shown >= renderer.total) return;
    const timer = setTimeout(() => setProgress({ renderer, shown: shown + STEP_PARTS }), 0);
    return () => clearTimeout(timer);
  }, [renderer, shown]);
  return (
    <div className="doc-markdown" aria-busy={shown < renderer.total || undefined}>
      {renderer.upTo(shown)}
    </div>
  );
}
