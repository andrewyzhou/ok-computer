import type {
  Delegation,
  DelegationActor,
  DelegationDetail,
  DelegationEvent,
  DelegationEventKind,
  DelegationLink,
  DelegationLinkInput,
  DelegationLinkKind,
  DelegationNudge,
  DelegationStatus,
  WaitingOn,
} from '../dashboard/desk-types.js';
import type { Db } from '../db/index.js';
import { inTransaction } from '../signals/store.js';
import { ACTIVE_STATUSES, hrefOf, isActive, isClosed, personKey } from './shared.js';

// the store of the desk (021_delegations.sql). every change of a delegation writes its history row in the same
// transaction, so the history is complete. the history is append-only: nothing here changes or removes a row of it.
// the callers check their input (lengths, emails, times) with the rules of shared.ts; the store checks only the rules
// of the status.

type Row = Record<string, unknown>;

const str = (value: unknown) => (value === null || value === undefined ? null : String(value));

// who made a change, for the history row.
export interface ChangeBy {
  actor: DelegationActor;
  runId?: string | null;
  toolCallId?: string | null;
  // the session that made the change had read outside text, for example mail. the history row keeps it, so a later
  // list marks the text of the delegation as untrusted even after a reset of that session.
  tainted?: boolean;
}

export interface NewDelegation {
  title: string;
  details?: string | null;
  nextStep?: string | null;
  // a delegation with a person starts as waiting, and one without starts as open.
  waitingOn?: { name?: string | null; email?: string | null } | null;
  // iso times in utc. the caller parses them with parseWhen.
  dueAt?: string | null;
  nextFollowUpAt?: string | null;
  links?: DelegationLinkInput[];
  createdBy: 'agent' | 'owner';
  sessionKey?: string | null;
  runId?: string | null;
}

// a field that is left out stays. null clears it.
export interface DelegationPatch {
  title?: string;
  details?: string | null;
  nextStep?: string | null;
  status?: DelegationStatus;
  waitingOn?: { name?: string | null; email?: string | null } | null;
  dueAt?: string | null;
  nextFollowUpAt?: string | null;
  addLinks?: DelegationLinkInput[];
  removeLinks?: Array<{ kind: DelegationLinkKind; ref: string; account?: string }>;
  note?: string;
  // the patch applies only while the delegation is active and its follow-up time is still this one, else it gives a
  // 409. the follow-up job sets it, so it never changes a delegation that the owner closed or moved while it worked.
  ifFollowUpAt?: string | null;
}

// the result of a change. a 404 is a missing delegation, a 400 an input that breaks a rule of the status, and a 409
// a change that the current status does not allow.
export type StoreResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

const fail = (status: 400 | 404 | 409, error: string): StoreResult<never> => ({ ok: false, status, error });
const notFound = (id: number) => fail(404, `delegation #${id} not found`);

function waitingOf(input: { name?: string | null; email?: string | null } | null | undefined): WaitingOn | null {
  const name = input?.name?.trim() || null;
  const email = input?.email?.trim().toLowerCase() || null;
  return name || email ? { name, email } : null;
}

const linkAccount = (link: { kind: DelegationLinkKind; account?: string | null }) =>
  link.kind === 'thread' || link.kind === 'event' ? (link.account?.trim() ?? '') : '';

function linkRow(row: Row): DelegationLink {
  const kind = String(row.kind) as DelegationLinkKind;
  const ref = String(row.ref);
  const account = String(row.account ?? '');
  return { kind, ref, account: account || null, label: str(row.label), href: hrefOf({ kind, ref }) };
}

function linksOf(db: Db, ids: number[]): Map<number, DelegationLink[]> {
  const byId = new Map<number, DelegationLink[]>(ids.map((id) => [id, []]));
  if (!ids.length) return byId;
  const rows = db
    .prepare(`SELECT * FROM delegation_links WHERE delegationId IN (${ids.map(() => '?').join(', ')}) ORDER BY id`)
    .all(...ids);
  for (const row of rows) byId.get(Number(row.delegationId))?.push(linkRow(row));
  return byId;
}

