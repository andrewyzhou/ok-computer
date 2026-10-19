import type { CheckedSecretStore } from './index.js';

// a json file that maps each ref to its value, for a server without a keyring. the file has mode 0600, and each
// write replaces the whole file through a temporary file and a rename, so a crash never leaves half a file.
// TODO(m7 secrets): build it. the work package gives the rules for the mode, a missing file and a damaged file.
export function createFileSecretStore(_path: string): CheckedSecretStore {
  throw new Error('not built: the file secret store');
}
