import type { BlobStore } from '../observability/blobs.js';
import type { ByteStore } from '../observability/byte-blobs.js';
import type { SandboxExecInput } from './input.js';
import type { FileIn, FileOut, FileRow } from './types.js';

// files move in and out of the sandbox through the blob store. a text file goes to the text store, which redacts it,
// and any other file goes to the byte store.

export interface FileStores {
  blobs: BlobStore;
  bytes: ByteStore;
}

export type Inputs = { ok: true; files: FileIn[]; rows: FileRow[] } | { ok: false; reason: string };

// checkPath gives the reason when a path under /work is not allowed: an absolute path, a "." or ".." segment, a back
// slash, a control character, or the reserved folder .okc. it gives undefined for a good path.
export function checkPath(_path: string): string | undefined {
  throw new Error('not built: checkPath');
}

// resolveInputs reads each file of the input: content as utf-8 text, or the bytes of a blob. it refuses a file that
// has both or neither, a blob that the store does not have, two files with one path, and files over FILE_LIMITS.
export function resolveInputs(_files: NonNullable<SandboxExecInput['files']>, _stores: FileStores): Inputs {
  throw new Error('not built: resolveInputs');
}

// storeOutputs puts each collected file into a store and gives its row. a file is text when it is valid utf-8 with no
// nul byte.
export function storeOutputs(_files: FileOut[], _stores: FileStores): FileRow[] {
  throw new Error('not built: storeOutputs');
}

// mimeOf guesses the type from the extension, and from the first bytes for a file without a known extension.
export function mimeOf(_path: string, _bytes: Buffer): string {
  throw new Error('not built: mimeOf');
}
