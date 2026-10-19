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
  const write = (secrets: Map<string, string>) => {
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
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      if (err instanceof CredentialStoreError) throw err;
      throw new CredentialStoreError(`the secret file ${file} cannot be written`);
    }
  };

  // the writes of this process run one after another. each one reads the map again, so two sets at the same time
  // both land.
  let chain: Promise<unknown> = Promise.resolve();
  const queue = (change: (secrets: Map<string, string>) => boolean): Promise<void> => {
    const next = chain.then(() => {
      const secrets = read() ?? new Map<string, string>();
      if (change(secrets)) write(secrets);
    });
    chain = next.catch(() => {});
    return next;
  };

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