function toDelegation(row: Row, links: DelegationLink[]): Delegation {
  const waitingOn = waitingOf({ name: str(row.waitingOnName), email: str(row.waitingOnEmail) });
  return {
    id: Number(row.id),
    title: String(row.title),
    details: str(row.details),
    status: String(row.status) as DelegationStatus,
    nextStep: str(row.nextStep),
    waitingOn,
    waitingSince: str(row.waitingSince),
    dueAt: str(row.dueAt),
    nextFollowUpAt: str(row.nextFollowUpAt),
    lastCheckedAt: str(row.lastCheckedAt),
    nudgeCount: Number(row.nudges ?? 0),
    links,
    createdBy: String(row.createdBy) as 'agent' | 'owner',
    sessionKey: str(row.sessionKey),
    runId: str(row.runId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    closedAt: str(row.closedAt),
  };
}

// the delegations of the rows, with their links, in the order of the rows.
export function delegationsOf(db: Db, rows: Row[]): Delegation[] {
  const links = linksOf(
    db,
    rows.map((row) => Number(row.id)),
  );
  return rows.map((row) => toDelegation(row, links.get(Number(row.id)) ?? []));
}

export function getDelegation(db: Db, id: number): Delegation | undefined {
  const row = db.prepare('SELECT * FROM delegations WHERE id = ?').get(id);
  return row ? delegationsOf(db, [row])[0] : undefined;
}

function eventRow(row: Row): DelegationEvent {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.data ?? '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // a damaged row shows with empty data, so one bad row does not hide the rest of the history.
  }
  return {
    id: Number(row.id),
    delegationId: Number(row.delegationId),
    kind: String(row.kind) as DelegationEventKind,
    actor: String(row.actor) as DelegationActor,
    text: str(row.text),
    data,
    runId: str(row.runId),
    toolCallId: str(row.toolCallId),
    createdAt: String(row.createdAt),
  };
}

// the history of a delegation, oldest first.
export function listDelegationEvents(db: Db, delegationId: number): DelegationEvent[] {
  return db.prepare('SELECT * FROM delegation_events WHERE delegationId = ? ORDER BY id').all(delegationId).map(eventRow);
}

function nudgeRow(row: Row): DelegationNudge {
  return {
    id: Number(row.id),
    delegationId: Number(row.delegationId),
    account: String(row.account),
    threadId: String(row.threadId),
    sourceMessageId: str(row.sourceMessageId),
    gmailDraftId: String(row.gmailDraftId ?? ''),
    toAddress: String(row.toAddress),
    subject: String(row.subject),
    body: String(row.body),
    followUpAt: String(row.followUpAt),
    runId: str(row.runId),
    createdAt: String(row.createdAt),
  };
}

// the nudge drafts of a delegation, newest first.
export function listNudges(db: Db, delegationId: number): DelegationNudge[] {
  return db.prepare('SELECT * FROM delegation_nudges WHERE delegationId = ? ORDER BY id DESC').all(delegationId).map(nudgeRow);
}

export function getDelegationDetail(db: Db, id: number): DelegationDetail | undefined {
  const delegation = getDelegation(db, id);
  if (!delegation) return undefined;
  return { ...delegation, history: listDelegationEvents(db, id), nudges: listNudges(db, id) };
}

