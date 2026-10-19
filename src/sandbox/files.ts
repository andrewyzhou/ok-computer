import type { BlobStore } from '../observability/blobs.js';
import type { ByteStore } from '../observability/byte-blobs.js';
import type { SandboxExecInput } from './input.js';
import { FILE_LIMITS } from './limits.js';
import type { FileIn, FileOut, FileRow } from './types.js';

// files move in and out of the sandbox through the blob store. a text file goes to the text store, which redacts it,
// and any other file goes to the byte store.

export interface FileStores {
  blobs: BlobStore;
  bytes: ByteStore;
}

export type Inputs = { ok: true; files: FileIn[]; rows: FileRow[] } | { ok: false; reason: string };

// the first folder of /work that the sandbox keeps for itself.
const RESERVED = '.okc';
const MB = 1024 * 1024;

// checkPath gives the reason when a path under /work is not allowed: an absolute path, a "." or ".." segment, a back
// slash, a control character, or the reserved folder .okc. it gives undefined for a good path.
export function checkPath(path: string): string | undefined {
  if (path === '') return 'give a path relative to /work, for example data/input.csv';
  if (path.length > FILE_LIMITS.pathChars) return `use a path of at most ${FILE_LIMITS.pathChars} characters`;
  if (path.startsWith('/')) return 'use a path relative to /work, for example data/input.csv';
  if (path.includes('\\')) return 'use a forward slash between folders, not a back slash';
  // this also catches a nul byte.
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'remove the control character from the path';
  const segments = path.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'remove the . and .. segments from the path';
  if (segments.some((segment) => segment === '')) return 'remove the empty segment from the path (a double slash or a slash at the end)';
  if (segments[0] === RESERVED) return `the folder ${RESERVED} is reserved. use another folder`;
  return undefined;
}

// isText decides how a file is stored: valid utf-8 with no nul byte is text.
function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const name = (path: string) => JSON.stringify(path);

// resolveInputs reads each file of the input: content as utf-8 text, or the bytes of a blob. it refuses a file that
// has both or neither, a blob that the store does not have, two files with one path, and files over FILE_LIMITS.
export function resolveInputs(files: NonNullable<SandboxExecInput['files']>, stores: FileStores): Inputs {
  if (files.length > FILE_LIMITS.count) return { ok: false, reason: `give at most ${FILE_LIMITS.count} files` };
  // the cheap checks come first, so a refused call stores nothing.
  const paths = new Set<string>();
  for (const file of files) {
    const reason = checkPath(file.path);
    if (reason) return { ok: false, reason: `the file ${name(file.path)}: ${reason}` };
    const hasContent = file.content !== undefined;
    const hasBlob = file.blob !== undefined;
    if (hasContent && hasBlob) return { ok: false, reason: `the file ${name(file.path)}: give content or blob, not both` };
    if (!hasContent && !hasBlob) return { ok: false, reason: `the file ${name(file.path)}: give content or blob` };
    if (paths.has(file.path)) return { ok: false, reason: `two files have the path ${name(file.path)}. give each path once` };
    paths.add(file.path);
  }
  // a path cannot be a file and also the folder of another file.
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const folder = segments.slice(0, i).join('/');
      if (paths.has(folder)) return { ok: false, reason: `the path ${name(folder)} is a file and also the folder of ${name(path)}` };
    }
  }

  const read: Array<{ path: string; bytes: Buffer; mime: string; content?: string; blob?: string }> = [];
  let total = 0;
  for (const file of files) {
    let bytes: Buffer;
    let mime: string;
    if (file.content !== undefined) {
      bytes = Buffer.from(file.content, 'utf8');
      mime = mimeOf(file.path, bytes);
    } else {
      const hash = file.blob!;
      try {
        // the byte store knows the mime of each blob. a text blob that only the text store can read is utf-8.
        const stored = stores.bytes.read(hash);
        if (stored) {
          bytes = stored.bytes;
          mime = stored.mime;
        } else {
          const text = stores.blobs.read(hash);
          if (text === undefined) return { ok: false, reason: `the file ${name(file.path)}: no file has the blob ${hash}` };
          bytes = Buffer.from(text, 'utf8');
          mime = mimeOf(file.path, bytes);
        }
      } catch (err) {
        return { ok: false, reason: `the file ${name(file.path)}: ${(err as Error).message}` };
      }
    }
    if (bytes.length > FILE_LIMITS.fileBytes) {
      return { ok: false, reason: `the file ${name(file.path)} is over the limit of ${FILE_LIMITS.fileBytes / MB} MB for one file` };
    }
    total += bytes.length;
    if (total > FILE_LIMITS.totalBytes) return { ok: false, reason: `the files are over the total limit of ${FILE_LIMITS.totalBytes / MB} MB` };
    read.push({ path: file.path, bytes, mime, ...(file.content !== undefined ? { content: file.content } : { blob: file.blob! }) });
  }

  const rows: FileRow[] = read.map((file) => ({
    direction: 'in',
    path: file.path,
    // the model gave this text, and the trace must not keep a secret, so the text goes through the redacting store.
    // the hash of the row is then the hash of the redacted text, while the container gets the original bytes.
    blob: file.content !== undefined ? stores.blobs.put(file.content, file.mime) : file.blob!,
    // the size is the size of the file in /work, which can differ from the size of the redacted blob.
    size: file.bytes.length,
    mime: file.mime,
  }));
  return { ok: true, files: read.map((file) => ({ path: file.path, bytes: file.bytes })), rows };
}

// storeOutputs puts each collected file into a store and gives its row. a file is text when it is valid utf-8 with no
// nul byte.
export function storeOutputs(files: FileOut[], stores: FileStores): FileRow[] {
  return files.map((file) => {
    const mime = mimeOf(file.path, file.bytes);
    const blob = isText(file.bytes) ? stores.blobs.put(file.bytes.toString('utf8'), mime) : stores.bytes.put(file.bytes, mime);
    // the size is the byte length of the file that the command wrote. the text store keeps the redacted text, so the
    // blob of a file with a secret is shorter than this size.
    return { direction: 'out', path: file.path, blob, size: file.bytes.length, mime };
  });
}

const TEXT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/jsonl',
  py: 'text/x-python',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/x-typescript',
  sh: 'text/x-shellscript',
  html: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  svg: 'image/svg+xml',
};

const BINARY_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  parquet: 'application/vnd.apache.parquet',
  sqlite: 'application/vnd.sqlite3',
  db: 'application/vnd.sqlite3',
  npy: 'application/x-npy',
};

// the first bytes of the binary types that a file without a known extension can have.
const MAGIC: Array<[Buffer, string]> = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
  [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  [Buffer.from('GIF87a'), 'image/gif'],
  [Buffer.from('GIF89a'), 'image/gif'],
  [Buffer.from('%PDF-'), 'application/pdf'],
  [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip'],
  [Buffer.from([0x50, 0x4b, 0x05, 0x06]), 'application/zip'],
  [Buffer.from([0x1f, 0x8b]), 'application/gzip'],
  [Buffer.from('SQLite format 3\0'), 'application/vnd.sqlite3'],
];

// mimeOf guesses the type from the extension, and from the first bytes for a file without a known extension.
export function mimeOf(path: string, bytes: Buffer): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // a name such as ".bashrc" has no extension.
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const textType = TEXT_TYPES[extension];
  if (textType) return `${textType}; charset=utf-8`;
  const binaryType = BINARY_TYPES[extension];
  if (binaryType) return binaryType;
  for (const [magic, type] of MAGIC) if (bytes.subarray(0, magic.length).equals(magic)) return type;
  return isText(bytes) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}
