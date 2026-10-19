import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface InstanceLock {
  release(): Promise<void>;
}

// macos and other unix systems put the path of a socket file in a field of 104 bytes, with the end byte.
const SOCKET_PATH_LIMIT = 103;

// a data folder that does not exist yet gets the real path of the nearest folder above it that exists. so the name
// stays the same when the folder is made later, also below a link such as /tmp on macos, which is /private/tmp.
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

// the temp folder of the user on macos, such as /var/folders/xx/yyyy/T/, from the system and not from TMPDIR. launchd
// and a shell of the desktop set TMPDIR to this folder, but an ssh or sudo shell can leave it out, and a lock that
// follows TMPDIR would then not see the lock of the login agent. undefined when getconf does not give it.
let userTemp: string | null | undefined;
function darwinUserTemp(): string | undefined {
  if (userTemp === undefined) {
    try {
      const out = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      userTemp = out.startsWith('/') ? out : null;
    } catch {
      userTemp = null;
    }
  }
  return userTemp ?? undefined;
}

// on windows the lock is a named pipe, because windows removes a pipe when its process ends, also after a crash. a
// lock file can stay after a crash, and a pid in it can belong to a new process. the name comes from the data folder,
// so one database has one service, and a copy of the app with its own data folder has its own lock.
export function lockName(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  let path = realPath(resolve(dataDir));
  if (platform === 'win32') path = path.toLowerCase();
  const id = createHash('sha256').update(path).digest('hex').slice(0, 32);
  if (platform === 'win32') return `\\\\.\\pipe\\okc-${id}`;
  // linux removes a socket in the abstract namespace when its process ends, as windows removes a pipe.
  if (platform === 'linux') return `\0okc-${id}`;
  // macos has no abstract namespace, so the lock is a socket file. the file stays after a crash, and
  // holdInstanceLock removes it when no process answers on it. without the temp folder of the user, or when its path
  // does not fit, the file goes in /tmp with the user id in its name, so the path never depends on the environment.
  const temp = darwinUserTemp();
  const file = temp ? join(temp, `okc-${id}.sock`) : '';
  return file && Buffer.byteLength(file) <= SOCKET_PATH_LIMIT ? file : `/tmp/okc-${process.getuid?.() ?? userInfo().uid}-${id}.sock`;
}

const isFile = (name: string) => !name.startsWith('\0') && !name.startsWith('\\\\.\\pipe\\');

function listen(name: string): Promise<InstanceLock | 'in-use'> {
  return new Promise((done, fail) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? done('in-use') : fail(err)));
    server.listen(name, () => {
      // the lock does not keep the process alive.
      server.unref();
      // close also removes a socket file.
      done({ release: () => new Promise((closed) => server.close(() => closed())) });
    });
  });
}

// true when a process listens on the socket file. a refused connection means that the file stayed after a crash. a
// file that is not a socket is not removed, so the start stops with the error.
function answers(name: string): Promise<boolean> {
  return new Promise((done, fail) => {
    const socket = connect(name);
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') done(false);
      else fail(err);
    });
  });
}

// undefined when another process holds the lock.
export async function holdInstanceLock(dataDir: string): Promise<InstanceLock | undefined> {
  const name = lockName(dataDir);
  const first = await listen(name);
  if (first !== 'in-use') return first;
  if (!isFile(name) || (await answers(name))) return undefined;
  // the file is from a process that ended, so it is removed and the lock is tried one more time. two starts that find
  // the same old file at the same moment can both get past this step. launchd and okc.sh start one process at a time,
  // so this does not occur in normal use.
  rmSync(name, { force: true });
  const second = await listen(name);
  return second === 'in-use' ? undefined : second;
}
