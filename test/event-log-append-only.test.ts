import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = [
  /\bUPDATE\s+events\b/i,
  /\bDELETE\s+FROM\s+events\b/i,
  /\bREPLACE\s+INTO\s+events\b/i,
  /\bDROP\s+TABLE\s+(IF\s+EXISTS\s+)?events\b/i,
  /\bDROP\s+TRIGGER\s+(IF\s+EXISTS\s+)?events_no_/i,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|sql)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('event log source', () => {
  it('has no code path that changes or removes events', () => {
    const violations = sourceFiles('src').flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return FORBIDDEN.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`);
    });
    expect(violations).toEqual([]);
  });
});
