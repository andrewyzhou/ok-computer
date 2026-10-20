import { z } from 'zod';
import { DOC_KINDS, type DocSummary } from '../dashboard/docs-types.js';
import type { Db } from '../db/index.js';
import { sourceNames } from '../policy/policy.js';
import { sessionTaint } from '../policy/store.js';
import { formatLocal } from '../time.js';
import { defineTool, type Tool, type ToolOutput } from '../tools/registry.js';
import { splitLines } from './diff.js';
import { searchDocs } from './fts.js';
import {
  addVersion,
  BODY_CHARS,
  createDoc,
  docHash,
  getDoc,
  getVersion,
  HREF_CHARS,
  InvalidDocCursor,
  LABEL_CHARS,
  LINKS_MAX,
  listComments,
  listDocs,
  NOTE_CHARS,
  TITLE_CHARS,
  versionTaint,
} from './store.js';

// the tools of the docs (phase 6 t4). the app registers them with one line, and the session lists name them through
// names.ts, so no other file needs a change when a tool is added here. names.ts imports nothing, so the policy and
// the session lists can import it.

export { DOC_READ_TOOLS, DOC_TOOLS, DOC_WRITE_TOOLS } from './names.js';

export interface DocToolDeps {
  db: Db;
  // the address of the dashboard that a chat link uses, for example http://127.0.0.1:4318 or the public url. a tool
  // result gives the link of a doc as `${dashboardUrl}/#/docs/<id>`.
  dashboardUrl: string;
}

const READ_LINES = 400;
const MAX_READ_LINES = 1_000;
const COMMENTS_SHOWN = 20;

const title = z.string().trim().min(1).max(TITLE_CHARS);
const kind = z.enum(DOC_KINDS);
const body = z.string().min(1).max(BODY_CHARS);
const links = z
  .array(z.object({ label: z.string().trim().min(1).max(LABEL_CHARS), href: z.string().min(1).max(HREF_CHARS) }))
  .max(LINKS_MAX)
  .describe('Sources of the doc: http(s) urls, or #/ links of the dashboard such as #/runs/<id>.');

// a store error means that nothing was written, so a retry is safe.
const refused = (content: string): ToolOutput => ({ content, isError: true, effect: 'none' });

// the titles of tainted docs are model text that the model may have taken from outside text, so a list that shows
// them is untrusted. the source is one fixed text: the session dedupes its taint on the source, so a source that named
// the docs of each page would add a new source for each list or search with another set of docs.
export const LIST_TAINT_SOURCE = 'doc titles or snippets written after reading untrusted content';

function listTaint(docs: readonly DocSummary[]): Pick<ToolOutput, 'untrustedSource'> {
  return docs.some((doc) => doc.tainted) ? { untrustedSource: LIST_TAINT_SOURCE } : {};
}

