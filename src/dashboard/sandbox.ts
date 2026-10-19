import type { Hono } from 'hono';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { DashboardDeps } from './server.js';
import type { SandboxExecDetail, SandboxExecRow, SandboxQuery } from './types.js';

// phase 5 m9 owns this module. it mounts GET /api/sandbox and GET /api/sandbox/execs/:id. docs/PHASE5-API.md gives the
// shapes and the errors. server.ts calls it after the sign-in check, so each route is behind the dashboard auth.
export function mountSandbox(_server: Hono, _deps: DashboardDeps): void {}

// parseSandboxQuery reads the query of GET /api/sandbox. limit is clamped to 1-200 (default 50). an unknown status or a
// before that is not a positive whole number gives the reason for a 400.
export function parseSandboxQuery(_query: Record<string, string | undefined>): { ok: true; value: SandboxQuery } | { ok: false; error: string } {
  throw new Error('not built: parseSandboxQuery');
}

// listSandboxExecs gives one page, newest first. before is the id of the last row when the page is full and more rows
// exist, and null on the last page.
export function listSandboxExecs(_db: Db, _query: SandboxQuery): { execs: SandboxExecRow[]; before: number | null } {
  throw new Error('not built: listSandboxExecs');
}

// getSandboxExec gives undefined for an id that has no row. it throws when a blob of the row is damaged, and the route
// answers 500.
export function getSandboxExec(_db: Db, _blobs: BlobStore, _id: number): SandboxExecDetail | undefined {
  throw new Error('not built: getSandboxExec');
}
