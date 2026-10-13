import type { gmail_v1 } from '@googleapis/gmail';

// a plain address. a name part, a comma or a line break could add a recipient or a header that the owner did not
// approve, so the tools take bare addresses only.
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;

export function badAddress(addresses: readonly string[]): string | undefined {
  return addresses.find((address) => !ADDRESS.test(address));
}

// the one address of a from header: "Name" <a@b> or a@b. a header with a second mailbox gives undefined, because the
// owner approved one sender.
export function fromAddress(value: string): string | undefined {
  if ((value.match(/</g) ?? []).length > 1) return undefined;
  const angle = /<([^<>]*)>\s*$/.exec(value);
  const address = (angle ? angle[1]! : value).trim().toLowerCase();
  return ADDRESS.test(address) ? address : undefined;
}

// a header value with a non-ascii character goes as an rfc 2047 encoded word. a line break is never kept, because it
// would start a new header.
function headerText(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ');
  return [...flat].every((char) => char.charCodeAt(0) < 0x80) ? flat : `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

export interface Draft {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}

// the raw message for the gmail api, as base64url text. the body is base64 too, so a line in it can never look like
// a header or a mime boundary.
export function rawMessage(draft: Draft): string {
  const lines = [
    `To: ${draft.to.join(', ')}`,
    ...(draft.cc?.length ? [`Cc: ${draft.cc.join(', ')}`] : []),
    ...(draft.bcc?.length ? [`Bcc: ${draft.bcc.join(', ')}`] : []),
    `Subject: ${headerText(draft.subject)}`,
    ...(draft.inReplyTo ? [`In-Reply-To: ${headerText(draft.inReplyTo)}`, `References: ${headerText(draft.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    ...(Buffer.from(draft.body, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

// the text of a message: the first text/plain part, or the text/html part without its tags.
export function bodyText(part: gmail_v1.Schema$MessagePart | undefined): string {
  const plain = findPart(part, 'text/plain');
  if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64url').toString('utf8');
  const html = findPart(part, 'text/html');
  if (html?.body?.data) {
    // the sender writes the html, so each step must take linear time. a tag pattern that can cross a '<' took 8 s on
    // 120 kb of '<' and blocked the whole process.
    return withoutBlocks(Buffer.from(html.body.data, 'base64url').toString('utf8'))
      .replace(/<[^<>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ');
  }
  return '(no text part)';
}

// the html without its script and style blocks. a forward scan replaces a lazy pattern with a back reference, which
// took quadratic time on many open tags without a close. a block without its close tag ends the text. the scan does
// not use a lower-case copy, because lower case can change the length of the text and move the positions.
function withoutBlocks(html: string): string {
  const open = /<(script|style)\b/gi;
  let out = '';
  let at = 0;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    out += html.slice(at, match.index);
    const close = new RegExp(`</${match[1]}`, 'gi');
    close.lastIndex = open.lastIndex;
    const found = close.exec(html);
    const end = found ? html.indexOf('>', close.lastIndex) : -1;
    if (end < 0) return out;
    at = end + 1;
    open.lastIndex = at;
  }
  return out + html.slice(at);
}

function findPart(part: gmail_v1.Schema$MessagePart | undefined, mimeType: string): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

export const header = (message: gmail_v1.Schema$Message, key: string) =>
  message.payload?.headers?.find((each) => each.name?.toLowerCase() === key.toLowerCase())?.value ?? '';
