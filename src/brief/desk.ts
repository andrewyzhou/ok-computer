import type { BriefDelegation } from '../dashboard/brief-types.js';
import type { Delegation } from '../dashboard/desk-types.js';
import type { Db } from '../db/index.js';
import { listDue, listWaiting } from '../desk/index.js';
import { findPersonByEmail } from '../people/index.js';

// the delegations of the brief, read through the desk read api (src/desk/index.ts): the active ones that are due or
// have a follow-up by the end of the day, and the ones that wait on someone. a delegation that is both shows once.

// the name of the person that a delegation waits on: the name on the delegation, else the name that the people memory
// has for its email, else the email. the people memory is filled only with a google block, so a miss is normal.
function waitingName(db: Db, delegation: Delegation, now: Date): string | null {
  const waitingOn = delegation.waitingOn;
  if (!waitingOn) return null;
  if (waitingOn.name) return waitingOn.name;
  if (!waitingOn.email) return null;
  return findPersonByEmail(db, waitingOn.email, now)?.name ?? waitingOn.email;
}

const dueTime = (each: BriefDelegation) => (each.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(each.dueAt) || Number.POSITIVE_INFINITY);

// readDelegations gives the delegations of the brief by due time (rows without one last), then by id. it throws when
// the desk cannot be read, and the caller then marks the desk as not read.
export function readDelegations(db: Db, endOfDay: Date, now: Date): BriefDelegation[] {
  const rows = new Map<number, Delegation>();
  for (const each of [...listDue(db, endOfDay), ...listWaiting(db)]) rows.set(each.id, each);
  return [...rows.values()]
    .map(
      (each): BriefDelegation => ({
        id: each.id,
        title: each.title,
        status: each.status,
        nextStep: each.nextStep,
        waitingOn: waitingName(db, each, now),
        dueAt: each.dueAt,
        followUpAt: each.nextFollowUpAt,
      }),
    )
    .sort((a, b) => dueTime(a) - dueTime(b) || a.id - b.id);
}
