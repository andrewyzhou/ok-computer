import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import { defineTool } from './registry.js';

// the limit keeps a page under the handle limit, so a page never gets a handle of its own. the output also repeats
// the query, so the query has a limit too.
export const READ_LIMIT = 3500;
export const QUERY_LIMIT = 200;
const AROUND = 150;
// the search looks at most at this many more matches after the passages are full.
const SCAN_LIMIT = 10_000;

export function createResultReadTool(deps: { db: Db; blobs: BlobStore }) {
  return defineTool({
    name: 'result_read',
    description: `Read a long tool result that came back as a preview with a handle such as res_0123456789ab. Give query to find the passages that contain any of its words, or give from (a character offset) and length to read one part. At most ${READ_LIMIT} characters come back.`,
    input: z.object({
      handle: z.string().regex(/^res_[0-9a-f]{12}$/, 'use a handle such as res_0123456789ab'),
      query: z.string().min(1).max(QUERY_LIMIT).optional(),
      from: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(READ_LIMIT).default(READ_LIMIT),
    }),
    risk: 'read',
    async run({ handle, query, from, length }) {
      const row = deps.db.prepare('SELECT rawResultBlob, untrustedSource FROM tool_calls WHERE resultHandle = ?').get(handle);
      const text = row?.rawResultBlob ? deps.blobs.read(String(row.rawResultBlob)) : undefined;
      if (text === undefined) return { content: `no stored result has the handle ${handle}`, isError: true };
      const source = row?.untrustedSource ? { untrustedSource: String(row.untrustedSource) } : {};
      const content = query ? search(text, handle, query) : page(text, handle, from, length);
      return { content, ...source };
    },
  });
}

function page(text: string, handle: string, from: number, length: number): string {
  const end = Math.min(text.length, from + length);
  if (from >= text.length) return `${handle} has only ${text.length} characters`;
  const more = end < text.length ? `\n[more text follows. use from ${end} to read on.]` : '';
  return `${handle} characters ${from}-${end} of ${text.length}:\n${text.slice(from, end)}${more}`;
}

// each passage shows its offset, so the model can read around it with from and length. the search is one pass in
// text order, and it stops soon after the passages fill the limit. a query of short common words over a large
// result then cannot hold the event loop or fill the heap, and untrusted text can ask for such a query.
function search(text: string, handle: string, query: string): string {
  const words = [...new Set(query.split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const passages: string[] = [];
  let used = 0;
  let full = false;
  let count = 0;
  // after the passages are full, the search only counts, and it stops after SCAN_LIMIT more matches.
  let scanned = 0;
  let stopped = false;
  const add = ([start, end]: [number, number]) => {
    count++;
    if (full) return;
    const passage = `[at ${start}] ${text.slice(start, end)}`;
    if (used + passage.length > READ_LIMIT && passages.length) {
      full = true;
      return;
    }
    passages.push(passage.slice(0, READ_LIMIT));
    // the separator between two passages counts too.
    used += passage.length + 2;
    if (used >= READ_LIMIT) full = true;
  };
  // the matches come in text order, so a span can only join the span before it.
  let span: [number, number] | undefined;
  for (const match of text.matchAll(pattern)) {
    if (full && ++scanned > SCAN_LIMIT) {
      stopped = true;
      break;
    }
    const start = Math.max(0, match.index - AROUND);
    const end = Math.min(text.length, match.index + match[0].length + AROUND);
    // a span longer than the limit is cut anyway, so a dense match closes it early.
    if (span && start <= span[1] && span[1] - span[0] < READ_LIMIT) {
      span[1] = Math.max(span[1], end);
      continue;
    }
    if (span) add(span);
    span = [start, end];
  }
  if (span) add(span);
  if (!count) return `no passage of ${handle} (${text.length} characters) matches "${query}"`;
  const rest = count - passages.length;
  const total = stopped ? `more than ${count}` : String(count);
  const more = rest ? `\n\n[${stopped ? 'more than ' : ''}${rest} more passages match. use a narrower query, or from and length.]` : '';
  return `${total} passages of ${handle} (${text.length} characters) match "${query}":\n\n${passages.join('\n\n')}${more}`;
}
