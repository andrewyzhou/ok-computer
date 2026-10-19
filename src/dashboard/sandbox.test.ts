import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/load.js';
import { openDb, type Db } from '../db/index.js';
import { blobPath, createBlobStore, sha256 } from '../observability/blobs.js';
import { createByteStore } from '../observability/byte-blobs.js';
import { silentLogger } from '../observability/logger.js';
import { registerSecret } from '../observability/redact.js';
import { DEFAULT_LIMITS, DETAIL_TEXT_BYTES, SANDBOX_IMAGE } from '../sandbox/limits.js';
import { startExec } from '../sandbox/store.js';
import { parseSandboxQuery } from './sandbox.js';
import { createDashboard, type DashboardDeps } from './server.js';
import type { SandboxExecDetail, SandboxPage, SandboxStatus } from './types.js';

const NOW = '2026-10-18T12:00:00.000Z';
const SECRET = 'sk-sandbox-secret-0123456789';

const ON: SandboxStatus = {
  available: true,
  reason: null,
  engine: 'engine 27.0',
  image: SANDBOX_IMAGE,
  defaults: DEFAULT_LIMITS,
  network: true,
  networkReason: null,
};

function setup(options: { sandbox?: { status(): Promise<SandboxStatus> } | undefined; token?: string } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'okc-sandbox-dash-'));
  const dataDir = join(workspace, 'data');
  const parsed = parseConfig({ paths: { workspace, data: dataDir } });
  if (!parsed.ok) throw new Error(parsed.error);
  const db = openDb(':memory:');
  const clock = () => new Date(NOW);
  const blobs = createBlobStore(db, join(dataDir, 'blobs'), clock);
  const app = ('sandbox' in options ? { sandbox: options.sandbox } : { sandbox: { status: async () => ON } }) as unknown as DashboardDeps['app'];
  const dashboard = createDashboard({
    db,
    config: parsed.value,
    clock,
    logger: silentLogger,
    app,
    webDir: join(dataDir, 'no-web'),
    ...(options.token ? { token: options.token } : {}),
  });
  return { db, dataDir, blobs, dashboard };
}

interface ExecFields {
  runId?: string | null;
  toolCallId?: string | null;
  status?: string;
  stdoutBlob?: string | null;
  stderrBlob?: string | null;
  truncated?: number;
}

function insertExec(db: Db, fields: ExecFields = {}): number {
  const result = db
    .prepare(
      `INSERT INTO sandbox_execs (runId, toolCallId, sessionKey, taskId, language, command, image, imageId, cwd, network, allowlist,
         limits, status, exitCode, containerId, stdoutBlob, stderrBlob, stdoutBytes, stderrBytes, truncated, error, durationMs,
         createdAt, endedAt)
       VALUES (?, ?, 'main', 'task-1', 'python', 'print(1)', ?, 'sha256:abc', '/work', 'allowlist', '["pypi.org"]', ?, ?, 0, 'c-1',
         ?, ?, 2, 0, ?, NULL, 120, ?, ?)`,
    )
    .run(
      fields.runId === undefined ? 'run-1' : fields.runId,
      fields.toolCallId === undefined ? null : fields.toolCallId,
      SANDBOX_IMAGE,
      JSON.stringify(DEFAULT_LIMITS),
      fields.status ?? 'ok',
      fields.stdoutBlob ?? null,
      fields.stderrBlob ?? null,
      fields.truncated ?? 0,
      NOW,
      NOW,
    );
  return Number(result.lastInsertRowid);
}

function insertFile(db: Db, execId: number, path: string, direction: 'in' | 'out') {
  db.prepare("INSERT INTO sandbox_files (execId, direction, path, blob, size, mime, createdAt) VALUES (?, ?, ?, ?, 5, 'text/plain', ?)").run(
    execId,
    direction,
    path,
    sha256(path),
    NOW,
  );
}

