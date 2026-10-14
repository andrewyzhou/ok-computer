import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// the tests make many temporary folders: databases, blobs, chrome profiles and trace zips. one full run made about
// 1 gb of them, and the disk became full. each run therefore gets one parent folder, and the teardown removes it. the
// workers and their chrome processes start after this setup, so os.tmpdir() gives them the parent folder.
export default function setup(): () => void {
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
