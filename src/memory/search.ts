import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Db } from '../db/index.js';

// about 400 tokens at 4 characters for each token.
const CHUNK_CHARS = 1600;
// backups of MEMORY.md repeat old text, so the index leaves them out.
const SKIPPED_DIRS = new Set(['history']);

export interface Chunk {
  heading: string;
  text: string;
  startLine: number;
  endLine: number;
}

export interface SearchHit extends Chunk {
  path: string;
}

// a chunk ends at each heading. paragraphs under one heading join until a chunk has about CHUNK_CHARS characters.
export function chunkMarkdown(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  const headings: string[] = [];
  let current: { lines: string[]; startLine: number } | undefined;
  let paragraph: { lines: string[]; startLine: number } | undefined;

  const flushChunk = () => {
    if (current?.lines.some((line) => line.trim())) {
      chunks.push({
        heading: headings.filter(Boolean).join(' > '),
        text: current.lines.join('\n').trim(),
        startLine: current.startLine,
        endLine: current.startLine + current.lines.length - 1,
      });
    }
    current = undefined;
  };
  const flushParagraph = () => {
    if (!paragraph) return;
    const size = current ? current.lines.join('\n').length : 0;
    if (current && size + paragraph.lines.join('\n').length > CHUNK_CHARS) flushChunk();
    if (!current) current = { lines: [], startLine: paragraph.startLine };
    // the blank lines between paragraphs stay in the chunk, so the line numbers stay correct.
    const gap = paragraph.startLine - (current.startLine + current.lines.length);
    current.lines.push(...Array<string>(Math.max(0, gap)).fill(''), ...paragraph.lines);
    paragraph = undefined;
  };

  text.split(/\r?\n/).forEach((line, i) => {
    const lineNo = i + 1;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushChunk();
      const level = heading[1]!.length;
      headings.length = level;
      headings[level - 1] = heading[2]!.trim();
      return;
    }
    if (!line.trim()) return flushParagraph();
    if (!paragraph) paragraph = { lines: [], startLine: lineNo };
    paragraph.lines.push(line);
  });
  flushParagraph();
  flushChunk();
  return chunks;
}

function markdownFiles(memoryDir: string, dir = memoryDir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) && dir === memoryDir ? [] : markdownFiles(memoryDir, path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

// the index follows the files. a file with a new size or time is indexed again, and a removed file leaves the index.
export function syncMemoryIndex(db: Db, memoryDir: string, now: Date): void {
  const known = new Map(
    db
      .prepare('SELECT path, mtimeMs, size FROM memory_files')
      .all()
      .map((row) => [String(row.path), { mtimeMs: Number(row.mtimeMs), size: Number(row.size) }]),
  );
  const removeChunks = db.prepare('DELETE FROM memory_chunks WHERE path = ?');
  const insertChunk = db.prepare('INSERT INTO memory_chunks (path, heading, text, startLine, endLine) VALUES (?, ?, ?, ?, ?)');
  const upsertFile = db.prepare(
    `INSERT INTO memory_files (path, mtimeMs, size, indexedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET mtimeMs = excluded.mtimeMs, size = excluded.size, indexedAt = excluded.indexedAt`,
  );

  db.exec('BEGIN');
  try {
    for (const file of markdownFiles(memoryDir)) {
      const path = relative(memoryDir, file).split(sep).join('/');
      const stat = statSync(file);
      const previous = known.get(path);
      known.delete(path);
      if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size) continue;
      removeChunks.run(path);
      for (const chunk of chunkMarkdown(readFileSync(file, 'utf8'))) {
        insertChunk.run(path, chunk.heading, chunk.text, chunk.startLine, chunk.endLine);
      }
      upsertFile.run(path, stat.mtimeMs, stat.size, now.toISOString());
    }
    for (const path of known.keys()) {
      removeChunks.run(path);
      db.prepare('DELETE FROM memory_files WHERE path = ?').run(path);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// each word of the query becomes a quoted term, so text such as "c++" or "a:b" cannot break the fts5 syntax.
export function toMatchQuery(query: string): string | undefined {
  const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.length ? words.map((word) => `"${word}"`).join(' OR ') : undefined;
}

export function searchMemory(db: Db, query: string, limit: number): SearchHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  return db
    .prepare(
      `SELECT path, heading, text, startLine, endLine FROM memory_chunks WHERE memory_chunks MATCH ?
       ORDER BY bm25(memory_chunks), path DESC LIMIT ?`,
    )
    .all(match, limit)
    .map((row) => ({
      path: String(row.path),
      heading: String(row.heading),
      text: String(row.text),
      startLine: Number(row.startLine),
      endLine: Number(row.endLine),
    }));
}

// the path is relative to the memory folder. a path that leaves the folder gives undefined.
export function resolveMemoryPath(memoryDir: string, path: string): string | undefined {
  const root = resolve(memoryDir);
  const full = resolve(root, path);
  return full.startsWith(root + sep) ? full : undefined;
}