// a run, a reviewer model call, an approval and a decision of the call that asked. the decision row has the run and the
// call id, so it is found also before the tool call row exists.
function insertPolicy(db: Db, toolCallId: string) {
  db.prepare("INSERT OR IGNORE INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('run-1', 'main', 'message', 'main', 'running', ?)").run(NOW);
  const modelCall = db
    .prepare("INSERT INTO model_calls (runId, slot, provider, model, latencyMs, request, createdAt) VALUES ('run-1', 'reviewer', 'fake', 'm', 10, '{}', ?)")
    .run(NOW);
  const approval = db
    .prepare("INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt) VALUES ('run-1', 'sandbox_exec', '{}', 'run code', 'approved', ?)")
    .run(NOW);
  const decision = db
    .prepare(
      `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, reviewerModelCallId, reviewerVerdict, reviewerReason,
         approvalId, createdAt) VALUES ('run-1', ?, 'sandbox_exec', 'approve', 'risk:external', ?, ?, 'allow', ?, ?, ?)`,
    )
    .run(toolCallId, `network call with ${SECRET}`, Number(modelCall.lastInsertRowid), `fine, the key ${SECRET} stays inside`, Number(approval.lastInsertRowid), NOW);
  return { decisionId: Number(decision.lastInsertRowid), approvalId: Number(approval.lastInsertRowid), modelCallId: Number(modelCall.lastInsertRowid) };
}

async function getJson<T>(dashboard: { request: (path: string) => Response | Promise<Response> }, path: string, status = 200): Promise<T> {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(status);
  return (await response.json()) as T;
}

describe('parseSandboxQuery', () => {
  it('gives the 400 texts and clamps the limit', () => {
    expect(parseSandboxQuery({ status: 'done' })).toEqual({ ok: false, error: 'status must be one of running, ok, failed, timeout, killed, error' });
    for (const before of ['0', '-3', '1.5', 'abc', '1e3']) expect(parseSandboxQuery({ before })).toEqual({ ok: false, error: 'before must be an exec id' });
    expect(parseSandboxQuery({ runId: 'r'.repeat(201) }).ok).toBe(false);
    expect(parseSandboxQuery({ runId: 'r'.repeat(200) })).toEqual({ ok: true, value: { runId: 'r'.repeat(200), limit: 50 } });
    expect(parseSandboxQuery({})).toEqual({ ok: true, value: { limit: 50 } });
    expect(parseSandboxQuery({ limit: '0' })).toEqual({ ok: true, value: { limit: 1 } });
    expect(parseSandboxQuery({ limit: '500' })).toEqual({ ok: true, value: { limit: 200 } });
    expect(parseSandboxQuery({ limit: 'many' })).toEqual({ ok: true, value: { limit: 50 } });
    expect(parseSandboxQuery({ status: 'timeout', before: '12', limit: '7' })).toEqual({ ok: true, value: { status: 'timeout', before: 12, limit: 7 } });
  });
});

