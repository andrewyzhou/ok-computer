import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDashboard } from '../src/dashboard/server.js';
import { setSetting } from '../src/db/settings.js';
import { createBlobStore } from '../src/observability/blobs.js';
import { createByteStore } from '../src/observability/byte-blobs.js';
import { silentLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';

// the start and the end marks of a jpeg. the routes and the page never decode it.
export const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

// a closed task with an open step that blocked an off-list frame and an approved submit that sent one post, and a
// crashed task whose damaged row names a file outside the trace folder. google pauses after its second captcha.
export function seedBrowser() {
  const t = createTestApp([], { start: '2026-10-13T17:00:00Z' });
  const clock = () => new Date('2026-10-13T17:00:00Z');
  const blobs = createBlobStore(t.db, join(t.dataDir, 'blobs'), clock);
  const bytes = createByteStore(t.db, join(t.dataDir, 'blobs'), clock);
  const snapshot = blobs.put('- button "Buy now" [ref=s1e7]');
  const shot = bytes.put(JPEG, 'image/jpeg');
  t.db.exec(`
    INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('run-1', 'main', 'message', 'main', 'completed', '2026-10-13T17:00:00Z');
    INSERT INTO approvals (id, runId, toolName, input, summary, status, requestedAt) VALUES (7, 'run-1', 'browser_submit', '{}', 'browser_submit', 'approved', '2026-10-13T17:00:02Z');
    INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, approvalId, createdAt)
      VALUES ('run-1', 'c2', 'browser_submit', 'approve', 'risk:external', 'external', 7, '2026-10-13T17:00:02Z');
    INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, riskLevel)
      VALUES ('run-1', 'approval-7', 'browser_submit', '{}', '{}', 0, 10, '2026-10-13T17:00:03Z', 'external');
    INSERT INTO browser_tasks (id, kind, sessionKey, runId, allowlist, status, endReason, tracePath, traceBytes, startedAt, endedAt)
      VALUES ('bt_1', 'task', 'main', 'run-1', '["shop.example"]', 'closed', 'the agent closed it', 'traces/bt_1.zip', 4, '2026-10-13T17:00:00Z', '2026-10-13T17:01:00Z');
    INSERT INTO browser_tasks (id, kind, sessionKey, allowlist, status, endReason, tracePath, traceError, startedAt)
      VALUES ('bt_2', 'task', 'main', '[]', 'crashed', 'the browser stopped', '../../okc.sqlite', 'the browser stopped before the trace was saved', '2026-10-13T17:02:00Z');
    INSERT INTO browser_steps (taskId, runId, toolCallId, action, target, urlBefore, urlAfter, snapshotBlob, screenshotBlob, blockedRequests, offsiteHosts, durationMs, createdAt)
      VALUES ('bt_1', 'run-1', 'c1', 'open', '"https://shop.example/"', 'about:blank', 'https://shop.example/', '${snapshot}', '${shot}',
        '[{"url":"https://evil.example/x","reason":"evil.example is not on the allowlist of this task"}]', '["cdn.example"]', 120, '2026-10-13T17:00:01Z');
    INSERT INTO browser_steps (taskId, runId, toolCallId, action, target, urlBefore, urlAfter, snapshotBlob, screenshotBlob, sent, durationMs, createdAt)
      VALUES ('bt_1', 'run-1', 'approval-7', 'submit', '"{\\"button\\":\\"Buy now\\"}"', 'https://shop.example/', 'https://shop.example/buy', '${snapshot}', '${shot}',
        '[{"method":"POST","url":"https://shop.example/buy"}]', 90, '2026-10-13T17:00:05Z');
  `);
  setSetting(t.db, 'web_search.engines', { google: { strikes: 2, until: '2026-10-13T18:00:00Z', reason: 'a CAPTCHA' } }, clock());
  mkdirSync(join(t.dataDir, 'browser', 'traces'), { recursive: true });
  writeFileSync(join(t.dataDir, 'browser', 'traces', 'bt_1.zip'), 'PK..');
  const dashboard = createDashboard({ db: t.db, config: t.config, clock, logger: silentLogger, app: t.app });
  return { t, dashboard, snapshot, shot };
}
