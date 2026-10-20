import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// the tests make many temporary folders: databases, blobs, chrome profiles and trace zips. one full run made about
// 1 gb of them, and the disk became full. each run therefore gets one parent folder, and the teardown removes it. the
// workers and their chrome processes start after this setup, so os.tmpdir() gives them the parent folder.
// a run that was killed never reaches its teardown, and its folder of up to 1 gb stays. a folder of an earlier run that
// is older than this is not in use any more, so the next run removes it.
const STALE_MS = 6 * 60 * 60_000;

function removeStale(base: string): void {
  for (const name of readdirSync(base)) {
    if (!name.startsWith('okc-test-')) continue;
    const path = join(base, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // a folder that another run removes at the same time, or a file that chrome still holds, stays for the next run.
    }
  }
}

export default function setup(): () => void {
  removeStale(tmpdir());
  const root = mkdtempSync(join(tmpdir(), 'okc-test-'));
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = root;
  return () => {
    // a chrome that a failed test did not stop can still hold a file for a short time. a folder that stays is not an
    // error of the tests.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.warn(`could not remove the temporary folder ${root}: ${String(err)}`);
    }
  };
}
