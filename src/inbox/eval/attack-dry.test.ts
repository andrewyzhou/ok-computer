import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../config/schema.js';
import { liveDatabaseReason } from './dry.js';

// tests that try to get the quality check onto the live database through the spellings of a path that a platform
// reads as the same file: another case on a file system that ignores case, a path with "..", a path with repeated
// separators, and the files that sqlite keeps next to the database.

const config = { paths: { data: './data' } } as unknown as Pick<Config, 'paths'>;

function fakeRepo(): { root: string; live: string } {
  const root = mkdtempSync(join(tmpdir(), 'okc-eval-attack-'));
  mkdirSync(join(root, 'data'));
  const live = join(root, 'data', 'okc.sqlite');
  writeFileSync(live, 'live');
  return { root, live };
}

describe('the live check against other spellings of the path', () => {
  it('refuses the live database in another case when the file system ignores case', () => {
    const { root } = fakeRepo();
    const upper = join(root, 'DATA', 'OKC.SQLITE');
    // a file system that tells case apart has no such file, and the spelling is another file there.
    if (!existsSync(upper)) return;
    const check = { config, configPath: join(root, 'okc.config.json'), roots: [root] };
    expect(liveDatabaseReason(upper, check)).not.toBeNull();
    // a file that does not exist yet in the data folder of another case is refused too.
    expect(liveDatabaseReason(join(root, 'Data', 'other.sqlite'), check)).not.toBeNull();
  });

  it('refuses a path with "..", "." and repeated separators that ends at the live database', () => {
    const { root } = fakeRepo();
    const check = { config, configPath: join(root, 'okc.config.json'), roots: [root] };
    expect(liveDatabaseReason(`${root}/data/../data/./okc.sqlite`, check)).not.toBeNull();
    expect(liveDatabaseReason(`${root}//data///okc.sqlite`, check)).not.toBeNull();
  });

  it('refuses the wal and shm files of the live database', () => {
    const { root } = fakeRepo();
    const check = { config, configPath: join(root, 'okc.config.json'), roots: [root] };
    expect(liveDatabaseReason(join(root, 'data', 'okc.sqlite-wal'), check)).not.toBeNull();
    expect(liveDatabaseReason(join(root, 'data', 'okc.sqlite-shm'), check)).not.toBeNull();
  });

  it('refuses the live database when the check runs from inside the data folder', () => {
    const { root } = fakeRepo();
    const check = { config, configPath: join(root, 'okc.config.json'), roots: [root], cwd: join(root, 'data') };
    expect(liveDatabaseReason('okc.sqlite', check)).not.toBeNull();
  });
});