describe('GET /api/sandbox', () => {
  it('pages with before, newest first, and gives null on the last page', async () => {
    const { db, dashboard } = setup();
    const ids = Array.from({ length: 5 }, () => insertExec(db));
    insertFile(db, ids[4]!, 'in.csv', 'in');
    insertFile(db, ids[4]!, 'out.png', 'out');
    const first = await getJson<SandboxPage>(dashboard, '/api/sandbox?limit=2');
    expect(first.status).toEqual(ON);
    expect(first.execs.map((exec) => exec.id)).toEqual([ids[4], ids[3]]);
    expect(first.before).toBe(ids[3]);
    expect(first.execs[0]).toMatchObject({ fileCount: 2, allowlist: ['pypi.org'], limits: DEFAULT_LIMITS, truncated: false, language: 'python' });
    expect(first.execs[1]?.fileCount).toBe(0);
    const second = await getJson<SandboxPage>(dashboard, `/api/sandbox?limit=2&before=${first.before}`);
    expect(second.execs.map((exec) => exec.id)).toEqual([ids[2], ids[1]]);
    const last = await getJson<SandboxPage>(dashboard, `/api/sandbox?limit=2&before=${second.before}`);
    expect(last.execs.map((exec) => exec.id)).toEqual([ids[0]]);
    expect(last.before).toBeNull();
    // a full page with no older row is the last page too.
    expect((await getJson<SandboxPage>(dashboard, '/api/sandbox?limit=5')).before).toBeNull();
  });

  it('filters by run and by status', async () => {
    const { db, dashboard } = setup();
    const a = insertExec(db, { runId: 'run-a', status: 'ok', truncated: 1 });
    const b = insertExec(db, { runId: 'run-b', status: 'timeout' });
    const c = insertExec(db, { runId: 'run-a', status: 'timeout' });
    expect((await getJson<SandboxPage>(dashboard, '/api/sandbox?runId=run-a')).execs.map((exec) => exec.id)).toEqual([c, a]);
    expect((await getJson<SandboxPage>(dashboard, '/api/sandbox?status=timeout')).execs.map((exec) => exec.id)).toEqual([c, b]);
    expect((await getJson<SandboxPage>(dashboard, '/api/sandbox?runId=run-a&status=ok')).execs).toMatchObject([{ id: a, truncated: true }]);
    expect((await getJson<SandboxPage>(dashboard, '/api/sandbox?runId=run-c')).execs).toEqual([]);
  });

  it('answers 400 with the reason for a bad query', async () => {
    const { dashboard } = setup();
    expect(await getJson(dashboard, '/api/sandbox?status=done', 400)).toEqual({ error: 'status must be one of running, ok, failed, timeout, killed, error' });
    expect(await getJson(dashboard, '/api/sandbox?before=x', 400)).toEqual({ error: 'before must be an exec id' });
    expect(await getJson(dashboard, `/api/sandbox?runId=${'r'.repeat(201)}`, 400)).toHaveProperty('error');
  });

  it('gives the off status with 200 when the process has no sandbox', async () => {
    const { db, dashboard } = setup({ sandbox: undefined });
    insertExec(db);
    const page = await getJson<SandboxPage>(dashboard, '/api/sandbox');
    const reason = 'the code sandbox is not set up in this process';
    expect(page.status).toEqual({ available: false, reason, engine: null, image: SANDBOX_IMAGE, defaults: DEFAULT_LIMITS, network: false, networkReason: reason });
    expect(page.execs.length).toBe(1);
  });

  it('gives the off status with the error text when the status check throws', async () => {
    const { dashboard } = setup({
      sandbox: {
        status: async () => {
          throw new Error('the docker socket refused the connection');
        },
      },
    });
    const page = await getJson<SandboxPage>(dashboard, '/api/sandbox');
    expect(page.status).toMatchObject({ available: false, reason: 'the docker socket refused the connection', engine: null, network: false });
    expect(page.status.networkReason).toBe('the docker socket refused the connection');
  });

  it('is behind the dashboard auth', async () => {
    const { db, dashboard } = setup({ token: 'sandbox-token-1234' });
    const id = insertExec(db);
    expect((await dashboard.request('/api/sandbox')).status).toBe(401);
    expect((await dashboard.request(`/api/sandbox/execs/${id}`)).status).toBe(401);
    expect((await dashboard.request('/api/sandbox?token=sandbox-token-1234')).status).toBe(200);
    expect((await dashboard.request(`/api/sandbox/execs/${id}`, { headers: { authorization: 'Bearer sandbox-token-1234' } })).status).toBe(200);
  });
});

