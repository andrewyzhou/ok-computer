import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

export interface InstanceLock {
  release(): Promise<void>;
}

// the lock is a named pipe, because windows removes a pipe when its process ends, also after a crash. a lock file can
// stay after a crash, and a pid in it can belong to a new process. the name comes from the data folder, so one
// database has one service, and a copy of the app with its own data folder has its own lock.
export function lockName(dataDir: string): string {
  let path = resolve(dataDir);
  try {
    path = realpathSync.native(path);
  } catch {
    // a data folder that does not exist yet has no other name.
  }
  if (process.platform === 'win32') path = path.toLowerCase();
  const id = createHash('sha256').update(path).digest('hex').slice(0, 32);
  // linux removes a socket in the abstract namespace when its process ends, as windows removes a pipe.
  return process.platform === 'win32' ? `\\\\.\\pipe\\okc-${id}` : `\0okc-${id}`;
}

// undefined when another process holds the lock.
export function holdInstanceLock(dataDir: string): Promise<InstanceLock | undefined> {
  return new Promise((done, fail) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? done(undefined) : fail(err)));
    server.listen(lockName(dataDir), () => {
      // the lock does not keep the process alive.
      server.unref();
      done({ release: () => new Promise((closed) => server.close(() => closed())) });
    });
  });
}
