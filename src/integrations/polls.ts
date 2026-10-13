import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { createAutomation, listAutomations, updateAutomation } from '../scheduler/store.js';
import type { IntegrationEntry } from './config.js';

export const POLL_EVERY_MS = 15 * 60_000;
// the ids of the entries that had a poll at the last sync.
const SYNCED = 'polls-synced';

const polled = (entries: IntegrationEntry[], id: string) => entries.some((entry) => entry.id === id && entry.kind === 'mcp-http' && entry.poll);

// each polled integration has one system automation, so the scheduler gives the poll its claim, backoff, history and
// run now. syncPolls follows the config at each start, like the heartbeat. a poll that the owner or the scheduler
// turned off stays off, and the automation of an entry that lost its poll is turned off. when the config gives that
// entry a poll again, the owner changed the config, so the automation is turned on again.
export function syncPolls(db: Db, entries: IntegrationEntry[], now: Date, timeZone: string): void {
  const automations = listAutomations(db).flatMap((automation) =>
    automation.payload.type === 'integration_poll' ? [{ automation, integration: automation.payload.integration }] : [],
  );
  // without the row, each automation counts as polled at the last sync, so a poll that is off stays off.
  const synced = getSetting<string[]>(db, SYNCED) ?? automations.map((each) => each.integration);
  for (const entry of entries) {
    if (entry.kind !== 'mcp-http' || !entry.poll) continue;
    const existing = automations.find((each) => each.integration === entry.id)?.automation;
    if (existing) {
      if (!existing.enabled && !synced.includes(entry.id)) updateAutomation(db, existing.id, { enabled: true }, now, timeZone);
      continue;
    }
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
  setSetting(db, SYNCED, entries.filter((entry) => polled(entries, entry.id)).map((entry) => entry.id), now);
}