describe('GET /api/sandbox/execs/:id', () => {
  it('cuts stdout at 64 kb without a split character, and lists the files in order', async () => {
    const { db, blobs, dashboard } = setup();
    // two ascii bytes first, so a three-byte character crosses the limit at 64 kb.
    const long = `ab${'€'.repeat(DETAIL_TEXT_BYTES)}`;
    const stdoutBlob = blobs.put(long);
    const stderrBlob = blobs.put('a warning');
    const id = insertExec(db, { stdoutBlob, stderrBlob });
    insertFile(db, id, 'in.csv', 'in');
    insertFile(db, id, 'out/plot.png', 'out');
    const detail = await getJson<SandboxExecDetail>(dashboard, `/api/sandbox/execs/${id}`);
    const bytes = Buffer.byteLength(detail.stdout ?? '');
    expect(bytes).toBe(DETAIL_TEXT_BYTES - 2);
    expect(detail.stdout?.startsWith('ab€€')).toBe(true);
    expect(detail.stdout?.endsWith('€')).toBe(true);
    expect(detail.stdout).not.toContain('�');
    expect(detail.stderr).toBe('a warning');
    expect(detail).toMatchObject({ stdoutBlob, stderrBlob, cwd: '/work', imageId: 'sha256:abc', containerId: 'c-1', endedAt: NOW, error: null, fileCount: 2 });
    expect(detail.files).toEqual([
      { path: 'in.csv', direction: 'in', blob: sha256('in.csv'), size: 5, mime: 'text/plain' },
      { path: 'out/plot.png', direction: 'out', blob: sha256('out/plot.png'), size: 5, mime: 'text/plain' },
    ]);
    expect(detail.policy).toBeNull();
  });

  it('gives null for a missing blob and 500 for a damaged blob', async () => {
    const { db, dataDir, dashboard } = setup();
    const missing = insertExec(db, { stdoutBlob: sha256('gone') });
    const detail = await getJson<SandboxExecDetail>(dashboard, `/api/sandbox/execs/${missing}`);
    expect(detail.stdout).toBeNull();
    expect(detail.stdoutBlob).toBe(sha256('gone'));

    const hash = sha256('the real text');
    const path = blobPath(join(dataDir, 'blobs'), hash);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'other text');
    const damaged = insertExec(db, { stderrBlob: hash });
    const body = await getJson<{ error: string }>(dashboard, `/api/sandbox/execs/${damaged}`, 500);
    expect(body.error).toContain('damaged');
  });

  it('shows the policy decision through the tool call row, with the reasons redacted', async () => {
    registerSecret(SECRET);
    const { db, dashboard } = setup();
    const policy = insertPolicy(db, 'call-1');
    db.prepare(
      `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, policyDecisionId, riskLevel)
       VALUES ('run-1', 'approval-${policy.approvalId}', 'sandbox_exec', '{}', 'ok', 0, 100, ?, ?, 'external')`,
    ).run(NOW, policy.decisionId);
    const id = insertExec(db, { toolCallId: `approval-${policy.approvalId}` });
    const detail = await getJson<SandboxExecDetail>(dashboard, `/api/sandbox/execs/${id}`);
    expect(detail.policy).toEqual({
      decisionId: policy.decisionId,
      decision: 'approve',
      rule: 'risk:external',
      reason: expect.any(String),
      reviewerVerdict: 'allow',
      reviewerReason: expect.any(String),
      reviewerModelCallId: policy.modelCallId,
      approvalId: policy.approvalId,
      approvalStatus: 'approved',
    });
    expect(detail.policy?.reason).not.toContain(SECRET);
    expect(detail.policy?.reviewerReason).not.toContain(SECRET);
    expect(detail.policy?.reason).toContain('network call with');
  });

  it('finds the decision by run and call id while the call still runs', async () => {
    const { db, dashboard } = setup();
    const policy = insertPolicy(db, 'call-2');
    const running = insertExec(db, { toolCallId: 'call-2', status: 'running' });
    expect((await getJson<SandboxExecDetail>(dashboard, `/api/sandbox/execs/${running}`)).policy).toMatchObject({
      decisionId: policy.decisionId,
      reviewerVerdict: 'allow',
      approvalStatus: 'approved',
    });
    // the approved call runs as approval-<id>, and its decision is the one of the call that asked.
    const approved = insertExec(db, { toolCallId: `approval-${policy.approvalId}`, status: 'running' });
    expect((await getJson<SandboxExecDetail>(dashboard, `/api/sandbox/execs/${approved}`)).policy?.decisionId).toBe(policy.decisionId);
    const unknown = insertExec(db, { toolCallId: 'call-none' });
    expect((await getJson<SandboxExecDetail>(dashboard, `/api/sandbox/execs/${unknown}`)).policy).toBeNull();
  });

  it('answers 404 for an unknown id and for an id that is not a number', async () => {
    const { dashboard } = setup();
    expect(await getJson(dashboard, '/api/sandbox/execs/999', 404)).toEqual({ error: 'sandbox exec not found' });
    expect(await getJson(dashboard, '/api/sandbox/execs/abc', 404)).toEqual({ error: 'sandbox exec not found' });
    expect(await getJson(dashboard, '/api/sandbox/execs/0', 404)).toEqual({ error: 'sandbox exec not found' });
  });
});

