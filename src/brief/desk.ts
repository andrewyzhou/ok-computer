import { z } from 'zod';
import type { BriefDelegation } from '../dashboard/brief-types.js';
import type { Db } from '../db/index.js';

// the delegations of the desk track (phase 6 t3), which is built at the same time as this one. the brief reads them
// only when the desk module is there, so this file finds it at run time and never imports it by name: the build and
// the tests pass with and without it.

// the module of the desk track that lists delegations. the name is in a variable, so the type check does not look
// for the file.
export const DESK_MODULE = '../desk/store.js';

// the adapter of the desk module. it is the only place that knows the module, so when the desk track names its real
// export, only DESK_MODULE and DESK_EXPORT change. the expected shape is:
//
//   export function listDelegations(db: Db): Array<{
//     id: number;
//     title: string;
//     status: 'open' | 'waiting' | 'blocked' | 'done' | 'dropped';
//     nextStep?: string | null;
//     waitingOn?: string | { name: string | null; email: string | null } | null;
//     dueAt?: string | null;            // an iso time
//     followUpAt?: string | null;       // an iso time; nextFollowUpAt is read too
//   }>
//
// other fields of a row are ignored. a row that does not have this shape is left out, and a module without the
// function gives null, as a missing module does.
export const DESK_EXPORT = 'listDelegations';

const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

// the desk keeps the person that a delegation waits on as a name and an email. the brief shows the name, else the
// email.
const waitingOn = z
  .union([z.string(), z.object({ name: z.string().nullish(), email: z.string().nullish() })])
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : typeof value === 'string' ? value : (value.name ?? value.email ?? null)));

const rowSchema = z
  .object({
    id: z.number().int(),
    title: z.string(),
    status: z.enum(['open', 'waiting', 'blocked', 'done', 'dropped']),
    nextStep: optionalText,
    waitingOn,
    dueAt: optionalText,
    followUpAt: optionalText,
    nextFollowUpAt: optionalText,
  })
  .transform(
    (row): BriefDelegation => ({
      id: row.id,
      title: row.title,
      status: row.status,
      nextStep: row.nextStep,
      waitingOn: row.waitingOn,
      dueAt: row.dueAt,
      followUpAt: row.followUpAt ?? row.nextFollowUpAt,
    }),
  );

const ACTIVE = new Set<BriefDelegation['status']>(['open', 'waiting', 'blocked']);

// a time that cannot be read is never due.
const by = (iso: string | null, end: number) => iso !== null && Date.parse(iso) <= end;

// the delegations that are due by the end of day or wait on someone (open, waiting or blocked, and either due by the
// end of the day or with a follow-up by then, or waiting on someone), or null when the desk module is not there or
// does not have the expected shape. load imports the desk module, and a test gives its own. this function never
// throws.
export async function readDelegations(db: Db, endOfDay: Date, load: () => Promise<unknown> = () => import(DESK_MODULE)): Promise<BriefDelegation[] | null> {
  try {
    const module = (await load()) as Record<string, unknown> | null | undefined;
    const list = module?.[DESK_EXPORT];
    if (typeof list !== 'function') return null;
    const rows: unknown = await list(db);
    if (!Array.isArray(rows)) return null;
    const end = endOfDay.getTime();
    const delegations: BriefDelegation[] = [];
    for (const row of rows) {
      const parsed = rowSchema.safeParse(row);
      if (!parsed.success) continue;
      const each = parsed.data;
      if (!ACTIVE.has(each.status)) continue;
      if (by(each.dueAt, end) || by(each.followUpAt, end) || each.waitingOn !== null) delegations.push(each);
    }
    const due = (each: BriefDelegation) => (each.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(each.dueAt) || Number.POSITIVE_INFINITY);
    return delegations.sort((a, b) => due(a) - due(b) || a.id - b.id);
  } catch {
    return null;
  }
}