// appendDelegationEvent writes one history row. the callers in this file call it inside their transaction; the
// follow-up job calls it for the rows that change no field, for example follow_up_checked.
export function appendDelegationEvent(
  db: Db,
  event: { delegationId: number; kind: DelegationEventKind; text?: string | null; data?: Record<string, unknown> } & ChangeBy,
  now: Date,
): DelegationEvent {
  const row = db
    .prepare(
      `INSERT INTO delegation_events (delegationId, kind, actor, text, data, runId, toolCallId, tainted, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      event.delegationId,
      event.kind,
      event.actor,
      event.text ?? null,
      JSON.stringify(event.data ?? {}),
      event.runId ?? null,
      event.toolCallId ?? null,
      event.tainted ? 1 : 0,
      now.toISOString(),
    );
  return eventRow(row!);
}

function addLink(db: Db, delegationId: number, link: DelegationLinkInput, by: ChangeBy, now: Date): boolean {
  const account = linkAccount(link);
  const added = db
    .prepare(
      `INSERT INTO delegation_links (delegationId, kind, ref, account, label, createdAt) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (delegationId, kind, account, ref) DO NOTHING RETURNING id`,
    )
    .get(delegationId, link.kind, link.ref.trim(), account, link.label?.trim() || null, now.toISOString());
  if (!added) return false;
  const data = { kind: link.kind, ref: link.ref.trim(), account: account || null, label: link.label?.trim() || null };
  appendDelegationEvent(db, { delegationId, kind: 'link_added', data, ...by }, now);
  return true;
}

function removeLink(db: Db, delegationId: number, link: { kind: DelegationLinkKind; ref: string; account?: string }, by: ChangeBy, now: Date): boolean {
  const account = linkAccount(link);
  const removed = db
    .prepare('DELETE FROM delegation_links WHERE delegationId = ? AND kind = ? AND account = ? AND ref = ? RETURNING label')
    .get(delegationId, link.kind, account, link.ref.trim());
  if (!removed) return false;
  const data = { kind: link.kind, ref: link.ref.trim(), account: account || null, label: str(removed.label) };
  appendDelegationEvent(db, { delegationId, kind: 'link_removed', data, ...by }, now);
  return true;
}

// createDelegation makes a delegation with its links and its created row. a delegation with a person starts as
// waiting, and the wait starts now.
export function createDelegation(db: Db, input: NewDelegation, by: ChangeBy, now: Date): StoreResult<Delegation> {
  const waitingOn = waitingOf(input.waitingOn);
  const status: DelegationStatus = waitingOn ? 'waiting' : 'open';
  const at = now.toISOString();
  const id = inTransaction(db, () => {
    const row = db
      .prepare(
        `INSERT INTO delegations (title, details, status, nextStep, waitingOnName, waitingOnEmail, waitingOnKey, waitingSince,
           dueAt, nextFollowUpAt, createdBy, sessionKey, runId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.title.trim(),
        input.details?.trim() || null,
        status,
        input.nextStep?.trim() || null,
        waitingOn?.name ?? null,
        waitingOn?.email ?? null,
        personKey(waitingOn),
        waitingOn ? at : null,
        input.dueAt ?? null,
        input.nextFollowUpAt ?? null,
        input.createdBy,
        input.sessionKey ?? null,
        input.runId ?? null,
        at,
        at,
      );
    const id = Number(row!.id);
    const data = {
      title: input.title.trim(),
      status,
      ...(waitingOn ? { waitingOn } : {}),
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      ...(input.nextFollowUpAt ? { nextFollowUpAt: input.nextFollowUpAt } : {}),
    };
    appendDelegationEvent(db, { delegationId: id, kind: 'created', data, ...by }, now);
    for (const link of input.links ?? []) addLink(db, id, link, by, now);
    return id;
  });
  return { ok: true, value: getDelegation(db, id)! };
}

type Field = 'title' | 'details' | 'nextStep' | 'dueAt' | 'nextFollowUpAt';
const FIELDS: readonly Field[] = ['title', 'details', 'nextStep', 'dueAt', 'nextFollowUpAt'];

const sameWaiting = (a: WaitingOn | null, b: WaitingOn | null) => a?.name === b?.name && a?.email === b?.email;

