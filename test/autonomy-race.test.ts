import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { levelOf } from '../src/policy/autonomy-store.js';

// the dashboard and the agent can be in different processes on one database file, for example the cli chat and the
// app. several processes change the same levels here at the same time. the history must stay one chain for each
// domain, the level must point at the newest row, and no agent row may raise a level.

const CHILD = fileURLToPath(new URL('./fixtures/autonomy-race-child.ts', import.meta.url));
const ROUNDS = 150;

function child(path: string, seed: number): Promise<{ written: number; same: number; refused: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), CHILD, path, String(seed), String(ROUNDS)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${seed} ended with ${code}: ${err}`))));
  });
}

const RANK = { ask: 0, review: 1, auto: 2 } as const;

describe('the trust ladder with several processes on one database', () => {
  it('keeps one chain of history for each domain, and never an agent raise', { timeout: 120_000 }, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'okc-autonomy-race-')), 'okc.sqlite');
    // the first open runs the migrations, so the processes do not race on them.
    openDb(path).close();
    const results = await Promise.all([11, 22, 33, 44].map((seed) => child(path, seed)));
    for (const result of results) expect(result.written + result.same + result.refused).toBe(ROUNDS);

    const db = openDb(path);
    try {
      const written = results.reduce((sum, each) => sum + each.written, 0);
      expect(Number(db.prepare('SELECT COUNT(*) AS n FROM autonomy_changes').get()!.n)).toBe(written);
      for (const domain of ['mail_drafts', 'calendar_holds'] as const) {
        const rows = db.prepare('SELECT id, fromLevel, toLevel, actor, via FROM autonomy_changes WHERE domain = ? ORDER BY id').all(domain);
        let level = 'review';
        for (const row of rows) {
          expect(row.fromLevel, `${domain} row ${row.id}`).toBe(level);
          expect(row.toLevel, `${domain} row ${row.id}`).not.toBe(row.fromLevel);
          if (row.actor === 'agent') {
            expect(row.via).toBe('chat');
            expect(RANK[row.toLevel as keyof typeof RANK]).toBeLessThan(RANK[row.fromLevel as keyof typeof RANK]);
          }
          level = String(row.toLevel);
        }
        expect(levelOf(db, domain)).toBe(level);
        const pointer = db.prepare('SELECT changeId FROM autonomy_levels WHERE domain = ?').get(domain);
        if (rows.length) expect(Number(pointer!.changeId)).toBe(Number(rows[rows.length - 1]!.id));
      }
    } finally {
      db.close();
    }
  });
});
