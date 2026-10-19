import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { packTar, unpackTar } from './tar.js';

const MTIME = new Date('2026-10-13T03:15:00Z');
const OPEN = { strip: '', prefix: '', maxFiles: 100, maxFileBytes: 1_000_000, maxTotalBytes: 10_000_000 };
const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text, 'utf8') });
const texts = (files: Array<{ path: string; bytes: Buffer }>) => files.map((each) => [each.path, each.bytes.toString('utf8')]);

// entry builds one archive entry by hand, apart from the code under test, so a hostile archive can have any field.
function entry(name: string, options: { type?: string; data?: Buffer | string; prefix?: string; link?: string; magic?: string } = {}): Buffer {
  const data = typeof options.data === 'string' ? Buffer.from(options.data) : (options.data ?? Buffer.alloc(0));
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100);
  block.write('0001750\0', 108);
  block.write('0001750\0', 116);
  block.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  block.write('15073346100\0', 136);
  block.write(options.type ?? '0', 156);
  if (options.link) block.write(options.link, 157, 100);
  block.write(options.magic ?? 'ustar\u000000', 257, 'binary');
  if (options.prefix) block.write(options.prefix, 345, 155);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([block, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const archive = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);
const pax = (records: Record<string, string>) =>
  Object.entries(records)
    .map(([key, value]) => {
      const body = ` ${key}=${value}\n`;
      // the length counts its own digits.
      let length = body.length + 1;
      while (`${length}${body}`.length !== length) length++;
      return `${length}${body}`;
    })
    .join('');

describe('packTar and unpackTar', () => {
  it('reads back what it writes, with nested folders, a long path and a utf-8 name', () => {
    const long = `${'d'.repeat(60)}/${'e'.repeat(40)}/${'f'.repeat(44)}.txt`;
    expect(long.length).toBe(150);
    const files = [file('a.txt', 'alpha'), file('src/lib/b.py', 'print(1)\n'), file('src/c.js', ''), file(long, 'long'), file('résumé/naïve.md', 'ünïcode')];
    const tar = packTar(files, MTIME);
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true);
    const unpacked = unpackTar(tar, OPEN);
    expect(unpacked.skipped).toEqual([]);
    expect(texts(unpacked.files)).toEqual(texts(files));
  });

  it('writes each folder once before its files, with the ustar fields', () => {
    const tar = packTar([file('out/x/a.txt', 'a'), file('out/x/b.txt', 'b'), file('out/c.txt', 'c')], MTIME);
    const names: string[] = [];
    for (let offset = 0; offset + 512 <= tar.length; ) {
      const block = tar.subarray(offset, offset + 512);
      if (block.every((byte) => byte === 0)) break;
      const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const type = String.fromCharCode(block[156]!);
      names.push(`${type} ${name}`);
      expect(block.subarray(100, 108).toString()).toBe(type === '5' ? '0000755\0' : '0000644\0');
      expect(block.subarray(108, 116).toString()).toBe('0001750\0');
      expect(block.subarray(257, 265).toString('binary')).toBe('ustar\u000000');
      expect(block.subarray(265, 272).toString()).toBe('sandbox');
      expect(block.subarray(297, 304).toString()).toBe('sandbox');
      expect(parseInt(block.subarray(136, 148).toString(), 8)).toBe(MTIME.getTime() / 1000);
      const size = parseInt(block.subarray(124, 136).toString(), 8);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual(['5 out/', '5 out/x/', '0 out/x/a.txt', '0 out/x/b.txt', '0 out/c.txt']);
  });

  it('pads data to a full block', () => {
    const tar = packTar([file('a', 'x'.repeat(513))], MTIME);
    expect(tar.length).toBe(512 + 1024 + 1024);
  });

  it('writes a pax path for a path that cannot split, and throws on an absolute path', () => {
    const long = ['x'.repeat(101), `${'p'.repeat(156)}/name`, `${'é'.repeat(80)}/${'a'.repeat(150)}.csv`];
    for (const path of long) {
      const unpacked = unpackTar(packTar([file(path, 'a')], MTIME), OPEN);
      expect(unpacked.skipped).toEqual([]);
      expect(texts(unpacked.files)).toEqual([[path, 'a']]);
    }
    expect(() => packTar([file('/etc/passwd', 'a')], MTIME)).toThrow();
  });

  it('strips the base name of the asked path and adds the prefix', () => {
    const folder = packTar([file('out/a.txt', 'a'), file('out/sub/b.txt', 'b')], MTIME);
    expect(texts(unpackTar(folder, { ...OPEN, strip: 'out', prefix: 'out' }).files)).toEqual([
      ['out/a.txt', 'a'],
      ['out/sub/b.txt', 'b'],
    ]);
    expect(texts(unpackTar(folder, { ...OPEN, strip: 'out', prefix: 'results/run1' }).files)).toEqual([
      ['results/run1/a.txt', 'a'],
      ['results/run1/sub/b.txt', 'b'],
    ]);
    expect(texts(unpackTar(folder, { ...OPEN, strip: 'out', prefix: '' }).files)).toEqual([
      ['a.txt', 'a'],
      ['sub/b.txt', 'b'],
    ]);
    // the tar of /work/a.txt names its entry a.txt, and the tar of /work/sub/a.txt does too.
    const single = packTar([file('a.txt', 'one')], MTIME);
    expect(texts(unpackTar(single, { ...OPEN, strip: 'a.txt', prefix: 'a.txt' }).files)).toEqual([['a.txt', 'one']]);
    expect(texts(unpackTar(single, { ...OPEN, strip: 'a.txt', prefix: 'sub/a.txt' }).files)).toEqual([['sub/a.txt', 'one']]);
    // a first segment that is not strip stays.
    expect(texts(unpackTar(folder, { ...OPEN, strip: 'other', prefix: '' }).files)[0]).toEqual(['out/a.txt', 'a']);
  });
});

describe('unpackTar on hostile archives', () => {
  it('skips links, devices and unsafe paths, and reads pax and gnu long names', () => {
    const longName = `${'g'.repeat(120)}/file.txt`;
    const tar = archive(
      entry('out/', { type: '5' }),
      entry('out/link', { type: '2', link: '/etc/passwd' }),
      entry('out/hard', { type: '1', link: 'out/ok.txt' }),
      entry('out/dev', { type: '3' }),
      entry('out/fifo', { type: '6' }),
      entry('../evil', { data: 'evil' }),
      entry('out/../../evil', { data: 'evil' }),
      entry('/etc/cron', { data: 'evil' }),
      entry('out/ok.txt', { data: 'ok' }),
      entry('PaxHeader', { type: 'x', data: pax({ mtime: '1', path: 'out/from-pax.txt' }) }),
      entry('ignored-name', { data: 'pax' }),
      entry('././@LongLink', { type: 'L', data: `${longName}\0` }),
      entry('short', { data: 'gnu', magic: 'ustar  \0' }),
      entry('nested.txt', { prefix: 'out/deep', data: 'prefix' }),
      entry('PaxHeader', { type: 'x', data: pax({ path: '../pax-evil' }) }),
      entry('fine-name', { data: 'evil' }),
    );
    const unpacked = unpackTar(tar, { ...OPEN, strip: 'out', prefix: 'out' });
    expect(texts(unpacked.files)).toEqual([
      ['out/ok.txt', 'ok'],
      ['out/from-pax.txt', 'pax'],
      [`out/${longName}`, 'gnu'],
      ['out/deep/nested.txt', 'prefix'],
    ]);
    expect(unpacked.skipped).toEqual([
      { path: 'out/link', reason: 'not a plain file' },
      { path: 'out/hard', reason: 'not a plain file' },
      { path: 'out/dev', reason: 'not a plain file' },
      { path: 'out/fifo', reason: 'not a plain file' },
      { path: '../evil', reason: 'unsafe path' },
      { path: 'out/../../evil', reason: 'unsafe path' },
      { path: '/etc/cron', reason: 'unsafe path' },
      { path: '../pax-evil', reason: 'unsafe path' },
    ]);
  });

  it('refuses a nul byte in a pax path and a second entry with one path', () => {
    const tar = archive(entry('x', { type: 'x', data: pax({ path: 'a\0b' }) }), entry('n', { data: 'x' }), entry('a', { data: '1' }), entry('a', { data: '2' }));
    const unpacked = unpackTar(tar, OPEN);
    expect(texts(unpacked.files)).toEqual([['a', '1']]);
    expect(unpacked.skipped.map((each) => each.reason)).toEqual(['unsafe path', 'the path is in the archive twice']);
  });

  it('stops at a bad checksum and keeps what it read', () => {
    const bad = entry('b.txt', { data: 'b' });
    bad[0] = 'c'.charCodeAt(0);
    const unpacked = unpackTar(archive(entry('a.txt', { data: 'a' }), bad, entry('d.txt', { data: 'd' })), OPEN);
    expect(texts(unpacked.files)).toEqual([['a.txt', 'a']]);
    expect(unpacked.skipped).toEqual([{ path: 'c.txt', reason: 'the archive is damaged' }]);
  });

  it('reads a truncated archive up to the cut', () => {
    const full = packTar([file('a.txt', 'a'), file('b.txt', 'b'.repeat(2000))], MTIME);
    for (const cut of [0, 100, 512, 1024, 1024 + 300, 1024 + 512 + 100]) {
      const unpacked = unpackTar(full.subarray(0, cut), OPEN);
      expect(unpacked.files.length).toBe(cut >= 1024 ? 1 : 0);
      expect(unpacked.skipped.length).toBeGreaterThan(0);
      expect(unpacked.skipped.at(-1)!.reason).toBe('the archive ends too early');
    }
    // with the data complete and no end blocks, both files are read.
    const noEnd = unpackTar(full.subarray(0, full.length - 1024), OPEN);
    expect(noEnd.files.map((each) => each.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('does not throw on random bytes', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 256;
    for (let round = 0; round < 50; round++) {
      const bytes = Buffer.from(Array.from({ length: 512 * (1 + (round % 4)) }, random));
      expect(() => unpackTar(bytes, OPEN)).not.toThrow();
    }
    // a header with a good checksum and a huge base-256 size.
    const huge = entry('a', { data: '' });
    huge.fill(0, 124, 136);
    huge[124] = 0x80;
    huge.fill(0xff, 125, 136);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : huge[i]!;
    huge.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    const unpacked = unpackTar(archive(huge), OPEN);
    expect(unpacked.files).toEqual([]);
    expect(unpacked.skipped).toHaveLength(1);
  });

  it('keeps the limits', () => {
    const tar = packTar([file('a', '1'.repeat(10)), file('big', '2'.repeat(100)), file('b', '3'.repeat(10)), file('c', '4'.repeat(10))], MTIME);
    const perFile = unpackTar(tar, { ...OPEN, maxFileBytes: 50 });
    expect(perFile.files.map((each) => each.path)).toEqual(['a', 'b', 'c']);
    expect(perFile.skipped).toEqual([{ path: 'big', reason: 'over the file size limit' }]);
    const count = unpackTar(tar, { ...OPEN, maxFiles: 2 });
    expect(count.files.map((each) => each.path)).toEqual(['a', 'big']);
    expect(count.skipped).toEqual([{ path: 'b', reason: 'over the limit of 2 files. the rest of the archive was not read' }]);
    const total = unpackTar(tar, { ...OPEN, maxTotalBytes: 115 });
    expect(total.files.map((each) => each.path)).toEqual(['a', 'big']);
    expect(total.skipped).toEqual([{ path: 'b', reason: 'over the total size limit. the rest of the archive was not read' }]);
  });

  it('keeps a bounded list of skipped entries', () => {
    const links = Array.from({ length: 150 }, (_, i) => entry(`l${i}`, { type: '2', link: 'x' }));
    const unpacked = unpackTar(archive(...links), OPEN);
    expect(unpacked.skipped).toHaveLength(101);
    expect(unpacked.skipped.at(-1)).toEqual({ path: '', reason: 'more entries were skipped' });
  });
});

const hasTar = spawnSync('tar', ['--version']).status === 0;

describe.skipIf(!hasTar)('the system tar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'okc-tar-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists and extracts an archive that packTar wrote', () => {
    const long = `${'d'.repeat(60)}/${'e'.repeat(40)}/${'f'.repeat(44)}.txt`;
    const path = join(dir, 'packed.tar');
    writeFileSync(path, packTar([file('out/a.txt', 'alpha'), file(long, 'long')], MTIME));
    const listing = execFileSync('tar', ['-tvf', path], { encoding: 'utf8' });
    expect(listing).toContain('out/a.txt');
    expect(listing).toContain(long);
    const target = join(dir, 'extracted');
    mkdirSync(target);
    execFileSync('tar', ['-xf', path, '-C', target]);
    expect(readFileSync(join(target, 'out/a.txt'), 'utf8')).toBe('alpha');
    expect(readFileSync(join(target, long), 'utf8')).toBe('long');
  });

  it('extracts a pax path that packTar wrote for a long name', () => {
    const long = `out/${'g'.repeat(150)}.csv`;
    const path = join(dir, 'pax.tar');
    writeFileSync(path, packTar([file(long, 'pax')], MTIME));
    const target = join(dir, 'pax');
    mkdirSync(target);
    execFileSync('tar', ['-xf', path, '-C', target]);
    expect(readFileSync(join(target, long), 'utf8')).toBe('pax');
  });

  it('reads an archive that the system tar wrote', () => {
    const source = join(dir, 'source');
    mkdirSync(join(source, 'out', 'sub'), { recursive: true });
    writeFileSync(join(source, 'out', 'a.txt'), 'alpha');
    writeFileSync(join(source, 'out', 'sub', 'b.bin'), Buffer.from([0, 1, 2, 255]));
    const path = join(dir, 'system.tar');
    // the variable keeps a macos tar from adding resource fork entries.
    execFileSync('tar', ['-cf', path, '-C', source, 'out'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const unpacked = unpackTar(readFileSync(path), { ...OPEN, strip: 'out', prefix: 'out' });
    expect(unpacked.skipped).toEqual([]);
    expect(unpacked.files.map((each) => each.path).sort()).toEqual(['out/a.txt', 'out/sub/b.bin']);
    expect(unpacked.files.find((each) => each.path === 'out/sub/b.bin')!.bytes).toEqual(Buffer.from([0, 1, 2, 255]));
  });
});
