import type { FileIn, FileOut } from './types.js';

// the engine api moves files as tar archives. the sandbox needs only plain files and folders, so this is a small ustar
// writer and reader instead of a dependency.

const BLOCK = 512;
const NAME_BYTES = 100;
const PREFIX_BYTES = 155;
// the owner of each entry is the sandbox user (SANDBOX_USER in limits.ts).
const OWNER_ID = 1000;
const OWNER_NAME = 'sandbox';
// a hostile archive can hold many links. the reader keeps this many skipped entries and then one entry that says so.
const MAX_SKIPPED = 100;

// the offset and the length of each header field that the writer or the reader uses.
const FIELD = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  checksum: [148, 8],
  typeflag: [156, 1],
  magic: [257, 6],
  version: [263, 2],
  uname: [265, 32],
  gname: [297, 32],
  prefix: [345, 155],
} as const;

type Field = keyof typeof FIELD;

function writeField(header: Buffer, field: Field, value: Buffer | string): void {
  const [offset, length] = FIELD[field];
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  bytes.copy(header, offset, 0, Math.min(bytes.length, length));
}

// an octal field holds digits with leading zeros and ends with a nul byte, so a field of 8 bytes holds 7 digits.
function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

// the checksum is the sum of all header bytes, with the checksum field counted as eight spaces.
function checksumOf(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= FIELD.checksum[0] && i < FIELD.checksum[0] + FIELD.checksum[1] ? 0x20 : header[i]!;
  return sum;
}

// splitPath gives the name and the prefix field of a path. a path of at most 100 bytes needs no prefix. a longer
// path splits at a slash, so that the prefix has at most 155 bytes and the name at most 100.
function splitPath(path: string): { name: Buffer; prefix: Buffer } {
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.length <= NAME_BYTES) return { name: bytes, prefix: Buffer.alloc(0) };
  // the slash at the end of a folder name is part of the name, so the split never uses it.
  const last = path.endsWith('/') ? bytes.length - 1 : bytes.length;
  for (let i = 0; i < last; i++) {
    if (bytes[i] !== 0x2f) continue;
    const name = bytes.subarray(i + 1);
    if (i <= PREFIX_BYTES && name.length <= NAME_BYTES && name.length > 0) return { name, prefix: bytes.subarray(0, i) };
  }
  throw new Error(`the path ${path} is too long for the archive`);
}

