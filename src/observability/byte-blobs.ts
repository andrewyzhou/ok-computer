import { readFileSync } from 'node:fs';
import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import { blobPath, sha256, writeAtomic } from './blobs.js';

// screenshots are bytes, not text, so the redaction cannot run on them. they share the files and the table of the text
// store, with their own mime type. a password field shows dots in a screenshot, and the model never sees a registered
// secret, so the agent cannot type one.
export interface ByteStore {
  put(bytes: Buffer, mime: string): string;
  read(hash: string): { bytes: Buffer; mime: string } | undefined;
}

const HASH = /^[0-9a-f]{64}$/;

export function createByteStore(db: Db, dir: string, clock: Clock): ByteStore {
  return {
    put(bytes, mime) {
      const hash = sha256(bytes);
      const path = blobPath(dir, hash);
      let current: Buffer | undefined;
      try {
        current = readFileSync(path);
      } catch {
        current = undefined;
      }
      if (!current || sha256(current) !== hash) writeAtomic(path, bytes, hash);
      db.prepare('INSERT INTO blobs (hash, size, mime, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT (hash) DO NOTHING').run(
        hash,
        bytes.length,
        mime,
        clock().toISOString(),
      );
      return hash;
    },
    read(hash) {
      if (!HASH.test(hash)) return undefined;
      const row = db.prepare('SELECT mime FROM blobs WHERE hash = ?').get(hash);
      if (!row) return undefined;
      let bytes: Buffer;
      try {
        bytes = readFileSync(blobPath(dir, hash));
      } catch {
        return undefined;
      }
      if (sha256(bytes) !== hash) throw new Error(`blob ${hash} is damaged: its bytes do not match its hash`);
      return { bytes, mime: String(row.mime) };
    },
  };
}
