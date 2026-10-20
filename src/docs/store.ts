import type { Result } from '../config/load.js';
import type { SQLInputValue } from 'node:sqlite';
import type { Db } from '../db/index.js';
import type { TaintSource } from '../policy/policy.js';
import { inTransaction } from '../signals/store.js';
import {
  DOC_KINDS,
  type DocAuthor,
  type DocComment,
  type DocKind,
  type DocLink,
  type DocSummary,
  type DocVersion,
  type DocVersionMeta,
} from '../dashboard/docs-types.js';

// the store of the docs (022_docs.sql). every change is a new row in doc_versions, and the docs row is the view of the
// newest one. the tools, the dashboard and the comments read and write docs only through this file.

export const TITLE_CHARS = 200;
export const BODY_CHARS = 200_000;
export const NOTE_CHARS = 500;
export const LINKS_MAX = 20;
export const LABEL_CHARS = 200;
export const HREF_CHARS = 2_000;

export interface NewDoc {
  title: string;
  kind: DocKind;
  body: string;
  links?: DocLink[];
  author: DocAuthor;
  note?: string;
  // the taint of the writing session (sessionTaint of src/policy/store.ts). the owner's own version has none.
  taint?: TaintSource[];
  sessionKey?: string | null;
  runId?: string | null;
  toolCallId?: string | null;
}

// a change gives only the fields that change. the new version copies the others from the newest version. baseVersion
// is the version that the writer read: when the doc has a newer version, the change is refused, so a writer never
// overwrites a version that it did not see.
export interface DocChange {
  title?: string;
  kind?: DocKind;
  body?: string;
  links?: DocLink[];
  author: DocAuthor;
  note?: string;
  taint?: TaintSource[];
  baseVersion?: number;
  sessionKey?: string | null;
  runId?: string | null;
  toolCallId?: string | null;
}

export interface DocListInput {
  kind?: DocKind;
  cursor?: string;
  limit: number;
}

export class InvalidDocCursor extends Error {
  constructor() {
    super('give cursor as the nextCursor of the last page');
  }
}

type Row = Record<string, unknown>;

export const isDocKind = (value: unknown): value is DocKind => typeof value === 'string' && (DOC_KINDS as readonly string[]).includes(value);

// an http(s) url or a hash of the web app. a hash may not hold a second scheme, so #/x is fine and #javascript: is not.
// the url parser drops spaces at the ends and tabs and line breaks inside, so a stored href could differ from the url
// that the parser checked. such an href is refused, and the href that a page gets is the one that was checked.
export function isSafeHref(href: string): boolean {
  if (href.length === 0 || href.length > HREF_CHARS) return false;
  if (/[\u0000-\u001f\u007f]/.test(href) || href.trim() !== href) return false;
  if (href.startsWith('#/')) return !href.includes('\\');
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// the checks that each version passes. the tool schemas check the same limits, so a model gets the error before the
// store, and the dashboard and the seed get it here.
function checkFields(fields: { title: string; body: string; links: DocLink[]; note?: string | undefined }): string | undefined {
  if (!fields.title.trim()) return 'give the doc a title';
  // the store keeps the title trimmed, so the limit counts the trimmed title.
  if (fields.title.trim().length > TITLE_CHARS) return `the title has more than ${TITLE_CHARS} characters`;
  if (fields.body.length > BODY_CHARS) return `the body has more than ${BODY_CHARS} characters; split it into several docs`;
  if (fields.note !== undefined && fields.note.length > NOTE_CHARS) return `the note has more than ${NOTE_CHARS} characters`;
  if (fields.links.length > LINKS_MAX) return `a doc has at most ${LINKS_MAX} links`;
  for (const link of fields.links) {
    if (!link.label.trim() || link.label.length > LABEL_CHARS) return `each link needs a label of 1 to ${LABEL_CHARS} characters`;
    if (!isSafeHref(link.href)) return `the link ${link.href.slice(0, 100)} is not an http(s) url or a #/ link of the dashboard`;
  }
  return undefined;
}

const str = (value: unknown) => (value === null || value === undefined ? null : String(value));

const UNREADABLE_TAINT: TaintSource = { source: 'a doc version whose taint cannot be read', toolName: 'doc_read', runId: null, toolCallId: '', at: '' };

const isTaintSource = (value: unknown): value is TaintSource =>
  typeof value === 'object' && value !== null && typeof (value as { source?: unknown }).source === 'string';

// a damaged list still marks the version, so its text is never read as trusted. a list that is not json, a json value
// that is not a list, and a list with an entry that is not a source all count as damaged.
function parseTaint(value: unknown): TaintSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? '[]'));
  } catch {
    return [UNREADABLE_TAINT];
  }
  if (!Array.isArray(parsed)) return [UNREADABLE_TAINT];
  const sources = parsed.filter(isTaintSource);
  return sources.length === parsed.length ? sources : [...sources, UNREADABLE_TAINT];
}

