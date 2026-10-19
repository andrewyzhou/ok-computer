import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEVELS, type Level } from '../observability/logger.js';
import type { Clock } from '../time.js';
import { notBuilt } from './params.js';
import type { LogLine } from './types.js';

// the logger starts a new file at each utc date.
export function logFile(dir: string, now: Date): string {
  return join(dir, `okc-${now.toISOString().slice(0, 10)}.log`);
}

export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

export function atLeast(line: LogLine, level: Level): boolean {
  return LEVELS.indexOf(line.level as Level) >= LEVELS.indexOf(level);
}

function parse(text: string): LogLine[] {
  return text.split('\n').flatMap((raw) => {
    if (!raw.trim()) return [];
    try {
      return [JSON.parse(raw) as LogLine];
    } catch {
      return [{ ts: '', level: 'info', msg: raw }];
    }
  });
}

export function readLogs(dir: string, now: Date, level: Level, limit: number): LogLine[] {
  const file = logFile(dir, now);
  if (!existsSync(file)) return [];
  return parse(readFileSync(file, 'utf8'))
    .filter((line) => atLeast(line, level))
    .slice(-limit);
}

export interface LogsInput {
  level: Level;
  // already clamped to 1 to 5000.
  limit: number;
  // phase 5 m1: a day in the time zone of the app, and a run id.
  day?: string;
  runId?: string;
}

// the lines of /api/logs. without a day it reads the file of today, as readLogs does.
export function readLogsFor(dir: string, now: Date, timeZone: string, input: LogsInput): LogLine[] {
  if (input.day !== undefined || input.runId !== undefined) return notBuilt(`the day and runId filters of the logs in ${timeZone}`);
  return readLogs(dir, now, input.level, input.limit);
}

// the tail gives the complete lines that the logger wrote since the last call. it starts at the end of the file, and
// it starts again at the top of a new file after the utc date changes.
export function createLogTail(dir: string, clock: Clock): () => LogLine[] {
  let file = logFile(dir, clock());
  let offset = existsSync(file) ? statSync(file).size : 0;
  return () => {
    const current = logFile(dir, clock());
    if (current !== file) {
      file = current;
      offset = 0;
    }
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    if (size <= offset) return [];
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
      closeSync(fd);
    }
    // a line that the logger is still writing has no newline yet. it waits for the next call.
    const end = buffer.lastIndexOf('\n');
    if (end === -1) return [];
    offset += end + 1;
    return parse(buffer.subarray(0, end).toString('utf8'));
  };
}
