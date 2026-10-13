import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { blobPath, createBlobStore } from './blobs.js';
import { registerSecret } from './redact.js';

function setup() {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'okc-blobs-'));
  const blobs = createBlobStore(db, dir, () => new Date('2026-10-13T03:00:00Z'));
  return { db, dir, blobs };
}

describe('blob store', () => {
  it('stores a text one time under its hash', () => {
    const { db, dir, blobs } = setup();
    const hash = blobs.put('a large tool result');
    expect(hash).toBe(createHash('sha256').update('a large tool result').digest('hex'));
    expect(blobs.put('a large tool result')).toBe(hash);
    expect(blobPath(dir, hash)).toBe(join(dir, hash.slice(0, 2), hash.slice(2, 4), hash));
    expect(readFileSync(blobPath(dir, hash), 'utf8')).toBe('a large tool result');
    expect(db.prepare('SELECT size, mime, createdAt FROM blobs').all()).toEqual([
      { size: 19, mime: 'text/plain; charset=utf-8', createdAt: '2026-10-13T03:00:00.000Z' },
    ]);
    expect(blobs.read(hash)).toBe('a large tool result');
    // the file gets its name in one rename, so no temporary file stays.
    expect(readdirSync(dir, { recursive: true }).map(String).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('redacts a secret before the hash, so the secret is never in a file', () => {
    const { dir, blobs } = setup();
    registerSecret('super-secret-value');
    const hash = blobs.put('token super-secret-value here', 'application/json');
    expect(blobs.read(hash)).toBe('token [redacted] here');
    expect(hash).toBe(createHash('sha256').update('token [redacted] here').digest('hex'));
    expect(existsSync(blobPath(dir, createHash('sha256').update('token super-secret-value here').digest('hex')))).toBe(false);
  });

  it('reads only a real hash', () => {
    const { blobs } = setup();
    expect(blobs.read('../../okc.sqlite')).toBeUndefined();
    expect(blobs.read('0'.repeat(64))).toBeUndefined();
  });

  it('fails the read of a torn or changed file instead of giving wrong text', () => {
    const { dir, blobs } = setup();
    const hash = blobs.put('the full and correct text');
    // a power loss can leave the row and only part of the file.
    writeFileSync(blobPath(dir, hash), 'the full and');
    expect(() => blobs.read(hash)).toThrow(/damaged/);
    // the next put of the same text writes the file again.
    blobs.put('the full and correct text');
    expect(blobs.read(hash)).toBe('the full and correct text');
  });

  it('takes the same texts from several processes at the same time without an error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'okc-blob-race-'));
    const dbPath = join(root, 'okc.sqlite');
    const dir = join(root, 'blobs');
    openDb(dbPath).close();
    const child = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'blob-put-child.ts');
    const texts = 150;
    const outputs = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<string>((resolve, reject) => {
            const proc = spawn(process.execPath, ['--import', 'tsx', child, dbPath, dir, String(texts)], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
            proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
            proc.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`child failed: ${err}`))));
          }),
      ),
    );
    expect(outputs.map((line) => JSON.parse(line.split('\n').at(-1)!))).toEqual(Array(4).fill({ errors: [] }));
    const db = openDb(dbPath);
    const blobs = createBlobStore(db, dir, () => new Date());
    const hashes = db.prepare('SELECT hash FROM blobs').all().map((row) => String(row.hash));
    expect(hashes).toHaveLength(texts);
    for (const hash of hashes) expect(blobs.read(hash)).toBeDefined();
    db.close();
  }, 30_000);
});