// the full taint of one version, for doc_read. the dashboard shows only the names.
export function versionTaint(db: Db, docId: number, version: number): TaintSource[] {
  const row = db.prepare('SELECT taint FROM doc_versions WHERE docId = ? AND version = ?').get(docId, version);
  return row ? parseTaint(row.taint) : [];
}

function mergeTaint(a: TaintSource[], b: TaintSource[]): TaintSource[] {
  const sources = new Map<string, TaintSource>();
  for (const each of [...a, ...b]) if (!sources.has(each.source)) sources.set(each.source, each);
  return [...sources.values()];
}

function parseLinks(value: unknown): DocLink[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown;
    if (!Array.isArray(parsed)) return [];
    // a row is only read back as it was written, but a link that is not safe never reaches a page.
    return parsed.filter(
      (each): each is DocLink => typeof each?.label === 'string' && typeof each?.href === 'string' && isSafeHref(each.href),
    );
  } catch {
    return [];
  }
}

function toSummary(row: Row): DocSummary {
  return {
    id: Number(row.id),
    title: String(row.title),
    kind: String(row.kind) as DocKind,
    author: String(row.author) as DocAuthor,
    tainted: parseTaint(row.taint).length > 0,
    version: Number(row.version),
    chars: Number(row.chars ?? 0),
    comments: Number(row.comments ?? 0),
    sessionKey: str(row.sessionKey),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function toMeta(row: Row): DocVersionMeta {
  return {
    version: Number(row.version),
    title: String(row.title),
    kind: String(row.kind) as DocKind,
    author: String(row.author) as DocAuthor,
    note: str(row.note),
    runId: str(row.runId),
    toolCallId: str(row.toolCallId),
    chars: Number(row.chars ?? 0),
    taint: parseTaint(row.taint).map((each) => each.source),
    createdAt: String(row.createdAt),
  };
}

// the summary columns. chars and comments come from the newest version and the comment table. d is the docs row and v
// is its newest version.
const SUMMARY_COLUMNS = `d.id, d.title, d.kind, d.version, d.sessionKey, d.createdAt, d.updatedAt,
    v.author, v.taint, length(v.body) AS chars,
    (SELECT count(*) FROM doc_comments c WHERE c.docId = d.id) AS comments`;
const SUMMARY_FROM = 'FROM docs d JOIN doc_versions v ON v.docId = d.id AND v.version = d.version';
const SUMMARY_SQL = `SELECT ${SUMMARY_COLUMNS}\n  ${SUMMARY_FROM}`;

export interface SummaryWithBody {
  summary: DocSummary;
  // the body of the newest version.
  body: string;
}

// the docs that pass a filter, newest updatedAt first and then the higher id, at most limit of them, each with the
// body of its newest version. the search of fts.ts uses it. where is sql text over d and v that the caller writes, and
// it never holds text of a user: each value goes in params and is bound by name, for example $q.
export function summariesWithBody(db: Db, where: string, params: Record<string, SQLInputValue>, limit: number): SummaryWithBody[] {
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS}, v.body AS body\n  ${SUMMARY_FROM}\n  WHERE ${where}\n  ORDER BY d.updatedAt DESC, d.id DESC LIMIT $limit`)
    .all({ ...params, limit })
    .map((row) => ({ summary: toSummary(row), body: String(row.body) }));
}

type VersionFields = Omit<NewDoc, 'links'> & { links: DocLink[] };

function insertVersion(db: Db, docId: number, version: number, fields: VersionFields, at: string): void {
  db.prepare(
    `INSERT INTO doc_versions (docId, version, title, kind, body, links, author, note, taint, sessionKey, runId, toolCallId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    docId,
    version,
    fields.title.trim(),
    fields.kind,
    fields.body,
    JSON.stringify(fields.links),
    fields.author,
    fields.note ?? null,
    JSON.stringify(fields.taint ?? []),
    fields.sessionKey ?? null,
    fields.runId ?? null,
    fields.toolCallId ?? null,
    at,
  );
}

export function createDoc(db: Db, input: NewDoc, now: Date): Result<DocSummary> {
  const links = input.links ?? [];
  const error = checkFields({ ...input, links });
  if (error) return { ok: false, error };
  const at = now.toISOString();
  const id = inTransaction(db, () => {
    const row = db
      .prepare(
        `INSERT INTO docs (title, kind, links, author, version, sessionKey, runId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?) RETURNING id`,
      )
      .get(input.title.trim(), input.kind, JSON.stringify(links), input.author, input.sessionKey ?? null, input.runId ?? null, at, at);
    const docId = Number(row!.id);
    insertVersion(db, docId, 1, { ...input, links }, at);
    return docId;
  });
  return { ok: true, value: getDoc(db, id)! };
}

// a change with no field that differs from the newest version is refused, so the history holds no empty versions.
export function addVersion(db: Db, docId: number, change: DocChange, now: Date): Result<DocSummary> {
  const at = now.toISOString();
  const result = inTransaction(db, (): Result<number> => {
    const doc = db.prepare('SELECT version FROM docs WHERE id = ?').get(docId);
    if (!doc) return { ok: false, error: `doc #${docId} not found` };
    const current = getVersion(db, docId, Number(doc.version))!;
    if (change.baseVersion !== undefined && change.baseVersion !== current.version) {
      return { ok: false, error: `doc #${docId} is at version ${current.version}, not ${change.baseVersion}. Read it again before you change it` };
    }
    const next = {
      title: change.title ?? current.title,
      kind: change.kind ?? current.kind,
      body: change.body ?? current.body,
      links: change.links ?? current.links,
      author: change.author,
      ...(change.note !== undefined ? { note: change.note } : {}),
      // the new body can keep text of an old version, so the taint of a doc only grows.
      taint: mergeTaint(versionTaint(db, docId, current.version), change.taint ?? []),
      sessionKey: change.sessionKey ?? null,
      runId: change.runId ?? null,
      toolCallId: change.toolCallId ?? null,
    };
    const error = checkFields(next);
    if (error) return { ok: false, error };
    const same =
      next.title.trim() === current.title && next.kind === current.kind && next.body === current.body && JSON.stringify(next.links) === JSON.stringify(current.links);
    if (same) return { ok: false, error: `the change gives doc #${docId} no new title, kind, body or links` };
    const version = current.version + 1;
    insertVersion(db, docId, version, next, at);
    db.prepare('UPDATE docs SET title = ?, kind = ?, links = ?, author = ?, version = ?, updatedAt = ? WHERE id = ?').run(
      next.title.trim(),
      next.kind,
      JSON.stringify(next.links),
      next.author,
      version,
      at,
      docId,
    );
    return { ok: true, value: docId };
  });
  return result.ok ? { ok: true, value: getDoc(db, result.value)! } : result;
}

export function getDoc(db: Db, id: number): DocSummary | undefined {
  const row = db.prepare(`${SUMMARY_SQL} WHERE d.id = ?`).get(id);
  return row ? toSummary(row) : undefined;
}

export function getVersion(db: Db, docId: number, version: number): DocVersion | undefined {
  const row = db.prepare('SELECT *, length(body) AS chars FROM doc_versions WHERE docId = ? AND version = ?').get(docId, version);
  return row ? { ...toMeta(row), body: String(row.body), links: parseLinks(row.links) } : undefined;
}

// newest first.
export function listVersions(db: Db, docId: number): DocVersionMeta[] {
  return db
    .prepare('SELECT version, title, kind, author, note, taint, runId, toolCallId, length(body) AS chars, createdAt FROM doc_versions WHERE docId = ? ORDER BY version DESC')
    .all(docId)
    .map(toMeta);
}

interface Cursor {
  updatedAt: string;
  id: number;
}

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(value: string): Cursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    return typeof parsed.updatedAt === 'string' && Number.isSafeInteger(parsed.id) ? { updatedAt: parsed.updatedAt, id: parsed.id! } : undefined;
  } catch {
    return undefined;
  }
}

