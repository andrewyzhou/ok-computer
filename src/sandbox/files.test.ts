import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { blobPath, createBlobStore, sha256 } from '../observability/blobs.js';
import { createByteStore } from '../observability/byte-blobs.js';
import { registerSecret } from '../observability/redact.js';
import { checkPath, type FileStores, mimeOf, resolveInputs, storeOutputs } from './files.js';
import { FILE_LIMITS } from './limits.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

// the two stores use two folders, so a text blob that only the text store holds takes the fallback path.
function setup() {
  const db = openDb(':memory:');
  const clock = () => new Date('2026-10-13T03:15:00Z');
  const textDir = mkdtempSync(join(tmpdir(), 'okc-files-text-'));
  const byteDir = mkdtempSync(join(tmpdir(), 'okc-files-bytes-'));
  const stores: FileStores = { blobs: createBlobStore(db, textDir, clock), bytes: createByteStore(db, byteDir, clock) };
  return { db, stores, textDir, byteDir };
}

const refused = (result: ReturnType<typeof resolveInputs>) => (result.ok ? undefined : result.reason);

describe('checkPath', () => {
  it('accepts a normal relative path', () => {
    expect(checkPath('a.txt')).toBeUndefined();
    expect(checkPath('data/input.csv')).toBeUndefined();
    expect(checkPath('.hidden/x')).toBeUndefined();
    expect(checkPath('okc/x')).toBeUndefined();
    expect(checkPath('résumé.md')).toBeUndefined();
    expect(checkPath('x'.repeat(FILE_LIMITS.pathChars))).toBeUndefined();
  });

  it('refuses each bad form with a reason', () => {
    const cases: Array<[string, RegExp]> = [
      ['', /give a path/],
      ['x'.repeat(FILE_LIMITS.pathChars + 1), /at most 200 characters/],
      ['/etc/passwd', /relative to \/work/],
      ['a\\b', /back slash/],
      ['a\0b', /control character/],
      ['a\nb', /control character/],
      ['a\u007fb', /control character/],
      ['./a', /\. and \.\. segments/],
      ['a/./b', /\. and \.\. segments/],
      ['..', /\. and \.\. segments/],
      ['a/../../b', /\. and \.\. segments/],
      ['a//b', /empty segment/],
      ['a/', /empty segment/],
      ['.okc', /reserved/],
      ['.okc/state', /reserved/],
    ];
    for (const [path, reason] of cases) expect(checkPath(path), JSON.stringify(path)).toMatch(reason);
  });
});

