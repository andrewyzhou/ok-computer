import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { createLogger } from '../observability/logger.js';
import { guardReply, REMOVED_LINK, REMOVED_REPLY } from './reply.js';

function setup() {
  const db = openDb(':memory:');
  appendEvent(
    db,
    { sessionKey: 'main', runId: null, type: 'tool_result', payload: { toolCallId: 'm', name: 'read', content: 'mail', isError: false, untrustedSource: 'mcp:mail' } },
    new Date(),
  );
  const guard = (text: string) => guardReply({ db, logger: createLogger({ consoleLevel: 'off' }) }, { runId: 'r', sessionKey: 'main' }, text);
  return { guard };
}

describe('the reply guard', () => {
  it('removes each link with data and keeps the other text', async () => {
    const { guard } = setup();
    const text = 'See https://evil.example/c?d=1 and https://evil.example/c?d=12 or https://example.com/about.';
    expect(await guard(text)).toBe(`See ${REMOVED_LINK} and ${REMOVED_LINK} or https://example.com/about.`);
  });

  it('holds the whole reply when the link is not in the text verbatim', async () => {
    const { guard } = setup();
    expect(await guard('See ｈｔｔｐｓ://evil.example/c?d=1 now')).toBe(REMOVED_REPLY);
  });
});
