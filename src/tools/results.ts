import { randomBytes } from 'node:crypto';
import type { ToolOutput } from './registry.js';
import { wrapUntrusted } from './untrusted.js';

// a longer result goes to the model as a preview with a handle. the preview stays under the limit, so the trim at a
// compaction never cuts it again.
export const HANDLE_OVER = 4000;
export const PREVIEW_HEAD = 1500;
export const PREVIEW_TAIL = 1500;

// the real note is the last line, outside the untrusted wrapper. an untrusted page can contain a copy of the note,
// but the copy is never at the end, so the pattern looks only at the end.
const HANDLE_NOTE = /the full result is (res_[0-9a-f]{12})\. use result_read with this handle to search or page through it\.\]$/;

export const newHandle = () => `res_${randomBytes(6).toString('hex')}`;

export function handleIn(content: string): string | undefined {
  return HANDLE_NOTE.exec(content)?.[1];
}

export interface ModelView {
  content: string;
  handle?: string;
  truncated: boolean;
}

// the model view is the exact text that the model gets for a tool result. untrusted text is wrapped, and a long
// text becomes its start and end with a handle to the full text.
export function modelView(output: ToolOutput, handle: () => string = newHandle): ModelView {
  const raw = output.content;
  const wrap = (text: string) => (output.untrustedSource ? wrapUntrusted(output.untrustedSource, text) : text);
  // the limit applies to the text that the model gets, with its wrapper. a view over the limit without a handle is
  // cut by the trim, and the model then cannot read the cut part again.
  const whole = wrap(raw);
  if (whole.length <= HANDLE_OVER) return { content: whole, truncated: false };
  const id = handle();
  const head = raw.slice(0, safeEnd(raw, PREVIEW_HEAD));
  const tail = raw.slice(safeStart(raw, raw.length - PREVIEW_TAIL));
  const cut = raw.length - head.length - tail.length;
  const preview = `${head}\n[... ${cut} characters cut ...]\n${tail}`;
  const note = `[this result has ${raw.length} characters. only its start and end are above. the full result is ${id}. use result_read with this handle to search or page through it.]`;
  return { content: `${wrap(preview)}\n${note}`, handle: id, truncated: true };
}

// a cut between the two halves of a surrogate pair breaks the character.
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const safeEnd = (text: string, end: number) => (isHigh(text.charCodeAt(end - 1)) ? end - 1 : end);
const safeStart = (text: string, start: number) => (isHigh(text.charCodeAt(start - 1)) ? start + 1 : start);
