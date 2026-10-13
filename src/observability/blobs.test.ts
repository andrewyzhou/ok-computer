import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
  it('stores a text one time under its hash and counts the references', () => {
    const { db, dir, blobs } = setup();
    const hash = blobs.put('a large tool result');
    expect(hash).toBe(createHash('sha256').update('a large tool result').digest('hex'));
    expect(blobs.put('a large tool result')).toBe(hash);
    expect(blobPath(dir, hash)).toBe(join(dir, hash.slice(0, 2), hash.slice(2, 4), hash));
    expect(readFileSync(blobPath(dir, hash), 'utf8')).toBe('a large tool result');
    expect(db.prepare('SELECT size, mime, refCount, createdAt FROM blobs').all()).toEqual([
      { size: 19, mime: 'text/plain; charset=utf-8', refCount: 2, createdAt: '2026-10-13T03:00:00.000Z' },
    ]);
    expect(blobs.read(hash)).toBe('a large tool result');
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
});