describe('resolveInputs', () => {
  it('reads content and blobs from both stores and traces content', () => {
    const { stores, db } = setup();
    const textHash = stores.blobs.put('from an earlier exec\n', 'text/csv; charset=utf-8');
    const pngHash = stores.bytes.put(PNG, 'image/png');
    const result = resolveInputs(
      [
        { path: 'code/main.py', content: 'print("hi")\n' },
        { path: 'data/old.csv', blob: textHash },
        { path: 'img/chart.png', blob: pngHash },
      ],
      stores,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual([
      { path: 'code/main.py', bytes: Buffer.from('print("hi")\n') },
      { path: 'data/old.csv', bytes: Buffer.from('from an earlier exec\n') },
      { path: 'img/chart.png', bytes: PNG },
    ]);
    const contentHash = sha256('print("hi")\n');
    expect(result.rows).toEqual([
      { direction: 'in', path: 'code/main.py', blob: contentHash, size: 12, mime: 'text/x-python; charset=utf-8' },
      { direction: 'in', path: 'data/old.csv', blob: textHash, size: 21, mime: 'text/csv; charset=utf-8' },
      { direction: 'in', path: 'img/chart.png', blob: pngHash, size: PNG.length, mime: 'image/png' },
    ]);
    expect(stores.blobs.read(contentHash)).toBe('print("hi")\n');
    expect(db.prepare('SELECT mime FROM blobs WHERE hash = ?').get(contentHash)).toEqual({ mime: 'text/x-python; charset=utf-8' });
  });

  it('keeps a secret in content out of the blob but gives it to the container', () => {
    const { stores, textDir } = setup();
    const secret = 'sandbox-test-secret-4f9a2c71';
    registerSecret(secret);
    const content = `TOKEN=${secret}\n`;
    const result = resolveInputs([{ path: 'env.sh', content }], stores);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files[0]!.bytes.toString()).toBe(content);
    const row = result.rows[0]!;
    expect(row.blob).toBe(sha256('TOKEN=[redacted]\n'));
    expect(row.blob).not.toBe(sha256(content));
    expect(readFileSync(blobPath(textDir, row.blob), 'utf8')).not.toContain(secret);
    // the size is the size of the file in /work, not of the redacted blob.
    expect(row.size).toBe(Buffer.byteLength(content));
  });

  it('refuses each bad input and stores nothing', () => {
    const { stores, db } = setup();
    const missing = 'a'.repeat(64);
    const cases: Array<[Parameters<typeof resolveInputs>[0], RegExp]> = [
      [[{ path: '../x', content: 'a' }], /the file "\.\.\/x": remove the \. and \.\. segments/],
      [[{ path: 'a', content: 'a', blob: missing }], /give content or blob, not both/],
      [[{ path: 'a' }], /the file "a": give content or blob$/],
      [
        [
          { path: 'a', content: '1' },
          { path: 'a', content: '2' },
        ],
        /two files have the path "a"/,
      ],
      [
        [
          { path: 'data/x/y.csv', content: '1' },
          { path: 'data/x', content: '2' },
        ],
        /the path "data\/x" is a file and also the folder of "data\/x\/y.csv"/,
      ],
      [[{ path: 'a', blob: missing }], new RegExp(`no file has the blob ${missing}`)],
      [Array.from({ length: FILE_LIMITS.count + 1 }, (_, i) => ({ path: `f${i}`, content: 'x' })), /at most 20 files/],
    ];
    for (const [files, reason] of cases) expect(refused(resolveInputs(files, stores)), JSON.stringify(files).slice(0, 80)).toMatch(reason);
    expect(db.prepare('SELECT count(*) AS n FROM blobs').get()).toEqual({ n: 0 });
  });

  it('refuses files over the size limits', () => {
    const { stores } = setup();
    const big = stores.bytes.put(Buffer.alloc(FILE_LIMITS.fileBytes + 1, 1), 'application/octet-stream');
    expect(refused(resolveInputs([{ path: 'big.bin', blob: big }], stores))).toMatch(/over the limit of 10 MB for one file/);
    const nine = stores.bytes.put(Buffer.alloc(9 * 1024 * 1024, 2), 'application/octet-stream');
    const files = [0, 1, 2].map((i) => ({ path: `p${i}.bin`, blob: nine }));
    expect(refused(resolveInputs(files, stores))).toMatch(/over the total limit of 20 MB/);
    expect(resolveInputs(files.slice(0, 2), stores).ok).toBe(true);
  });

  it('gives the reason for a damaged blob and does not throw', () => {
    const { stores, byteDir, textDir } = setup();
    const bytesHash = stores.bytes.put(PNG, 'image/png');
    writeFileSync(blobPath(byteDir, bytesHash), 'broken');
    expect(refused(resolveInputs([{ path: 'a.png', blob: bytesHash }], stores))).toMatch(/is damaged/);
    const textHash = stores.blobs.put('some text');
    writeFileSync(blobPath(textDir, textHash), 'other text');
    expect(refused(resolveInputs([{ path: 'a.txt', blob: textHash }], stores))).toMatch(/is damaged/);
  });
});

describe('storeOutputs', () => {
  it('stores text in the text store and other bytes in the byte store', () => {
    const { stores, db } = setup();
    const utf8 = Buffer.from('naïve,1\n');
    const withNul = Buffer.from('a\0b');
    const invalid = Buffer.from([0x66, 0x6f, 0xc3]);
    const rows = storeOutputs(
      [
        { path: 'out/a.csv', bytes: utf8 },
        { path: 'out/nul.txt', bytes: withNul },
        { path: 'out/bad', bytes: invalid },
        { path: 'out/chart.png', bytes: PNG },
        { path: 'out/empty', bytes: Buffer.alloc(0) },
      ],
      stores,
    );
    expect(rows).toEqual([
      { direction: 'out', path: 'out/a.csv', blob: sha256(utf8), size: utf8.length, mime: 'text/csv; charset=utf-8' },
      { direction: 'out', path: 'out/nul.txt', blob: sha256(withNul), size: 3, mime: 'text/plain; charset=utf-8' },
      { direction: 'out', path: 'out/bad', blob: sha256(invalid), size: 3, mime: 'application/octet-stream' },
      { direction: 'out', path: 'out/chart.png', blob: sha256(PNG), size: PNG.length, mime: 'image/png' },
      { direction: 'out', path: 'out/empty', blob: sha256(''), size: 0, mime: 'text/plain; charset=utf-8' },
    ]);
    // text is readable from the text store, and bytes from the byte store only.
    expect(stores.blobs.read(rows[0]!.blob)).toBe('naïve,1\n');
    expect(stores.blobs.read(rows[1]!.blob)).toBeUndefined();
    expect(stores.bytes.read(rows[1]!.blob)!.bytes).toEqual(withNul);
    expect(stores.bytes.read(rows[3]!.blob)).toEqual({ bytes: PNG, mime: 'image/png' });
    expect(db.prepare('SELECT size FROM blobs WHERE hash = ?').get(rows[0]!.blob)).toEqual({ size: utf8.length });
  });

  it('redacts a secret that the command wrote and records the size of the written file', () => {
    const { stores } = setup();
    const secret = 'sandbox-output-secret-a81c3e09';
    registerSecret(secret);
    const bytes = Buffer.from(`key: ${secret}\n`);
    const [row] = storeOutputs([{ path: 'leak.yaml', bytes }], stores);
    expect(stores.blobs.read(row!.blob)).toBe('key: [redacted]\n');
    expect(row!.size).toBe(bytes.length);
    expect(row!.mime).toBe('application/yaml; charset=utf-8');
  });

  it('feeds a stored output back in as an input', () => {
    const { stores } = setup();
    const rows = storeOutputs(
      [
        { path: 'out/a.txt', bytes: Buffer.from('text') },
        { path: 'out/b.png', bytes: PNG },
      ],
      stores,
    );
    const result = resolveInputs(rows.map((row) => ({ path: row.path, blob: row.blob })), stores);
    expect(result.ok && result.files.map((each) => each.bytes)).toEqual([Buffer.from('text'), PNG]);
  });
});

