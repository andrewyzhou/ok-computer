import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

// readability walks every element several times. above this count it stops with an error, and the plain walk below
// reads the page instead, so a huge page costs one pass.
const MAX_ELEMENTS = 20_000;
// the time of readability grows with about the cube of the depth: 1,000 nested elements took 7.7 s, and 500 took
// 1.1 s. real pages are rarely deeper than 60 levels.
const MAX_DEPTH = 120;

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
]);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'HEAD']);

interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute?: (name: string) => string | null;
}

// the walks use their own stack, not recursion. a page of deeply nested elements would otherwise overflow the call
// stack of the process.
export function textOf(root: DomNode, base: string): string {
  const out: string[] = [];
  const stack: Array<DomNode | string> = [root];
  while (stack.length) {
    const item = stack.pop()!;
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (item.nodeType === 3) {
      out.push((item.textContent ?? '').replace(/\s+/g, ' '));
      continue;
    }
    if (item.nodeType !== 1 && item.nodeType !== 9 && item.nodeType !== 11) continue;
    const name = item.nodeName.toUpperCase();
    if (SKIP.has(name)) continue;
    const block = BLOCK.has(name);
    const prefix = name === 'LI' ? '\n- ' : /^H[1-6]$/.test(name) ? `\n\n${'#'.repeat(Number(name[1]))} ` : block ? '\n\n' : '';
    let suffix = block ? '\n' : '';
    if (name === 'A') {
      const href = item.getAttribute?.('href');
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
        try {
          suffix = ` (${new URL(href, base).href})`;
        } catch {
          // a broken link keeps only its text.
        }
      }
    }
    stack.push(suffix);
    const kids = item.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    stack.push(prefix);
  }
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function depthOf(root: DomNode): number {
  let max = 0;
  const stack: Array<[DomNode, number]> = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (depth > max) max = depth;
    if (max > MAX_DEPTH) return max;
    const kids = Array.from(node.childNodes);
    for (const kid of kids) if (kid.nodeType === 1) stack.push([kid, depth + 1]);
  }
  return max;
}

export interface Extracted {
  title: string;
  text: string;
  // readability: the main article. page: the whole page, because readability found no article, gave up, or the page
  // was too deep for it. raw: the tags were removed without a parser, because the parse took too long.
  method: 'readability' | 'page' | 'raw';
}

export function extractReadable(html: string, url: string): Extracted {
  const { document } = parseHTML(html);
  const title = (document.title ?? '').trim();
  const body = (document.body ?? document) as unknown as DomNode;
  if (depthOf(body) <= MAX_DEPTH) {
    try {
      const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { maxElemsToParse: MAX_ELEMENTS }).parse();
      if (article?.content) {
        const { document: inner } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
        const text = textOf(inner.body as unknown as DomNode, url);
        if (text) return { title: article.title?.trim() || title, text, method: 'readability' };
      }
    } catch {
      // too many elements, or a page that breaks the parser. the plain walk still reads it.
    }
    // readability changes the document, so the walk parses the page again.
    const { document: fresh } = parseHTML(html);
    return { title, text: textOf((fresh.body ?? fresh) as unknown as DomNode, url), method: 'page' };
  }
  return { title, text: textOf(body, url), method: 'page' };
}

// the last resort is linear. a lazy regular expression for script blocks goes back over the rest of the text for each
// unclosed tag, so the blocks are cut with indexOf.
function dropBlocks(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  const open = /<(head|script|style|noscript|template)\b/g;
  let at = 0;
  while (at < html.length) {
    open.lastIndex = at;
    const found = open.exec(lower);
    if (!found) break;
    const start = found.index;
    const name = found[1]!;
    out.push(html.slice(at, start), ' ');
    const end = lower.indexOf(`</${name}`, start);
    if (end < 0) return out.join('');
    const close = lower.indexOf('>', end);
    at = close < 0 ? html.length : close + 1;
  }
  out.push(html.slice(at));
  return out.join('');
}

export function stripTags(html: string): Extracted {
  const title = /<title[^>]*>([^<]*)/i.exec(html)?.[1]?.trim() ?? '';
  const text = dropBlocks(html)
    .replace(/<\/?(p|div|br|li|h[1-6]|tr|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text, method: 'raw' };
}
