import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { CredentialStoreError } from '../integrations/secrets.js';
import { registerSecret } from '../observability/redact.js';
import type { CheckedSecretStore } from './index.js';

interface SecretFile {
  version: 1;
  secrets: Record<string, string>;
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

function isSecretFile(value: unknown): value is SecretFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const file = value as { version?: unknown; secrets?: unknown };
  if (file.version !== 1) return false;
  const secrets = file.secrets;
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) return false;
  return Object.values(secrets).every((entry) => typeof entry === 'string');
}

// windows has no unix mode bits, and a new file takes the access list of its folder. a folder outside the user
// profile, such as C:\okc\data, lets other local users read it. so the file drops the inherited entries and only its
// owner keeps access. icacls ships with windows.
function ownerOnlyAcl(file: string) {
  const name = userInfo().username;
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true });
}

// windows refuses a rename onto a file that another program holds for a moment, for example a virus scanner or the
// search indexer, with EPERM, EBUSY or EACCES. the rename then tries again a few times with a short wait, and gives up
// after about a second, so a write never waits for ever.
const RENAME_WAITS_MS = [10, 20, 40, 80, 160, 320, 400];
const isBusy = (err: unknown) => ['EPERM', 'EBUSY', 'EACCES'].includes((err as NodeJS.ErrnoException | null)?.code ?? '');

export async function replace(from: string, to: string, windows: boolean, rename: (from: string, to: string) => void = renameSync): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const wait = RENAME_WAITS_MS[attempt];
      if (!windows || wait === undefined || !isBusy(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

// the stores of one process that share a file take turns, also when a rename above waits. without this, a second store
// could read the file while the first one waits, and its write would drop the value of the first.
const turns = new Map<string, Promise<unknown>>();
function inTurn(file: string, work: () => Promise<void>): Promise<void> {
  const next = (turns.get(file) ?? Promise.resolve()).then(work);
  const tail = next.catch(() => {});
  turns.set(file, tail);
  void tail.then(() => turns.get(file) === tail && turns.delete(file));
  return next;
}

export interface FileSecretStoreDeps {
  // the tests try the windows path on other systems.
  platform?: NodeJS.Platform;
  // this limits a file to its owner on windows. the tests give a fake one.
  protect?: (file: string) => void;
}

// a json file that maps each ref to its value, for a server without a keyring. the file has mode 0600, or an access
// list for its owner only on windows, and each write replaces the whole file through a temporary file and a rename,
// so a crash never leaves half a file.
export function createFileSecretStore(path: string, deps: FileSecretStoreDeps = {}): CheckedSecretStore {
  const file = resolve(process.cwd(), path);
  const windows = (deps.platform ?? process.platform) === 'win32';
  const protect = (target: string) => {
    try {
      (deps.protect ?? ownerOnlyAcl)(target);
    } catch {
      throw new CredentialStoreError(`the secret file ${target} cannot be limited to its owner. Check that icacls runs.`);
    }
  };
  // a file that was made by hand or by an older version keeps the access list of its folder, so the first read on
  // windows limits it too.
  let checkedAcl = false;

  // the file is read on each call, so a value that another process wrote is seen at once. a missing file holds no
  // secrets. the error texts name the path only, never a ref or a part of the contents.
  const read = (): Map<string, string> | undefined => {
    let mode: number;
    try {
      mode = statSync(file).mode;
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw new CredentialStoreError(`the secret file ${file} cannot be read`);
    }
    // windows has no unix mode bits, so the mode check runs only on other systems, and windows sets the access list.
    if (windows) {
      if (!checkedAcl) {
        protect(file);
        checkedAcl = true;
      }
    } else if ((mode & 0o077) !== 0) {
      throw new CredentialStoreError(`the secret file ${file} can be read by other users. Run chmod 600 ${file}.`);
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      // the file can go away between the stat and the read, when another process replaces it.
      if (isMissing(err)) return undefined;
      throw new CredentialStoreError(`the secret file ${file} cannot be read`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CredentialStoreError(`the secret file ${file} is damaged`);
    }
    if (!isSecretFile(parsed)) throw new CredentialStoreError(`the secret file ${file} is damaged`);
    return new Map(Object.entries(parsed.secrets));
  };

  // the new contents go to a temporary file with mode 0600 first. the rename then replaces the old file in one
  // step, so a reader sees the old map or the new map, never a mix.
  const write = async (secrets: Map<string, string>) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const body: SecretFile = { version: 1, secrets: Object.fromEntries(secrets) };
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        // the access list is set while the file is still empty, so no value is ever open to other users. the rename
        // keeps it.
        if (windows) protect(tmp);
        writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      await replace(tmp, file, windows);
    } catch (err) {
      rmSync(tmp, { force: true });
      if (err instanceof CredentialStoreError) throw err;
      throw new CredentialStoreError(`the secret file ${file} cannot be written`);
    }
  };

  // the writes of this process run one after another. each batch reads the map again, so two sets at the same time
  // both land. the changes that wait for a write go into the next write together: on windows each write starts
  // icacls, and one write for each of 100 sets took more than 5 s.
  let pending: Array<{ change: (secrets: Map<string, string>) => boolean; done: () => void; fail: (err: unknown) => void }> = [];
  let draining = false;
  const drain = async () => {
    draining = true;
    try {
      while (pending.length) {
        const batch = pending;
        pending = [];
        try {
          await inTurn(windows ? file.toLowerCase() : file, async () => {
            const secrets = read() ?? new Map<string, string>();
            let changed = false;
            for (const each of batch) changed = each.change(secrets) || changed;
            if (changed) await write(secrets);
          });
          for (const each of batch) each.done();
        } catch (err) {
          for (const each of batch) each.fail(err);
        }
      }
    } finally {
      draining = false;
    }
  };
  const queue = (change: (secrets: Map<string, string>) => boolean): Promise<void> =>
    new Promise((done, fail) => {
      pending.push({ change, done, fail });
      // the drain starts once the code that runs now is done, so the sets and deletes that it makes share a write.
      if (!draining) {
        draining = true;
        queueMicrotask(() => void drain());
      }
    });

  return {
    async get(ref) {
      const value = read()?.get(ref);
      registerSecret(value, ref);
      return value;
    },
    async set(ref, value) {
      registerSecret(value, ref);
      await queue((secrets) => {
        secrets.set(ref, value);
        return true;
      });
    },
    async delete(ref) {
      await queue((secrets) => secrets.delete(ref));
    },
    async check() {
      if (existsSync(file)) {
        read();
        return;
      }
      // the first set creates the file, so the nearest folder that exists must take a new file.
      let folder = dirname(file);
      while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
      try {
        accessSync(folder, constants.W_OK);
      } catch {
        throw new CredentialStoreError(`the folder of the secret file ${file} cannot be written`);
      }
    },
  };
}
