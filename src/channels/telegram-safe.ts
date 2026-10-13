// rich markdown renders raw html in the model text. a tg-button tag makes a real button, a media tag or an image
// makes the telegram servers fetch a url without a click, and a tg:// link can show media. the model writes this
// text, and a tainted model can be told what to write. so a zero-width space goes into each such construct. the
// owner sees the same text, and telegram does not parse it. the check reads the raw text without a parser, so a
// difference between two parsers cannot hide a tag.

const ZWSP = '​';

// tags that only change how text looks. a tag that telegram adds later is blocked until it is on this list.
const ALLOWED_TAGS = new Set(
  'b strong i em u ins s strike del code pre sub sup br p blockquote aside cite details summary tg-spoiler'.split(' '),
);

// the spaces before and after the slash are separate groups, so a long run of spaces has only one way to match.
// "<!" and "<?" start a comment or a declaration, which can hold a fence that the line scanner would take as code.
const TAG = /<(\s*(?:\/\s*)?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)|<(?=[!?])/g;
const IMAGE = /!\[/g;
// a link destination can spell the colon as an html entity.
const SCHEME = /\b(tg|attach)(?=:|&colon;|&#0*58;?|&#x0*3a;?)/gi;

export interface Neutralized {
  text: string;
  // what the pass changed, for the log. a non-empty list is a possible injection.
  neutralized: string[];
}

export function neutralizeMarkdown(text: string): Neutralized {
  const neutralized: string[] = [];
  const lines = text.split('\n');
  const code = codeLines(lines);
  const safe = lines.map((line, i) => {
    if (code[i]) return line;
    return line
      .replace(TAG, (match, slash: string | undefined, name: string | undefined, at: number) => {
        if (name === undefined) {
          neutralized.push(`<${line.charAt(at + 1)}`);
          return `<${ZWSP}`;
        }
        if (ALLOWED_TAGS.has(name.toLowerCase())) return match;
        neutralized.push(`<${name.toLowerCase()}>`);
        return `<${ZWSP}${slash}${name}`;
      })
      .replace(IMAGE, () => {
        neutralized.push('![');
        return `!${ZWSP}[`;
      })
      .replace(SCHEME, (scheme: string) => {
        neutralized.push(`${scheme.toLowerCase()}:`);
        return `${scheme}${ZWSP}`;
      });
  });
  return { text: safe.join('\n'), neutralized };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// a fence opens on a line that starts with three or more backticks or tildes. an info string after backticks cannot
// hold a backtick, else the line is inline code.
function opener(line: string, indent: number): string | undefined {
  const match = FENCE.exec(line);
  if (!match || line.length - line.trimStart().length > indent) return undefined;
  const [, marker, info] = match as unknown as [string, string, string];
  return marker[0] === '`' && info.includes('`') ? undefined : marker;
}

const closes = (line: string, marker: string) => {
  const found = FENCE.exec(line);
  return found !== null && found[1]![0] === marker[0] && found[1]!.length >= marker.length && found[2]!.trim() === '';
};

// codeLines marks the lines of each fenced code block that the pass leaves as they are. the rule is stricter than
// markdown, so a block that the scanner takes as code is code for telegram too:
// - the fence starts in column 0, so it is not inside a list item;
// - no html block is open. such a block starts with a tag at the start of a line and ends at a blank line, and a
//   <pre> block ends only at </pre>. markdown keeps the lines of the block raw, so a fence there is not code;
// - a closing fence follows. a fence without one is not exempt.
function codeLines(lines: string[]): boolean[] {
  const code = lines.map(() => false);
  let html = false;
  let pre = false;
  let open: { marker: string; at: number } | undefined;
  for (const [i, line] of lines.entries()) {
    if (open) {
      if (closes(line, open.marker)) {
        code.fill(true, open.at, i + 1);
        open = undefined;
      }
      continue;
    }
    if (line.trim() === '') html = false;
    const marker = html || pre ? undefined : opener(line, 0);
    if (marker) open = { marker, at: i };
    else if (/^ {0,3}<\s*(?:\/\s*)?[A-Za-z]/.test(line)) html = true;
    if (/^ {0,3}<pre(?=[\s>]|$)/i.test(line)) pre = true;
    if (/<\/pre>/i.test(line)) pre = false;
  }
  return code;
}

// the split reads lines, not a markdown parse. a parser takes quadratic time on some text and can overflow the stack
// on deep quotes, and the model writes the text. a part ends at a blank line outside a code fence. a part with no such
// line ends at a line. inside a fence, the part closes the fence and the next part opens it again. a line over the
// limit is cut, and the cut never splits a surrogate pair.
export function splitMarkdown(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  // the room for a closing fence that a cut adds.
  const room = limit - 8;
  const parts: string[] = [];
  let lines: string[] = [];
  let size = 0;
  let fence: { marker: string; line: string } | undefined;
  let lastBreak = -1;
  const take = (count: number) => {
    const part = lines.slice(0, count);
    const open = fenceAfter(part);
    const body = part.join('\n').trim();
    if (body) parts.push(open ? `${body}\n${open.marker}` : body);
    lines = open ? [open.line, ...lines.slice(count)] : lines.slice(count);
    size = lines.reduce((sum, line) => sum + line.length + 1, 0);
    lastBreak = -1;
  };
  for (let line of text.split('\n')) {
    while (line.length > room) {
      const cut = /[\uD800-\uDBFF]/.test(line[room - 1]!) ? room - 1 : room;
      if (lines.length) take(lines.length);
      lines.push(line.slice(0, cut));
      size += cut + 1;
      line = line.slice(cut);
      take(lines.length);
    }
    if (size + line.length + 1 > room) take(lastBreak > 0 ? lastBreak : lines.length);
    if (fence && closes(line, fence.marker)) fence = undefined;
    else if (!fence) {
      const marker = opener(line, 3);
      if (marker) fence = { marker, line };
    }
    if (!fence && line.trim() === '') lastBreak = lines.length;
    lines.push(line);
    size += line.length + 1;
  }
  if (lines.join('').trim()) parts.push(lines.join('\n').trim());
  return parts;
}

// fenceAfter tells whether a part ends inside a code fence, and gives the line that opened it.
function fenceAfter(lines: string[]): { marker: string; line: string } | undefined {
  let open: { marker: string; line: string } | undefined;
  for (const line of lines) {
    if (open && closes(line, open.marker)) open = undefined;
    else if (!open) {
      const marker = opener(line, 3);
      if (marker) open = { marker, line };
    }
  }
  return open;
}
