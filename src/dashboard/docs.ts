import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { diffVersions } from '../docs/diff.js';
import { searchDocs } from '../docs/fts.js';
import { getDoc, getVersion, InvalidDocCursor, listComments, listDocs, listVersions } from '../docs/store.js';
import { errorText } from '../tools/registry.js';
import { mountDocComments } from './docs-comments.js';
import { DOC_KINDS, type DocDetail, type DocListItem, type DocsPage, type DocSummary, type DocVersion } from './docs-types.js';
import { idOf, limitOf } from './params.js';
import type { DashboardDeps } from './server.js';

const Q_CHARS = 200;
const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;
const SLUG_CHARS = 60;
const Q_ERROR = `give q as 1 to ${Q_CHARS} characters`;

// the query of GET /api/docs. q drops each nul character and is trimmed, so a q of only spaces or nul characters is
// refused and never reaches the search. a q that is absent means no search.
const docsQuery = z.object({
  q: z
    .string()
    .transform((raw) => raw.replaceAll('\u0000', '').trim())
    .refine((q) => q.length >= 1 && q.length <= Q_CHARS, Q_ERROR)
    .optional(),
  kind: z.enum(DOC_KINDS, { error: `give kind as one of: ${DOC_KINDS.join(', ')}` }).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

// the first sentence that zod gives, which the page can show.
const firstError = (error: z.ZodError) => error.issues[0]?.message ?? 'the request is not valid';

// a path id is a positive whole number. anything else names no row, so the route answers 404.
const pathId = (c: Context): number | undefined => idOf(c.req.param('id'));

const listItem = (doc: DocSummary): DocListItem => ({ ...doc, snippet: null, marks: [] });

// the name of an exported file. the title is cut to ascii letters and digits, so the name never holds a quote, a
// backslash or a character that a header cannot carry. a title with none of them, for example one of only cjk
// characters or emoji, gives doc-<id>.
export function exportSlug(title: string, id: number): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_CHARS)
    .replace(/^-+|-+$/g, '');
  return slug || `doc-${id}`;
}

// phase 6 t4 owns this module. it mounts GET /api/docs, GET /api/docs/:id, GET /api/docs/:id/diff and
// GET /api/docs/:id/export, and the comment routes of docs-comments.ts. docs/API.md (T4) gives the shapes and the
// errors, and docs-types.ts holds the types. server.ts calls it after the sign-in check, so each route is behind the
// dashboard auth.
export function mountDocs(server: Hono, deps: DashboardDeps): void {
  mountDocComments(server, deps);
  const { db } = deps;
  const notFound = (c: Context, what: string) => c.json({ error: `${what} not found` }, 404);
  // a damaged row is an error that the page shows, not a crash of the request and never an html page.
  const failed = (c: Context, err: unknown) => c.json({ error: errorText(err) }, 500);

  // the version that a query asks for: the newest one when version is absent. a doc that does not exist gives 'doc',
  // and a version that is not a positive whole number or that the doc does not have gives 'version'.
  const versionOf = (c: Context, docId: number | undefined): { ok: true; doc: DocSummary; version: DocVersion } | { ok: false; missing: 'doc' | 'version' } => {
    const doc = docId === undefined ? undefined : getDoc(db, docId);
    if (!doc) return { ok: false, missing: 'doc' };
    const raw = c.req.query('version');
    const number = raw === undefined ? doc.version : idOf(raw);
    const version = number === undefined ? undefined : getVersion(db, doc.id, number);
    return version ? { ok: true, doc, version } : { ok: false, missing: 'version' };
  };

  server.get('/api/docs', (c) => {
    const parsed = docsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const { q, kind, cursor } = parsed.data;
    const limit = limitOf(parsed.data.limit, MAX_PAGE, DEFAULT_PAGE);
    try {
      if (q !== undefined) {
        // a search answers one page, so a cursor given with q is ignored.
        const result = searchDocs(db, { q, ...(kind ? { kind } : {}), limit });
        return c.json({ docs: result.docs, nextCursor: null, mode: result.mode } satisfies DocsPage);
      }
      const page = listDocs(db, { ...(kind ? { kind } : {}), ...(cursor !== undefined ? { cursor } : {}), limit });
      return c.json({ docs: page.docs.map(listItem), nextCursor: page.nextCursor, mode: null } satisfies DocsPage);
    } catch (err) {
      if (err instanceof InvalidDocCursor) return c.json({ error: err.message }, 400);
      return failed(c, err);
    }
  });

  server.get('/api/docs/:id', (c) => {
    try {
      const found = versionOf(c, pathId(c));
      if (!found.ok) return notFound(c, found.missing);
      const { doc, version } = found;
      return c.json({ doc, version, versions: listVersions(db, doc.id), comments: listComments(db, doc.id) } satisfies DocDetail);
    } catch (err) {
      return failed(c, err);
    }
  });

  server.get('/api/docs/:id/diff', (c) => {
    try {
      const id = pathId(c);
      const doc = id === undefined ? undefined : getDoc(db, id);
      if (!doc) return notFound(c, 'doc');
      const from = idOf(c.req.query('from'));
      const to = idOf(c.req.query('to'));
      if (from === undefined || to === undefined) return c.json({ error: 'give from and to as version numbers' }, 400);
      const older = getVersion(db, doc.id, from);
      const newer = getVersion(db, doc.id, to);
      if (!older || !newer) return notFound(c, 'version');
      const side = (version: DocVersion) => ({ version: version.version, title: version.title, body: version.body });
      return c.json(diffVersions({ docId: doc.id, from: side(older), to: side(newer) }));
    } catch (err) {
      return failed(c, err);
    }
  });

  // the page downloads the export with a plain link, so the route also signs in with ?token= (server.ts). the body is
  // the stored text with every byte as it is, also a carriage return or a byte order mark.
  server.get('/api/docs/:id/export', (c) => {
    try {
      const found = versionOf(c, pathId(c));
      if (!found.ok) return notFound(c, found.missing);
      const { doc, version } = found;
      return c.body(version.body, 200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${exportSlug(version.title, doc.id)}-v${version.version}.md"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
    } catch (err) {
      return failed(c, err);
    }
  });
}