// updateDelegation applies a patch and writes one history row for each kind of change: updated for the plain fields,
// waiting_on for the person, status for the status, link_added and link_removed for each link, and note for the note.
// a patch that changes nothing writes no row. the rules of the status:
// - waiting needs a person, from the patch or from the row. a patch that clears the person of a waiting delegation
//   must also move it to another status.
// - a move into waiting, or a new person while waiting, starts the wait now and sets the nudge count back to 0, so
//   each wait gets its own nudges. a move out of waiting clears the time. the follow-up time stays: on an open or a
//   blocked delegation it is a reminder for the owner, and the follow-up job drafts no nudge for it.
// - done and dropped set closedAt and clear the follow-up. a move back to an active status clears closedAt.
// - a closed delegation takes no follow-up time.
// - a patch with ifFollowUpAt gives a 409 when the delegation is closed or its follow-up time changed.
export function updateDelegation(db: Db, id: number, patch: DelegationPatch, by: ChangeBy, now: Date): StoreResult<Delegation> {
  const before = getDelegation(db, id);
  if (!before) return notFound(id);
  if (patch.ifFollowUpAt !== undefined && (!isActive(before.status) || before.nextFollowUpAt !== patch.ifFollowUpAt)) {
    return fail(409, `delegation #${id} changed while the follow-up ran`);
  }
  const status = patch.status ?? before.status;
  const waitingOn = patch.waitingOn === undefined ? before.waitingOn : waitingOf(patch.waitingOn);
  if (status === 'waiting' && !waitingOn) return fail(400, 'a waiting delegation needs a person or an email to wait on');
  if (isClosed(status) && patch.nextFollowUpAt) return fail(409, `delegation #${id} is ${status}, so it takes no follow-up time`);

  const next: Record<Field, string | null> = {
    title: patch.title === undefined ? before.title : patch.title.trim(),
    details: patch.details === undefined ? before.details : patch.details?.trim() || null,
    nextStep: patch.nextStep === undefined ? before.nextStep : patch.nextStep?.trim() || null,
    dueAt: patch.dueAt === undefined ? before.dueAt : patch.dueAt,
    nextFollowUpAt: isClosed(status) ? null : patch.nextFollowUpAt === undefined ? before.nextFollowUpAt : patch.nextFollowUpAt,
  };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of FIELDS) if (next[field] !== before[field]) changes[field] = { from: before[field], to: next[field] };
  const personChanged = !sameWaiting(before.waitingOn, waitingOn);
  const statusChanged = status !== before.status;
  const waitingSince = status !== 'waiting' ? null : statusChanged || personChanged || !before.waitingSince ? now.toISOString() : before.waitingSince;
  const closedAt = isClosed(status) ? (statusChanged ? now.toISOString() : before.closedAt) : null;
  // a new wait counts its own nudges.
  const newWait = status === 'waiting' && waitingSince !== before.waitingSince;
  const nudges = newWait ? 0 : before.nudgeCount;
  const reset = newWait && before.nudgeCount > 0 ? { nudgesReset: before.nudgeCount } : {};

  inTransaction(db, () => {
    let changed = false;
    if (Object.keys(changes).length || personChanged || statusChanged || waitingSince !== before.waitingSince || closedAt !== before.closedAt) {
      db.prepare(
        `UPDATE delegations SET title = ?, details = ?, nextStep = ?, status = ?, waitingOnName = ?, waitingOnEmail = ?,
           waitingOnKey = ?, waitingSince = ?, dueAt = ?, nextFollowUpAt = ?, closedAt = ?, nudges = ? WHERE id = ?`,
      ).run(
        next.title,
        next.details,
        next.nextStep,
        status,
        waitingOn?.name ?? null,
        waitingOn?.email ?? null,
        personKey(waitingOn),
        waitingSince,
        next.dueAt,
        next.nextFollowUpAt,
        closedAt,
        nudges,
        id,
      );
      changed = true;
    }
    if (Object.keys(changes).length) appendDelegationEvent(db, { delegationId: id, kind: 'updated', data: { changes }, ...by }, now);
    if (personChanged) {
      const data = { name: waitingOn?.name ?? null, email: waitingOn?.email ?? null, followUpAt: next.nextFollowUpAt, ...reset };
      appendDelegationEvent(db, { delegationId: id, kind: 'waiting_on', data, ...by }, now);
    }
    if (statusChanged) {
      const data = { from: before.status, to: status, ...(personChanged ? {} : reset) };
      appendDelegationEvent(db, { delegationId: id, kind: 'status', data, ...by }, now);
    }
    for (const link of patch.removeLinks ?? []) changed = removeLink(db, id, link, by, now) || changed;
    for (const link of patch.addLinks ?? []) changed = addLink(db, id, link, by, now) || changed;
    if (patch.note?.trim()) {
      appendDelegationEvent(db, { delegationId: id, kind: 'note', text: patch.note.trim(), ...by }, now);
      changed = true;
    }
    if (changed) db.prepare('UPDATE delegations SET updatedAt = ? WHERE id = ?').run(now.toISOString(), id);
  });
  return { ok: true, value: getDelegation(db, id)! };
}

// markChecked records a check of the follow-up job that changes no field the owner sees: the time of the check, and
// the next follow-up time. it changes the row only while the delegation is active and its follow-up time is still
// expected, the one that the job read, so a check never puts a follow-up time on a delegation that the owner closed,
// and never overwrites a time that the owner set. it says whether the row changed. the history row of the check is
// the caller's, and the caller writes it only when the row changed.
export function markChecked(db: Db, id: number, change: { expected: string | null; nextFollowUpAt: string | null; nudged?: boolean }, now: Date): boolean {
  const result = db
    .prepare(
      `UPDATE delegations SET lastCheckedAt = ?, nextFollowUpAt = ?, nudges = nudges + ?
       WHERE id = ? AND nextFollowUpAt IS ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})`,
    )
    .run(now.toISOString(), change.nextFollowUpAt, change.nudged ? 1 : 0, id, change.expected, ...ACTIVE_STATUSES);
  return Number(result.changes) > 0;
}

export interface DelegationFilter {
  statuses?: readonly DelegationStatus[];
  // a personKey.
  person?: string;
  // matched as a phrase in the title, the details and the next step, without case.
  q?: string;
  limit?: number;
}

const ESCAPE = /[\\%_]/g;

// sqlite folds only ascii case in lower() and like, so "École" would not find "ÉCOLE". the store folds both sides
// with the same function of javascript instead. each connection gets the function once.
const folding = new WeakSet<Db>();
export const fold = (value: string) => value.normalize('NFC').toLowerCase();

