import type { gmail_v1 } from '@googleapis/gmail';

// a builder of gmail messages in the shape that messages.get gives with format full, for the tests of the pure
// functions of the inbox jobs. the shapes follow real mail: an html-only mail, a mail with a plain and an html part,
// and a mail with a file. all names and domains are made up and use example domains.

export interface MailSpec {
  id: string;
  threadId?: string;
  // the headers in order. From, To, Subject and Date are the usual ones. a header can repeat, so the value may be a
  // list, as for Received or Authentication-Results.
  headers: Record<string, string | string[]>;
  plain?: string;
  html?: string;
  labels?: string[];
  // the internal date of gmail as an iso time. the default is the Date header, else 2026-10-13 16:00 utc.
  at?: string;
  files?: Array<{ filename: string; mimeType: string; size: number }>;
}

const data = (text: string) => ({ data: Buffer.from(text, 'utf8').toString('base64url'), size: Buffer.byteLength(text) });

// mailMessage builds the message. a spec with plain and html gives multipart/alternative, a spec with files wraps it
// in multipart/mixed, and a spec with neither body gives an empty text/plain part.
export function mailMessage(spec: MailSpec): gmail_v1.Schema$Message {
  const headers = Object.entries(spec.headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((each) => ({ name, value: each })));
  const plain = spec.plain === undefined ? undefined : { partId: '0', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: data(spec.plain) };
  const html = spec.html === undefined ? undefined : { partId: '1', mimeType: 'text/html', filename: '', headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: data(spec.html) };
  let body: gmail_v1.Schema$MessagePart =
    plain && html
      ? { mimeType: 'multipart/alternative', filename: '', body: { size: 0 }, parts: [plain, html] }
      : (plain ?? html ?? { mimeType: 'text/plain', filename: '', body: data('') });
  if (spec.files?.length) {
    body = {
      mimeType: 'multipart/mixed',
      filename: '',
      body: { size: 0 },
      parts: [body, ...spec.files.map((file, index) => ({ partId: String(index + 2), mimeType: file.mimeType, filename: file.filename, body: { attachmentId: `att${index}`, size: file.size } }))],
    };
  }
  const date = typeof spec.headers.Date === 'string' ? Date.parse(spec.headers.Date) : NaN;
  const at = spec.at ? Date.parse(spec.at) : Number.isFinite(date) ? date : Date.parse('2026-10-13T16:00:00Z');
  return {
    id: spec.id,
    threadId: spec.threadId ?? spec.id,
    labelIds: spec.labels ?? ['INBOX', 'UNREAD'],
    snippet: '',
    internalDate: String(at),
    sizeEstimate: (spec.plain?.length ?? 0) + (spec.html?.length ?? 0),
    payload: { partId: '', ...body, headers: [...headers, ...(body.headers ?? [])] },
  };
}
