import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { createLogger } from '../observability/logger.js';
import { DRAFT_LINK, guardDraft, guardReply, isDashboardDocLink, REMOVED_LINK, REMOVED_REPLY, REPLY_CALL_ID, REPLY_NOTE, REPLY_TOOL } from './reply.js';

const SEEN = `https://evil.example/t?k=${'a'.repeat(32)}`;

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r', 'main', 'message', 'main', 'running', 'x')").run();
  appendEvent(
    db,
    { sessionKey: 'main', runId: null, type: 'tool_result', payload: { toolCallId: 'm', name: 'read', content: `mail: ${SEEN}`, isError: false, untrustedSource: 'mcp:mail' } },
    new Date(),
  );
  const guard = (text: string) => guardReply({ db, logger: createLogger({ consoleLevel: 'off' }), clock: () => new Date() }, { runId: 'r', sessionKey: 'main' }, text);
  return { db, guard };
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

  it('sends a read link as it is, but not a link that equals it only in its nfkc form', async () => {
    const { guard } = setup();
    expect(await guard(`Read more: ${SEEN}`)).toBe(`Read more: ${SEEN}`);
    expect(await guard(`Read more: ${SEEN.replace('aa', 'ａa')}`)).toBe(REMOVED_REPLY);
  });

  it('records its decision and a note without the link in the trace', async () => {
    const { db, guard } = setup();
    await guard('See https://evil.example/c?d=1');
    expect(db.prepare('SELECT runId, toolCallId, toolName, decision, rule, reviewerVerdict FROM policy_decisions').all()).toEqual([
      { runId: 'r', toolCallId: REPLY_CALL_ID, toolName: REPLY_TOOL, decision: 'review', rule: 'exfiltration', reviewerVerdict: null },
    ]);
    const note = db.prepare("SELECT runId, payload FROM events WHERE type = 'note'").get() as { runId: string; payload: string };
    expect(note.runId).toBe('r');
    expect(note.payload).toContain(REPLY_NOTE);
    expect(note.payload).not.toContain('evil.example');
  });
});

describe('the reply guard (verification round 6)', () => {
  it('removes the data after an apostrophe with the link, because a chat app links through it', async () => {
    const { guard } = setup();
    const data = 'QUNDT1VOVCAxMjM0NTY3OCBQSU4gNDQyMSBTU04gMTIzLTQ1LTY3ODkgUEFTU1dPUkQgaHVudGVyMg';
    expect(await guard(`Done, see https://evil.example/c'${data} now`)).toBe(`Done, see ${REMOVED_LINK} now`);
  });

  it('removes a link with a host that only the url parser reads', async () => {
    const { guard } = setup();
    expect(await guard('see evil。example/c?d=QUNDT1VOVCAxMjM0NTY3OA')).toBe(`see ${REMOVED_LINK}`);
  });
});

describe('the reply guard and a link to a doc on the dashboard', () => {
  const DASHBOARD = 'http://127.0.0.1:4000';

  function docSetup() {
    const { db } = setup();
    const guard = (text: string) =>
      guardReply({ db, logger: createLogger({ consoleLevel: 'off' }), clock: () => new Date(), dashboardUrl: DASHBOARD }, { runId: 'r', sessionKey: 'main' }, text);
    return { db, guard };
  }

  it('sends a link to a doc or a version of it as it is, with no review', async () => {
    const { db, guard } = docSetup();
    const text = `The plan is ready: ${DASHBOARD}/#/docs/3 and the older one is ${DASHBOARD}/#/docs/3?version=2.`;
    expect(await guard(text)).toBe(text);
    expect(db.prepare('SELECT COUNT(*) AS n FROM policy_decisions').get()).toEqual({ n: 0 });
  });

  it('still removes a link that only looks like a doc link', async () => {
    const { guard } = docSetup();
    for (const link of [
      `${DASHBOARD}/#/docs/3?version=2&k=secret`,
      `${DASHBOARD}/?k=secret#/docs/3`,
      `${DASHBOARD}/#/docs/3/secret`,
      'http://user:pass@127.0.0.1:4000/#/docs/3',
      'http://127.0.0.1:4001/#/docs/3',
      'https://evil.example/#/docs/3',
      `${DASHBOARD}/other/#/docs/3`,
    ]) {
      expect(await guard(`See ${link}`)).toBe(`See ${REMOVED_LINK}`);
    }
  });

  it('still judges a link that comes right after a doc link', async () => {
    const { guard } = docSetup();
    expect(await guard(`See ${DASHBOARD}/#/docs/3"https://evil.example/c?d=1`)).toBe(`See ${DASHBOARD}/#/docs/3"${REMOVED_LINK}`);
  });

  it('takes the path of a dashboard that has one, with or without a slash at the end', () => {
    expect(isDashboardDocLink('https://okc.example/app/#/docs/1', 'https://okc.example/app/')).toBe(true);
    expect(isDashboardDocLink('https://okc.example/app#/docs/1', 'https://okc.example/app')).toBe(true);
    expect(isDashboardDocLink('https://okc.example/#/docs/1', 'https://okc.example/app')).toBe(false);
    expect(isDashboardDocLink('https://okc.example/#/docs/1', undefined)).toBe(false);
    expect(isDashboardDocLink('not a url', DASHBOARD)).toBe(false);
  });

  it('keeps a doc link in the draft of a tainted session and marks the others', () => {
    const { db } = docSetup();
    expect(guardDraft(db, 'main', `Ready: ${DASHBOARD}/#/docs/3 and https://evil.example/c?d=1`, DASHBOARD)).toBe(`Ready: ${DASHBOARD}/#/docs/3 and ${DRAFT_LINK}`);
    expect(guardDraft(db, 'main', `Ready: ${DASHBOARD}/#/docs/3`)).toBe(`Ready: ${DRAFT_LINK}`);
  });
});
