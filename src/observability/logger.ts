import { appendFileSync, mkdirSync } from 'node:fs';
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

export const silentLogger: Logger = createLogger({ consoleLevel: 'off' });
