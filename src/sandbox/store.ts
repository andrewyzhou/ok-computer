import type { Db } from '../db/index.js';
import type { ExecEnd, FileRow, NewExec } from './types.js';

// the trace rows of the sandbox: sandbox_execs and sandbox_files (020_sandbox.sql). the row of an exec is written
// before the container starts and finished after it ends, so a crash leaves a running row that closeStale ends.

export const STALE_ERROR = 'the app stopped while the command ran';

export function startExec(db: Db, exec: NewExec, now: Date): number {
  const row = db
    .prepare(
      `INSERT INTO sandbox_execs (runId, toolCallId, sessionKey, taskId, language, command, image, cwd, network, allowlist, limits,
         status, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?) RETURNING id`,
    )
    .get(
      exec.runId,
      exec.toolCallId,
      exec.sessionKey,
      exec.taskId,
      exec.language,
      exec.command,
      exec.image,
      exec.cwd,
      exec.network,
      JSON.stringify(exec.allowlist),
      JSON.stringify(exec.limits),
      now.toISOString(),
    );
  return Number(row!.id);
}

// the update changes only a running row. a stale sweep and a late finish can meet on one row, and the first one
// sticks, so the row never says two things.
export function finishExec(db: Db, id: number, end: ExecEnd, now: Date): void {
  db.prepare(
    `UPDATE sandbox_execs SET status = ?, exitCode = ?, imageId = ?, containerId = ?, stdoutBlob = ?, stderrBlob = ?, stdoutBytes = ?,
       stderrBytes = ?, truncated = ?, error = ?, durationMs = ?, endedAt = ?
     WHERE id = ? AND status = 'running'`,
  ).run(
    end.status,
    end.exitCode,
    end.imageId,
    end.containerId,
    end.stdoutBlob,
    end.stderrBlob,
    end.stdoutBytes,
    end.stderrBytes,
    end.truncated ? 1 : 0,
    end.error,
    Math.round(end.durationMs),
    now.toISOString(),
    id,
  );
}

export function addFiles(db: Db, execId: number, rows: FileRow[], now: Date): void {
  if (!rows.length) return;
  const insert = db.prepare('INSERT INTO sandbox_files (execId, direction, path, blob, size, mime, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const at = now.toISOString();
  db.exec('BEGIN');
  try {
    for (const row of rows) insert.run(execId, row.direction, row.path, row.blob, row.size, row.mime, at);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// closeStale gives status error and the reason "the app stopped while the command ran" to each running row that is
// older than staleMs and not in live. it gives the ids that it closed.
export function closeStale(db: Db, now: Date, staleMs: number, live: ReadonlySet<number>): number[] {
  const cutoff = new Date(now.getTime() - staleMs).toISOString();
  const found = db.prepare("SELECT id FROM sandbox_execs WHERE status = 'running' AND createdAt < ? ORDER BY id").all(cutoff);
  const close = db.prepare("UPDATE sandbox_execs SET status = 'error', error = ?, endedAt = ? WHERE id = ? AND status = 'running'");
  const closed: number[] = [];
  for (const row of found) {
    const id = Number(row.id);
    if (live.has(id)) continue;
    if (close.run(STALE_ERROR, now.toISOString(), id).changes === 1) closed.push(id);
  }
  return closed;
}