describe('mimeOf', () => {
  it('uses the extension, with a charset for text types', () => {
    const none = Buffer.alloc(0);
    const cases: Array<[string, string]> = [
      ['a.txt', 'text/plain; charset=utf-8'],
      ['README.MD', 'text/markdown; charset=utf-8'],
      ['d/x.csv', 'text/csv; charset=utf-8'],
      ['x.tsv', 'text/tab-separated-values; charset=utf-8'],
      ['x.json', 'application/json; charset=utf-8'],
      ['x.jsonl', 'application/jsonl; charset=utf-8'],
      ['x.py', 'text/x-python; charset=utf-8'],
      ['x.js', 'text/javascript; charset=utf-8'],
      ['x.mjs', 'text/javascript; charset=utf-8'],
      ['x.ts', 'text/x-typescript; charset=utf-8'],
      ['x.sh', 'text/x-shellscript; charset=utf-8'],
      ['x.html', 'text/html; charset=utf-8'],
      ['x.css', 'text/css; charset=utf-8'],
      ['x.xml', 'application/xml; charset=utf-8'],
      ['x.yaml', 'application/yaml; charset=utf-8'],
      ['x.yml', 'application/yaml; charset=utf-8'],
      ['x.svg', 'image/svg+xml; charset=utf-8'],
      ['x.png', 'image/png'],
      ['x.jpg', 'image/jpeg'],
      ['x.JPEG', 'image/jpeg'],
      ['x.gif', 'image/gif'],
      ['x.webp', 'image/webp'],
      ['x.pdf', 'application/pdf'],
      ['x.zip', 'application/zip'],
      ['x.tar.gz', 'application/gzip'],
      ['x.tar', 'application/x-tar'],
      ['x.parquet', 'application/vnd.apache.parquet'],
      ['x.sqlite', 'application/vnd.sqlite3'],
      ['x.db', 'application/vnd.sqlite3'],
      ['x.npy', 'application/x-npy'],
    ];
    for (const [path, mime] of cases) expect(mimeOf(path, none), path).toBe(mime);
  });

  it('sniffs the first bytes when the extension is unknown', () => {
    const cases: Array<[Buffer, string]> = [
      [PNG, 'image/png'],
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
      [Buffer.from('GIF89a...'), 'image/gif'],
      [Buffer.from('%PDF-1.7\n'), 'application/pdf'],
      [Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), 'application/zip'],
      [Buffer.from([0x1f, 0x8b, 8, 0]), 'application/gzip'],
      [Buffer.from('SQLite format 3\0rest'), 'application/vnd.sqlite3'],
      [Buffer.from('plain words'), 'text/plain; charset=utf-8'],
      [Buffer.from([0, 1, 2, 3]), 'application/octet-stream'],
      [Buffer.from([0xc3, 0x28]), 'application/octet-stream'],
    ];
    for (const [bytes, mime] of cases) {
      expect(mimeOf('out/result', bytes)).toBe(mime);
      expect(mimeOf('out/result.unknown', bytes)).toBe(mime);
    }
    // a dot file has no extension.
    expect(mimeOf('.bashrc', Buffer.from('alias x=y'))).toBe('text/plain; charset=utf-8');
  });
});
