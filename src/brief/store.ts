import type { Brief, BriefContent, BriefDelivery, BriefsPage } from '../dashboard/brief-types.js';
import type { Db } from '../db/index.js';

// the stored briefs of 025_brief.sql. both tables are append-only: a second brief of a day is a new row, and a second
// try to send it is a new delivery row.

// a cursor that the store did not write. the route answers 400.
export class InvalidBriefCursor extends Error {}

type Row = Record<string, unknown>;

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

// the newest delivery of a brief, or null when the job did not try to send it yet.
function deliveryOf(db: Db, briefId: number): BriefDelivery | null {
  const row = db.prepare('SELECT channel, ok, error, at FROM brief_deliveries WHERE briefId = ? ORDER BY id DESC LIMIT 1').get(briefId);
  return row ? { channel: text(row.channel), ok: Number(row.ok) === 1, error: text(row.error), at: String(row.at) } : null;
}

// a row whose content is not valid json throws, so the dashboard answers 500 and never shows half a brief.
function briefOf(db: Db, row: Row): Brief {
  const id = Number(row.id);
  return {
    id,
    day: String(row.day),
    runId: text(row.runId),
    createdAt: String(row.createdAt),
    shortText: String(row.shortText),
    content: JSON.parse(String(row.content)) as BriefContent,
    delivery: deliveryOf(db, id),
  };
}

export function saveBrief(db: Db, input: { day: string; runId: string | null; shortText: string; content: BriefContent }, now: Date): Brief {
  const result = db
    .prepare('INSERT INTO briefs (day, runId, createdAt, shortText, content) VALUES (?, ?, ?, ?, ?)')
    .run(input.day, input.runId, now.toISOString(), input.shortText, JSON.stringify(input.content));
  return { id: Number(result.lastInsertRowid), day: input.day, runId: input.runId, createdAt: now.toISOString(), shortText: input.shortText, content: input.content, delivery: null };
}

export function recordDelivery(db: Db, briefId: number, delivery: Omit<BriefDelivery, 'at'>, now: Date): BriefDelivery {
  db.prepare('INSERT INTO brief_deliveries (briefId, channel, ok, error, at) VALUES (?, ?, ?, ?, ?)').run(
    briefId,
    delivery.channel,
    delivery.ok ? 1 : 0,
    delivery.error,
    now.toISOString(),
  );
  return { ...delivery, at: now.toISOString() };
}

// one brief by id, or the newest one.
export function getBrief(db: Db, id: number | 'latest'): Brief | undefined {
  const row = id === 'latest' ? db.prepare('SELECT * FROM briefs ORDER BY id DESC LIMIT 1').get() : db.prepare('SELECT * FROM briefs WHERE id = ?').get(id);
  return row ? briefOf(db, row) : undefined;
}

// the newest brief of a day.
export function briefOfDay(db: Db, day: string): Brief | undefined {
  const row = db.prepare('SELECT * FROM briefs WHERE day = ? ORDER BY id DESC LIMIT 1').get(day);
  return row ? briefOf(db, row) : undefined;
}

function cursorId(cursor: string): number {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new InvalidBriefCursor();
  return Number(id);
}

// the number of items of a stored content. a damaged content counts as no items in the list, and the brief itself
// answers 500 when it is opened.
function itemsOf(content: unknown): number {
  try {
    const parsed = JSON.parse(String(content)) as Partial<BriefContent>;
    return (parsed.sections ?? []).reduce((sum, section) => sum + (Array.isArray(section.items) ? section.items.length : 0), 0);
  } catch {
    return 0;
  }
}

// newest first, by id. limit is already clamped by the route. a cursor that cannot be read throws InvalidBriefCursor.
export function listBriefs(db: Db, query: { cursor?: string; limit: number }): BriefsPage {
  const before = query.cursor === undefined ? undefined : cursorId(query.cursor);
  const rows = db
    .prepare(
      `SELECT b.id, b.day, b.createdAt, b.content,
         (SELECT d.ok FROM brief_deliveries d WHERE d.briefId = b.id ORDER BY d.id DESC LIMIT 1) AS sent
       FROM briefs b ${before === undefined ? '' : 'WHERE b.id < ?'} ORDER BY b.id DESC LIMIT ?`,
    )
    .all(...(before === undefined ? [] : [before]), query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    briefs: page.map((row) => ({ id: Number(row.id), day: String(row.day), createdAt: String(row.createdAt), items: itemsOf(row.content), sent: Number(row.sent) === 1 })),
    nextCursor: rows.length > query.limit && last ? Buffer.from(String(last.id)).toString('base64url') : null,
  };
}