// newest updatedAt first, then the higher id. a cursor that cannot be read throws InvalidDocCursor, and the route
// answers 400.
export function listDocs(db: Db, input: DocListInput): { docs: DocSummary[]; nextCursor: string | null } {
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !cursor) throw new InvalidDocCursor();
  const rows = db
    .prepare(
      `${SUMMARY_SQL}
       WHERE ($kind IS NULL OR d.kind = $kind)
         AND ($at IS NULL OR d.updatedAt < $at OR (d.updatedAt = $at AND d.id < $id))
       ORDER BY d.updatedAt DESC, d.id DESC LIMIT $limit`,
    )
    .all({ kind: input.kind ?? null, at: cursor?.updatedAt ?? null, id: cursor?.id ?? null, limit: input.limit + 1 })
    .map(toSummary);
  const docs = rows.slice(0, input.limit);
  const last = docs.at(-1);
  return { docs, nextCursor: rows.length > input.limit && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null };
}

// the comments of a doc, oldest first, with the event that carried each one. src/docs/comments.ts writes them.
export function listComments(db: Db, docId: number): DocComment[] {
  return db
    .prepare(
      `SELECT c.*, d.eventId, d.deliveredAt FROM doc_comments c LEFT JOIN doc_comment_deliveries d ON d.commentId = c.id
       WHERE c.docId = ? ORDER BY c.id`,
    )
    .all(docId)
    .map((row) => ({
      id: Number(row.id),
      docId: Number(row.docId),
      version: Number(row.version),
      quote: str(row.quote),
      text: String(row.text),
      author: 'owner' as const,
      sessionKey: String(row.sessionKey),
      eventId: row.eventId === null || row.eventId === undefined ? null : Number(row.eventId),
      deliveredAt: str(row.deliveredAt),
      createdAt: String(row.createdAt),
    }));
}

// the hash of a doc in the web app. the tools put it after the dashboard url, so a chat link opens the doc.
export const docHash = (id: number, version?: number) => `#/docs/${id}${version === undefined ? '' : `?version=${version}`}`;
