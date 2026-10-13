import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import { redact } from './redact.js';

export interface BlobStore {
  // put gives the hash of the stored text. the same text always gets the same hash and one file.
  put(text: string, mime?: string): string;
  // read gives undefined when the file is missing. it throws when the bytes of the file do not match the hash.
  read(hash: string): string | undefined;
}

const HASH = /^[0-9a-f]{64}$/;

export const blobPath = (dir: string, hash: string) => join(dir, hash.slice(0, 2), hash.slice(2, 4), hash);

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

// the file gets all its bytes before it gets its final name. a crash leaves a complete file or a temporary file,
// never a short file under the hash.
function writeAtomic(path: string, text: string, hash: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, text, { flag: 'wx' });
  try {
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    // on windows a rename fails while another process reads the target. that process wrote the same bytes.
    const bytes = readBytes(path);
    if (!bytes || sha256(bytes) !== hash) throw err;
  }
}

// the store redacts the text before it computes the hash, so a secret never gets into a blob file.
export function createBlobStore(db: Db, dir: string, clock: Clock): BlobStore {
  return {
    put(text, mime = 'text/plain; charset=utf-8') {
      const clean = redact(text);
      const hash = sha256(clean);
      const path = blobPath(dir, hash);
      // a missing or damaged file is written again, so a later put of the same text repairs the store.
      const bytes = readBytes(path);
      if (!bytes || sha256(bytes) !== hash) writeAtomic(path, clean, hash);
      // one statement, so two processes that put the same text at the same time do not collide.
      db.prepare('INSERT INTO blobs (hash, size, mime, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT (hash) DO NOTHING').run(
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
      const bytes = readBytes(blobPath(dir, hash));
      if (!bytes) return undefined;
      // a power loss can leave a short file. wrong text is worse than an error, so the read fails.
      if (sha256(bytes) !== hash) throw new Error(`blob ${hash} is damaged: its bytes do not match its hash`);
      return bytes.toString('utf8');
    },
  };
}
