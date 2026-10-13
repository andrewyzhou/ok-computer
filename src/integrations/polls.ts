import type { Db } from '../db/index.js';
import { createAutomation, listAutomations, updateAutomation } from '../scheduler/store.js';
import type { IntegrationEntry } from './config.js';

export const POLL_EVERY_MS = 15 * 60_000;

const polled = (entries: IntegrationEntry[], id: string) => entries.some((entry) => entry.id === id && entry.kind === 'mcp-http' && entry.poll);

// each polled integration has one system automation, so the scheduler gives the poll its claim, backoff, history and
// run now. syncPolls follows the config at each start, like the heartbeat. a poll that the owner or the scheduler
// turned off stays off, and the automation of an entry that lost its poll is turned off.
export function syncPolls(db: Db, entries: IntegrationEntry[], now: Date, timeZone: string): void {
  const automations = listAutomations(db).flatMap((automation) =>
    automation.payload.type === 'integration_poll' ? [{ automation, integration: automation.payload.integration }] : [],
  );
  for (const entry of entries) {
    if (entry.kind !== 'mcp-http' || !entry.poll || automations.some((each) => each.integration === entry.id)) continue;
    createAutomation(
      db,
      {
        name: `poll ${entry.id} (${entry.poll})`,
        schedule: { kind: 'every', everyMs: POLL_EVERY_MS },
        payload: { type: 'integration_poll', integration: entry.id },
        slot: 'utility',
        createdBy: 'system',
      },
      now,
      timeZone,
    );
  }
  for (const { automation, integration } of automations) {
    if (automation.enabled && !polled(entries, integration)) updateAutomation(db, automation.id, { enabled: false }, now, timeZone);
  }
}
