import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import { defineTool } from './registry.js';

// the limit keeps a page under the handle limit, so a page never gets a handle of its own. the output also repeats
// the query, so the query has a limit too.
export const READ_LIMIT = 3500;
export const QUERY_LIMIT = 200;
const AROUND = 150;

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

// each passage shows its offset, so the model can read around it with from and length.
function search(text: string, handle: string, query: string): string {
  const spans: Array<[number, number]> = [];
  for (const word of new Set(query.split(/\s+/).filter(Boolean))) {
    const pattern = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (const match of text.matchAll(pattern)) {
      spans.push([Math.max(0, match.index - AROUND), Math.min(text.length, match.index + match[0].length + AROUND)]);
    }
  }
  if (!spans.length) return `no passage of ${handle} (${text.length} characters) matches "${query}"`;
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  const passages: string[] = [];
  let used = 0;
  for (const [start, end] of merged) {
    const passage = `[at ${start}] ${text.slice(start, end)}`;
    if (used + passage.length > READ_LIMIT && passages.length) break;
    passages.push(passage.slice(0, READ_LIMIT));
    // the separator between two passages counts too.
    used += passage.length + 2;
  }
  const rest = merged.length - passages.length;
  const more = rest ? `\n\n[${rest} more passages match. use a narrower query, or from and length.]` : '';
  return `${merged.length} passages of ${handle} (${text.length} characters) match "${query}":\n\n${passages.join('\n\n')}${more}`;
}
