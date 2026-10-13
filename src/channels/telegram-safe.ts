// rich markdown renders raw html in the model text. a tg-button tag makes a real button, a media tag or an image
// makes the telegram servers fetch a url without a click, and a tg:// link can show media. the model writes this
// text, and a tainted model can be told what to write. so a zero-width space goes into each such construct. the
// owner sees the same text, and telegram does not parse it. the check reads the raw text without a parser, so a
// difference between two parsers cannot hide a tag. for this reason the pass also changes the text in code blocks:
// a list, a quote or an html block changes where a fence ends, and only a full parser knows that. the cost is a
// zero-width space in copied code that holds a tag, an image or a tg: scheme.

const ZWSP = '​';

// tags that only change how text looks. a tag that telegram adds later is blocked until it is on this list.
const ALLOWED_TAGS = new Set(
  'b strong i em u ins s strike del code pre sub sup br p blockquote aside cite details summary tg-spoiler'.split(' '),
);

// the spaces before and after the slash are separate groups, so a long run of spaces has only one way to match.
// "<!" and "<?" start a comment or a declaration, which can hide text.
const TAG = /<(\s*(?:\/\s*)?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)|<(?=[!?])/g;
const IMAGE = /!\[/g;
// markdown decodes character references and backslash escapes in a link destination. so each letter of the scheme
// can be a numeric reference, and the colon can be a reference or an escaped colon.
const letter = (char: string) => {
  const codes = [char.charCodeAt(0), char.toUpperCase().charCodeAt(0)];
  return `(?:${char}|&#0*(?:${codes.join('|')});?|&#x0*(?:${codes.map((code) => code.toString(16)).join('|')});?)`;
};
const spelled = (word: string) => [...word].map(letter).join('');
const SCHEME = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:(${spelled('tg')})|(${spelled('attach')}))(?=:|\\:|&colon;|&#0*58;?|&#x0*3a;?)`,
  'gi',
);

export interface Neutralized {
  text: string;
  // what the pass changed, for the log. a non-empty list is a possible injection.
  neutralized: string[];
}

export function neutralizeMarkdown(text: string): Neutralized {
  const neutralized: string[] = [];
  const safe = text
    .replace(TAG, (match, slash: string | undefined, name: string | undefined, at: number) => {
      if (name === undefined) {
        neutralized.push(`<${text.charAt(at + 1)}`);
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
    .replace(SCHEME, (scheme: string, tg: string | undefined) => {
      neutralized.push(tg ? 'tg:' : 'attach:');
      return `${scheme}${ZWSP}`;
    });
  return { text: safe, neutralized };
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

// markdown allows only spaces and tabs after a closing fence. trim() also removes other white space.
const closes = (line: string, marker: string) => {
  const found = FENCE.exec(line);
  return found !== null && found[1]![0] === marker[0] && found[1]!.length >= marker.length && /^[ \t]*$/.test(found[2]!);
};

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
  // the count of lines at the start of the part that open a fence again: 0 or 1.
  let carried = 0;
  // the line that opens a fence again must be short. a long line, for example the first piece of a cut line, fills
  // each later part, and then the split never ends. so a long line is replaced by its marker. a long marker is not
  // carried, and the rest of that code shows as text.
  const take = (count: number) => {
    const part = lines.slice(0, count);
    const open = fenceAfter(part);
    const carry = open ? [open.line, open.marker].find((each) => each.length <= room / 4) : undefined;
    const body = part.join('\n').trim();
    if (body) parts.push(open && carry ? `${body}\n${open.marker}` : body);
    lines = carry ? [carry, ...lines.slice(count)] : lines.slice(count);
    carried = carry ? 1 : 0;
    size = lines.reduce((sum, line) => sum + line.length + 1, 0);
    lastBreak = -1;
  };
  for (let line of text.split('\n')) {
    if (size + line.length + 1 > room) take(lastBreak > 0 ? lastBreak : lines.length);
    // the lines after the blank line stay in the part, so with this line the part can still be too long. a part
    // that holds only the line that opens a fence again cannot get shorter.
    if (size + line.length + 1 > room && lines.length > carried) take(lines.length);
    // a line that still does not fit is cut. after a cut, the part holds at most a carried line of a quarter of the
    // room, so each cut takes at least half the room from the line, and the split always ends.
    while (size + line.length + 1 > room) {
      const space = Math.max(room - size - 1, Math.floor(room / 2));
      const cut = /[\uD800-\uDBFF]/.test(line[space - 1]!) ? space - 1 : space;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
      take(lines.length);
    }
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
