import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import { redact } from './redact.js';

export interface BlobStore {
  // put gives the hash of the stored text. the same text always gets the same hash and one file.
  put(text: string, mime?: string): string;
  read(hash: string): string | undefined;
}

const HASH = /^[0-9a-f]{64}$/;

export const blobPath = (dir: string, hash: string) => join(dir, hash.slice(0, 2), hash.slice(2, 4), hash);

// the store redacts the text before it computes the hash, so a secret never gets into a blob file.
export function createBlobStore(db: Db, dir: string, clock: Clock): BlobStore {
  return {
    put(text, mime = 'text/plain; charset=utf-8') {
      const clean = redact(text);
      const hash = createHash('sha256').update(clean).digest('hex');
      const counted = db.prepare('UPDATE blobs SET refCount = refCount + 1 WHERE hash = ?').run(hash).changes;
      if (counted) return hash;
      const path = blobPath(dir, hash);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, clean);
      db.prepare('INSERT INTO blobs (hash, size, mime, createdAt, refCount) VALUES (?, ?, ?, ?, 1)').run(
        hash,
        Buffer.byteLength(clean),
        mime,
        clock().toISOString(),
      );
      return hash;
    },
    // the hash check also stops a path outside the store, because the dashboard gives the hash from a url.
    read(hash) {
      if (!HASH.test(hash)) return undefined;
      const path = blobPath(dir, hash);
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    },
  };
}
