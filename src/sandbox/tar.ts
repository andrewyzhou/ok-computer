import type { FileIn, FileOut } from './types.js';

// the engine api moves files as tar archives. the sandbox needs only plain files and folders, so this is a small ustar
// writer and reader instead of a dependency.

// packTar writes each file with mode 0644, owner 1000:1000 (the sandbox user), and the folders that its path needs
// with mode 0755. a path longer than the 100-byte name field uses the ustar prefix field, and a path that does not fit
// throws.
export function packTar(_files: FileIn[], _mtime: Date): Buffer {
  throw new Error('not built: packTar');
}

export interface Unpacked {
  files: FileOut[];
  // the entries that the reader did not take: a link, a device, a path with "..", or a file over a limit.
  skipped: Array<{ path: string; reason: string }>;
}

// unpackTar reads plain files only. the engine names each entry under the base name of the asked path, so strip is
// that first segment, and prefix puts the paths of the result relative to /work again. it reads pax and gnu long names.
export function unpackTar(
  _tar: Buffer,
  _options: { strip: string; prefix: string; maxFiles: number; maxFileBytes: number; maxTotalBytes: number },
): Unpacked {
  throw new Error('not built: unpackTar');
}