function header(path: string, type: '0' | '5', size: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const { name, prefix } = splitPath(path);
  writeField(block, 'name', name);
  writeField(block, 'prefix', prefix);
  writeField(block, 'mode', type === '5' ? '0000755\0' : '0000644\0');
  writeField(block, 'uid', octal(OWNER_ID, 8));
  writeField(block, 'gid', octal(OWNER_ID, 8));
  writeField(block, 'size', octal(size, 12));
  writeField(block, 'mtime', octal(mtime, 12));
  writeField(block, 'typeflag', type);
  writeField(block, 'magic', 'ustar\0');
  writeField(block, 'version', '00');
  writeField(block, 'uname', OWNER_NAME);
  writeField(block, 'gname', OWNER_NAME);
  // the checksum has six digits, a nul byte and a space.
  writeField(block, 'checksum', `${checksumOf(block).toString(8).padStart(6, '0')}\0 `);
  return block;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

// packTar writes each file with mode 0644, owner 1000:1000 (the sandbox user), and the folders that its path needs
// with mode 0755. a path longer than the 100-byte name field uses the ustar prefix field, and a path that does not fit
// throws.
export function packTar(files: FileIn[], mtime: Date): Buffer {
  const seconds = Math.max(0, Math.floor(mtime.getTime() / 1000));
  const parts: Buffer[] = [];
  const folders = new Set<string>();
  for (const file of files) {
    if (!file.path || file.path.startsWith('/')) throw new Error(`the path ${file.path} is not relative`);
    const segments = file.path.split('/');
    // each parent folder comes once, before the first file in it, so the engine makes it with the sandbox owner.
    for (let i = 1; i < segments.length; i++) {
      const folder = `${segments.slice(0, i).join('/')}/`;
      if (folders.has(folder)) continue;
      folders.add(folder);
      parts.push(header(folder, '5', 0, seconds));
    }
    parts.push(header(file.path, '0', file.bytes.length, seconds), file.bytes, padding(file.bytes.length));
  }
  // two zero blocks end the archive.
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export interface Unpacked {
  files: FileOut[];
  // the entries that the reader did not take: a link, a device, a path with "..", or a file over a limit.
  skipped: Array<{ path: string; reason: string }>;
}

// a text field ends at its first nul byte.
function text(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return (end === -1 ? bytes : bytes.subarray(0, end)).toString('utf8');
}

function readField(block: Buffer, field: Field): Buffer {
  const [offset, length] = FIELD[field];
  return block.subarray(offset, offset + length);
}

// readNumber reads an octal field. a large size can use the base-256 form, where the first byte has its high bit set.
// it gives NaN for a field that is not a number.
function readNumber(bytes: Buffer): number {
  if (bytes.length > 0 && (bytes[0]! & 0x80) !== 0) {
    let value = bytes[0]! & 0x7f;
    for (let i = 1; i < bytes.length; i++) value = value * 256 + bytes[i]!;
    return Number.isSafeInteger(value) ? value : NaN;
  }
  const digits = text(bytes).trim();
  return /^[0-7]+$/.test(digits) ? parseInt(digits, 8) : NaN;
}

// a pax header holds records of the form "<length> <key>=<value>\n". the reader needs only the path.
function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(data.subarray(at, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= space - at || at + length > data.length) break;
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals !== -1 && record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    at += length;
  }
  return path;
}

// placePath gives the path of an entry under /work, or undefined when the path is not safe. "." segments and empty
// segments are dropped, so "./out/a.txt" and "out//a.txt" read as "out/a.txt".
function placePath(name: string, strip: string, prefix: string): string | undefined {
  if (name.startsWith('/') || name.includes('\0')) return undefined;
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return undefined;
  if (strip !== '' && segments[0] === strip) segments.shift();
  const path = [...prefix.split('/').filter((segment) => segment !== ''), ...segments].join('/');
  if (path === '' || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) return undefined;
  return path;
}

// unpackTar reads plain files only. the engine names each entry under the base name of the asked path, so strip is
// that first segment, and prefix puts the paths of the result relative to /work again. it reads pax and gnu long names.
// for example, the tar of /work/out names its entries "out/a.txt", so strip "out" with prefix "out" gives "out/a.txt",
// and the tar of /work/sub/a.txt names its entry "a.txt", so strip "a.txt" with prefix "sub/a.txt" gives "sub/a.txt".
// it never throws: a damaged or short archive gives the files that it read before the damage, and a skipped entry.
export function unpackTar(
  tar: Buffer,
  options: { strip: string; prefix: string; maxFiles: number; maxFileBytes: number; maxTotalBytes: number },
): Unpacked {
  const files: FileOut[] = [];
  const skipped: Unpacked['skipped'] = [];
  const skip = (path: string, reason: string) => {
    if (skipped.length < MAX_SKIPPED) skipped.push({ path, reason });
    else if (skipped.length === MAX_SKIPPED) skipped.push({ path: '', reason: 'more entries were skipped' });
  };
  const seen = new Set<string>();
  let total = 0;
  let offset = 0;
  // a gnu long name or a pax path names the next entry only.
  let longName: string | undefined;
  try {
    while (true) {
      if (offset + BLOCK > tar.length) {
        skip(longName ?? '', 'the archive ends too early');
        break;
      }
      const block = tar.subarray(offset, offset + BLOCK);
      // a zero block is the end of the archive.
      if (block.every((byte) => byte === 0)) break;
      const fieldName = text(readField(block, 'name'));
      const sum = readNumber(readField(block, 'checksum'));
      if (sum !== checksumOf(block)) {
        skip(fieldName, 'the archive is damaged');
        break;
      }
      const size = readNumber(readField(block, 'size'));
      if (Number.isNaN(size)) {
        skip(fieldName, 'the archive is damaged');
        break;
      }
      const dataStart = offset + BLOCK;
      const dataEnd = dataStart + size;
      if (dataEnd > tar.length) {
        skip(longName ?? fieldName, 'the archive ends too early');
        break;
      }
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      const type = String.fromCharCode(block[FIELD.typeflag[0]]!);
      const data = tar.subarray(dataStart, dataEnd);
      if (type === 'L') {
        longName = text(data);
        continue;
      }
      if (type === 'x') {
        longName = paxPath(data) ?? longName;
        continue;
      }
      // a global pax header and a gnu long link name do not name a file.
      if (type === 'g' || type === 'K') continue;
      // only the posix magic has a prefix field. the old gnu form keeps other values in those bytes.
      const ustarPrefix = text(readField(block, 'magic')) === 'ustar' ? text(readField(block, 'prefix')) : '';
      const name = longName ?? (ustarPrefix ? `${ustarPrefix}/${fieldName}` : fieldName);
      longName = undefined;
      if (type === '5') continue;
      if (type !== '0' && type !== '\0') {
        skip(name, 'not a plain file');
        continue;
      }
      const path = placePath(name, options.strip, options.prefix);
      if (path === undefined) {
        skip(name, 'unsafe path');
        continue;
      }
      if (seen.has(path)) {
        skip(path, 'the path is in the archive twice');
        continue;
      }
      if (size > options.maxFileBytes) {
        skip(path, 'over the file size limit');
        continue;
      }
      if (files.length >= options.maxFiles) {
        skip(path, `over the limit of ${options.maxFiles} files. the rest of the archive was not read`);
        break;
      }
      if (total + size > options.maxTotalBytes) {
        skip(path, 'over the total size limit. the rest of the archive was not read');
        break;
      }
      total += size;
      seen.add(path);
      // a copy, so the result does not hold the whole archive in memory.
      files.push({ path, bytes: Buffer.from(data) });
    }
  } catch {
    skip('', 'the archive is damaged');
  }
  return { files, skipped };
}