export function createDocTools(deps: DocToolDeps): Tool[] {
  const { db } = deps;
  // the dashboard url can end with a slash, and the link must not get two.
  const base = deps.dashboardUrl.replace(/\/$/, '');
  const saved = (doc: DocSummary) =>
    `Saved doc #${doc.id} "${doc.title}" (version ${doc.version}). Give the owner this link: ${base}/${docHash(doc.id)}`;
  const local = (iso: string, timeZone: string) => formatLocal(new Date(iso), timeZone);

  const docWrite = defineTool({
    name: 'doc_write',
    description:
      'Write a new doc in markdown: a plan, a comparison, a brief, meeting prep, notes, or any long answer. The owner reads it in the dashboard. The result gives the link of the doc; reply in chat with a short line and that link.',
    input: z.object({
      title,
      kind: kind.default('other'),
      body,
      links: links.optional(),
      note: z.string().max(NOTE_CHARS).optional().describe('Why the doc was written, for the version history.'),
    }),
    risk: 'write',
    async run(input, ctx) {
      const result = createDoc(
        db,
        {
          title: input.title,
          kind: input.kind,
          body: input.body,
          ...(input.links ? { links: input.links } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          author: 'agent',
          // the version keeps the taint of the session, so a later read of the doc knows that it can repeat outside text.
          taint: sessionTaint(db, ctx.sessionKey),
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          toolCallId: ctx.toolCallId ?? null,
        },
        ctx.clock(),
      );
      return result.ok ? { content: saved(result.value) } : refused(result.error);
    },
  });

  const docUpdate = defineTool({
    name: 'doc_update',
    description:
      'Change a doc. This adds a new version and keeps the old ones. Read the doc with doc_read first, and give the version that you read as baseVersion. Give only the fields that change; body replaces the whole body.',
    input: z.object({
      id: z.number().int().min(1),
      baseVersion: z.number().int().min(1).describe('The version that you read with doc_read.'),
      title: title.optional(),
      kind: kind.optional(),
      body: body.optional(),
      links: links.optional(),
      note: z.string().trim().min(1).max(NOTE_CHARS).describe('What changed, in a few words.'),
    }),
    risk: 'write',
    async run(input, ctx) {
      const result = addVersion(
        db,
        input.id,
        {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.links !== undefined ? { links: input.links } : {}),
          note: input.note,
          baseVersion: input.baseVersion,
          author: 'agent',
          taint: sessionTaint(db, ctx.sessionKey),
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          toolCallId: ctx.toolCallId ?? null,
        },
        ctx.clock(),
      );
      return result.ok ? { content: saved(result.value) } : refused(result.error);
    },
  });

  const docRead = defineTool({
    name: 'doc_read',
    description: `Read a doc: its title, kind, version, links, body lines and the owner's comments. The default is the newest version. At most ${MAX_READ_LINES} lines come back; use fromLine to read on.`,
    input: z.object({
      id: z.number().int().min(1),
      version: z.number().int().min(1).optional(),
      fromLine: z.number().int().min(1).default(1),
      lines: z.number().int().min(1).max(MAX_READ_LINES).default(READ_LINES),
    }),
    risk: 'read',
    async run({ id, version, fromLine, lines }, ctx) {
      const doc = getDoc(db, id);
      if (!doc) return { content: `doc #${id} not found`, isError: true };
      const wanted = version ?? doc.version;
      const read = getVersion(db, id, wanted);
      if (!read) return { content: `doc #${id} has no version ${wanted}; its newest version is ${doc.version}`, isError: true };
      const all = splitLines(read.body);
      const slice = all.slice(fromLine - 1, fromLine - 1 + lines);
      const out = [`#${id} "${read.title}" [${read.kind}], version ${read.version} of ${doc.version}, updated ${local(read.createdAt, ctx.timeZone)}`];
      if (read.links.length) out.push('links:', ...read.links.map((link) => `- ${link.label}: ${link.href}`));
      if (slice.length) {
        out.push(`lines ${fromLine}-${fromLine + slice.length - 1} of ${all.length}:`, ...slice);
        const next = fromLine + slice.length;
        if (next <= all.length) out.push(`more: fromLine ${next}`);
      } else {
        out.push(`no lines from line ${fromLine}; the body has ${all.length} lines`);
      }
      const taint = versionTaint(db, id, read.version);
      const comments = listComments(db, id).slice(-COMMENTS_SHOWN);
      if (comments.length) {
        out.push(`the owner's comments (newest ${comments.length}):`);
        // a quote is text of the doc, so a quote of a tainted version can be outside text. when the read version is
        // tainted, the whole result is untrusted and the quote can show. when it is not, the quote of a tainted
        // version stays out, so the result stays trusted, and the model reads that version to see the passage.
        const quoteTainted = new Map<number, boolean>();
        const tainted = (version: number) => {
          if (!quoteTainted.has(version)) quoteTainted.set(version, versionTaint(db, id, version).length > 0);
          return quoteTainted.get(version)!;
        };
        for (const comment of comments) {
          let quote = '';
          if (comment.quote && (taint.length || !tainted(comment.version))) quote = ` (on the text "${comment.quote}")`;
          else if (comment.quote) quote = ` (on a passage of version ${comment.version}, which holds outside text; read that version to see it)`;
          out.push(`#${comment.id} on version ${comment.version}${quote}: ${comment.text}`);
        }
      }
      // the source names only the doc, the version and its stored sources, so a second read of the same version gives
      // the same source and the taint list of the session does not grow.
      const untrusted = taint.length
        ? { untrustedSource: `doc #${id} version ${read.version}, written after reading ${sourceNames(taint.map((each) => each.source))}` }
        : {};
      return { content: out.join('\n'), ...untrusted };
    },
  });

  const docList = defineTool({
    name: 'doc_list',
    description: 'List the docs, newest change first, with their ids. Filter by kind, and page with the cursor that the result gives.',
    input: z.object({
      kind: kind.optional(),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z.string().min(1).optional(),
    }),
    risk: 'read',
    async run({ kind: wanted, limit, cursor }, ctx) {
      let page: ReturnType<typeof listDocs>;
      try {
        page = listDocs(db, { limit, ...(wanted ? { kind: wanted } : {}), ...(cursor !== undefined ? { cursor } : {}) });
      } catch (err) {
        if (err instanceof InvalidDocCursor) return { content: err.message, isError: true };
        throw err;
      }
      if (!page.docs.length) return { content: wanted ? `no docs of kind ${wanted}` : 'no docs yet' };
      const out = page.docs.map(
        (doc) =>
          `#${doc.id} [${doc.kind}] ${doc.title} - v${doc.version}, updated ${local(doc.updatedAt, ctx.timeZone)}, ${doc.comments} ${doc.comments === 1 ? 'comment' : 'comments'}`,
      );
      if (page.nextCursor) out.push(`more: cursor ${page.nextCursor}`);
      return { content: out.join('\n'), ...listTaint(page.docs) };
    },
  });

  const docSearch = defineTool({
    name: 'doc_search',
    description: 'Search the newest version of each doc by its title and body. Returns the ids with a snippet; read one with doc_read.',
    input: z.object({
      query: z.string().trim().min(1).max(200),
      kind: kind.optional(),
      limit: z.number().int().min(1).max(20).default(8),
    }),
    risk: 'read',
    async run({ query, kind: wanted, limit }) {
      const result = searchDocs(db, { q: query, limit, ...(wanted ? { kind: wanted } : {}) });
      if (!result.docs.length) return { content: `no doc matches "${query}"` };
      const out = result.docs.map((doc) => `#${doc.id} [${doc.kind}] ${doc.title} - v${doc.version}${doc.snippet ? `: ${doc.snippet}` : ''}`);
      // a snippet is body text, and the tainted flag covers the body of the newest version as well as the title.
      return { content: out.join('\n'), ...listTaint(result.docs) };
    },
  });

  return [docWrite, docUpdate, docRead, docList, docSearch];
}
