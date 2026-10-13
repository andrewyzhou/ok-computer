import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { listAutomations, updateAutomation } from '../scheduler/store.js';
import { parseIntegrations } from './config.js';
import { POLL_EVERY_MS, syncPolls } from './polls.js';

const entry = (id: string, poll: boolean) => ({
  id,
  kind: 'mcp-http',
  url: 'https://mcp.slack.com/mcp',
  tools: { allow: ['slack_search_public_and_private', 'slack_read_user_profile'] },
  ...(poll ? { poll: 'slack-dms' } : {}),
});

const parse = (...items: unknown[]) => {
  const parsed = parseIntegrations({ integrations: items });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe('syncPolls', () => {
  it('creates one system automation for each polled entry, keeps a poll that the owner turned off, and turns off the poll of an entry without one', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-10-13T16:00:00Z');
    const polls = () =>
      listAutomations(db)
        .filter((automation) => automation.payload.type === 'integration_poll')
        .map(({ name, payload, schedule, enabled, createdBy, slot }) => ({ name, payload, schedule, enabled, createdBy, slot }));
    syncPolls(db, parse(entry('slack-work', true), entry('slack-home', true), entry('plain', false)), now, 'UTC');
    expect(polls()).toEqual([
      {
        name: 'poll slack-home (slack-dms)',
        payload: { type: 'integration_poll', integration: 'slack-home' },
        schedule: { kind: 'every', everyMs: POLL_EVERY_MS },
        enabled: true,
        createdBy: 'system',
        slot: 'utility',
      },
      expect.objectContaining({ name: 'poll slack-work (slack-dms)', enabled: true }),
    ]);

    // a second start creates nothing new.
    syncPolls(db, parse(entry('slack-work', true), entry('slack-home', true)), now, 'UTC');
    expect(polls()).toHaveLength(2);

    // the owner turns one off, and a start keeps it off.
    const work = listAutomations(db).find((automation) => automation.name === 'poll slack-work (slack-dms)')!;
    updateAutomation(db, work.id, { enabled: false }, now, 'UTC');
    syncPolls(db, parse(entry('slack-work', true), entry('slack-home', true)), now, 'UTC');
    expect(polls().find((poll) => poll.name.includes('slack-work'))!.enabled).toBe(false);

    // slack-home loses its poll, and its automation is turned off.
    syncPolls(db, parse(entry('slack-work', true), entry('slack-home', false)), now, 'UTC');
    expect(polls().find((poll) => poll.name.includes('slack-home'))!.enabled).toBe(false);
  });
});