// the where clause of the q filter: the phrase in the title, the details or the next step, without case.
export function textMatch(db: Db, q: string): { sql: string; params: string[] } {
  if (!folding.has(db)) {
    db.function('desk_fold', { deterministic: true }, (value: unknown) => (value === null || value === undefined ? '' : fold(String(value))));
    folding.add(db);
  }
  const pattern = `%${fold(q.trim()).replace(ESCAPE, (char) => `\\${char}`)}%`;
  return {
    sql: "(desk_fold(title) LIKE ? ESCAPE '\\' OR desk_fold(details) LIKE ? ESCAPE '\\' OR desk_fold(nextStep) LIKE ? ESCAPE '\\')",
    params: [pattern, pattern, pattern],
  };
}

// listDelegations gives the delegations of the filter: the active ones by dueAt (rows without one last), then by id,
// and the closed ones after them, the newest closedAt first.
export function listDelegations(db: Db, filter: DelegationFilter = {}): Delegation[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.statuses) {
    if (!filter.statuses.length) return [];
    where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
    params.push(...filter.statuses);
  }
  if (filter.person) {
    where.push('waitingOnKey = ?');
    params.push(filter.person);
  }
  if (filter.q?.trim()) {
    const match = textMatch(db, filter.q);
    where.push(match.sql);
    params.push(...match.params);
  }
  const rows = db
    .prepare(
      `SELECT * FROM delegations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY closedAt IS NOT NULL, closedAt DESC, dueAt IS NULL, dueAt, id ${filter.limit ? 'LIMIT ?' : ''}`,
    )
    .all(...params, ...(filter.limit ? [filter.limit] : []));
  return delegationsOf(db, rows);
}

// the active delegations whose follow-up time is at or before now, the oldest first. the follow-up job reads them.
export function listFollowUpsDue(db: Db, now: Date): Delegation[] {
  const rows = db
    .prepare(
      `SELECT * FROM delegations WHERE nextFollowUpAt IS NOT NULL AND nextFollowUpAt <= ?
         AND status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')}) ORDER BY nextFollowUpAt, id`,
    )
    .all(now.toISOString(), ...ACTIVE_STATUSES);
  return delegationsOf(db, rows);
}

// the read api for the brief (t1). it is stable: the brief imports it from src/desk/index.ts.

// listDue gives the active delegations that are due at or before until, or whose follow-up time is at or before
// until, by dueAt (rows without one last), then by id.
export function listDue(db: Db, until: Date): Delegation[] {
  const at = until.toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM delegations WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
         AND ((dueAt IS NOT NULL AND dueAt <= ?) OR (nextFollowUpAt IS NOT NULL AND nextFollowUpAt <= ?))
       ORDER BY dueAt IS NULL, dueAt, id`,
    )
    .all(...ACTIVE_STATUSES, at, at);
  return delegationsOf(db, rows);
}

// listWaiting gives the delegations that wait on a person, the longest wait first.
export function listWaiting(db: Db): Delegation[] {
  const rows = db.prepare("SELECT * FROM delegations WHERE status = 'waiting' ORDER BY waitingSince, id").all();
  return delegationsOf(db, rows);
}

// listWaitingOn gives the active delegations that wait on a person, by dueAt (rows without one last), then by id. a
// row matches when it waits on one of the emails, or, when it names no email, when its name has the key of name. the
// people profile reads it, and it decides itself which name is specific enough to pass.
export function listWaitingOn(db: Db, who: { emails: readonly string[]; name?: string | null }): Delegation[] {
  const keys = [...new Set(who.emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const nameKey = who.name ? personKey({ name: who.name }) : null;
  if (!keys.length && !nameKey) return [];
  const match: string[] = [];
  const params: string[] = [];
  if (keys.length) {
    match.push(`waitingOnKey IN (${keys.map(() => '?').join(', ')})`);
    params.push(...keys);
  }
  if (nameKey) {
    match.push('(waitingOnEmail IS NULL AND waitingOnKey = ?)');
    params.push(nameKey);
  }
  const rows = db
    .prepare(
      `SELECT * FROM delegations WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')}) AND (${match.join(' OR ')})
       ORDER BY dueAt IS NULL, dueAt, id`,
    )
    .all(...ACTIVE_STATUSES, ...params);
  return delegationsOf(db, rows);
}

// the delegations that link to a thread or an event of an account, for example to find the delegation of a reply.
export function delegationsLinkedTo(db: Db, link: { kind: DelegationLinkKind; ref: string; account?: string }): Delegation[] {
  const rows = db
    .prepare(
      `SELECT delegations.* FROM delegations JOIN delegation_links ON delegation_links.delegationId = delegations.id
       WHERE delegation_links.kind = ? AND delegation_links.account = ? AND delegation_links.ref = ? ORDER BY delegations.id`,
    )
    .all(link.kind, linkAccount(link), link.ref);
  return delegationsOf(db, rows);
}
