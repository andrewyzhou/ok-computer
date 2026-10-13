import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDashboard } from '../src/dashboard/server.js';
import { createBlobStore } from '../src/observability/blobs.js';
import { createByteStore } from '../src/observability/byte-blobs.js';
import { silentLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';

export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082',
  'hex',
);

// a closed task with one step that blocked an off-list frame, and a crashed task whose damaged row names a file
// outside the trace folder.
export function seedBrowser() {
  const t = createTestApp([], { start: '2026-10-13T17:00:00Z' });
  const clock = () => new Date('2026-10-13T17:00:00Z');
  const blobs = createBlobStore(t.db, join(t.dataDir, 'blobs'), clock);
  const bytes = createByteStore(t.db, join(t.dataDir, 'blobs'), clock);
  const snapshot = blobs.put('- button "Buy now" [ref=e7]');
  const shot = bytes.put(PNG, 'image/png');
  t.db.exec(`
    INSERT INTO browser_tasks (id, kind, sessionKey, runId, allowlist, status, endReason, tracePath, traceBytes, startedAt, endedAt)
      VALUES ('bt_1', 'task', 'main', 'run-1', '["shop.example"]', 'closed', 'the agent closed it', 'traces/bt_1.zip', 4, '2026-10-13T17:00:00Z', '2026-10-13T17:01:00Z');
    INSERT INTO browser_tasks (id, kind, sessionKey, allowlist, status, endReason, tracePath, traceError, startedAt)
      VALUES ('bt_2', 'task', 'main', '[]', 'crashed', 'the browser stopped', '../../okc.sqlite', 'the browser stopped before the trace was saved', '2026-10-13T17:02:00Z');
    INSERT INTO browser_steps (taskId, runId, toolCallId, action, target, urlBefore, urlAfter, snapshotBlob, screenshotBlob, blockedRequests, durationMs, createdAt)
      VALUES ('bt_1', 'run-1', 'c1', 'open', '"https://shop.example/"', 'about:blank', 'https://shop.example/', '${snapshot}', '${shot}',
        '[{"url":"https://evil.example/x","reason":"evil.example is not on the allowlist of this task"}]', 120, '2026-10-13T17:00:01Z');
  `);
  mkdirSync(join(t.dataDir, 'browser', 'traces'), { recursive: true });
  writeFileSync(join(t.dataDir, 'browser', 'traces', 'bt_1.zip'), 'PK..');
  const dashboard = createDashboard({ db: t.db, config: t.config, clock, logger: silentLogger, app: t.app });
  return { t, dashboard, snapshot, shot };
}
