import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { redactedJson } from './redact.js';

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];
type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export interface LoggerOptions {
  // the logger writes json lines to data/logs/okc-YYYY-MM-DD.log when dir is set.
  dir?: string;
  // the console gets lines on stderr, so the cli chat on stdout stays readable.
  consoleLevel?: Level | 'off';
  clock?: () => Date;
}

export function createLogger(options: LoggerOptions = {}, base: Fields = {}): Logger {
  const { dir, consoleLevel = 'info', clock = () => new Date() } = options;
  if (dir) mkdirSync(dir, { recursive: true });
  const consoleRank = consoleLevel === 'off' ? Infinity : LEVELS.indexOf(consoleLevel);

  const write = (level: Level, msg: string, fields: Fields = {}) => {
    const now = clock();
    const line = redactedJson({ ts: now.toISOString(), level, msg, ...base, ...serializable(fields) });
    if (dir) appendFileSync(join(dir, `okc-${now.toISOString().slice(0, 10)}.log`), line + '\n');
    if (LEVELS.indexOf(level) >= consoleRank) process.stderr.write(line + '\n');
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger(options, { ...base, ...fields }),
  };
}

// json.stringify writes an error as {}, so the logger keeps its message and stack.
function serializable(fields: Fields): Fields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) =>
      value instanceof Error ? [key, { name: value.name, message: value.message, stack: value.stack }] : [key, value],
    ),
  );
}

const KEEP_LOG_DAYS = 30;

// the daily files grow without a limit, so the app keeps only the files of the last 30 days.
export function pruneLogs(dir: string, now: Date): void {
  const oldest = new Date(now.getTime() - KEEP_LOG_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const name of readdirSync(dir)) {
    const day = /^okc-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)?.[1];
    if (day && day < oldest) rmSync(join(dir, name), { force: true });
  }
}

export const silentLogger: Logger = createLogger({ consoleLevel: 'off' });