describe('GET /api/sandbox/files/:hash', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);
  const fileRow = (db: Db, execId: number, path: string, blob: string, mime: string, size: number) =>
    db.prepare("INSERT INTO sandbox_files (execId, direction, path, blob, size, mime, createdAt) VALUES (?, 'out', ?, ?, ?, ?, ?)").run(execId, path, blob, size, mime, NOW);

  it('serves the exact bytes of a collected file, with its type, and a download for a type that is not an image', async () => {
    const { db, dataDir, blobs, dashboard } = setup();
    const bytes = createByteStore(db, join(dataDir, 'blobs'), () => new Date(NOW));
    const id = insertExec(db);
    const png = bytes.put(PNG, 'image/png');
    const zip = bytes.put(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]), 'application/zip');
    const svg = blobs.put('<svg onload="x()"/>', 'image/svg+xml; charset=utf-8');
    fileRow(db, id, 'out/chart.png', png, 'image/png', PNG.length);
    fileRow(db, id, 'out/data.zip', zip, 'application/zip', 5);
    fileRow(db, id, 'out/pic.svg', svg, 'image/svg+xml; charset=utf-8', 19);

    const image = await dashboard.request(`/api/sandbox/files/${png}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('content-disposition')).toBeNull();
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);

    const archive = await dashboard.request(`/api/sandbox/files/${zip}`);
    expect(archive.headers.get('content-disposition')).toBe('attachment; filename="data.zip"');
    expect(Buffer.from(await archive.arrayBuffer())).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]));

    // an svg can hold script, so it downloads and never shows as a page of the dashboard.
    const drawing = await dashboard.request(`/api/sandbox/files/${svg}`);
    expect(drawing.headers.get('content-disposition')).toBe('attachment; filename="pic.svg"');
    expect(await drawing.text()).toBe('<svg onload="x()"/>');
  });

  it('gives 404 for a blob that no sandbox file names, and for a bad hash', async () => {
    const { db, dataDir, dashboard } = setup();
    const other = createByteStore(db, join(dataDir, 'blobs'), () => new Date(NOW)).put(PNG, 'image/png');
    expect(await getJson(dashboard, `/api/sandbox/files/${other}`, 404)).toEqual({ error: 'sandbox file not found' });
    expect(await getJson(dashboard, '/api/sandbox/files/nothex', 404)).toEqual({ error: 'sandbox file not found' });
  });

  it('shows the code of an exec without a key that the model pasted into it', async () => {
    const { db, dashboard } = setup();
    registerSecret(SECRET);
    const id = startExec(
      db,
      {
        runId: 'run-9',
        toolCallId: 'c9',
        sessionKey: 'main',
        taskId: 't',
        language: 'bash',
        command: `curl -H "x-key: ${SECRET}" https://pypi.org`,
        image: SANDBOX_IMAGE,
        cwd: '/work',
        network: 'none',
        allowlist: [],
        limits: DEFAULT_LIMITS,
      },
      new Date(NOW),
    );
    const detail = (await getJson(dashboard, `/api/sandbox/execs/${id}`)) as SandboxExecDetail;
    expect(detail.command).not.toContain(SECRET);
    expect(detail.command).toContain('[redacted]');
    const page = (await getJson(dashboard, '/api/sandbox')) as SandboxPage;
    expect(JSON.stringify(page)).not.toContain(SECRET);
  });
});
