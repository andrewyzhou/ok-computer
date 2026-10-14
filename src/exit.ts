import type { Logger } from './observability/logger.js';
import { redact } from './observability/redact.js';

// process.exit soon after a network call can stop node on windows with a libuv assertion (UV_HANDLE_CLOSING) and a
// crash code. so the process ends by itself when the event loop is empty. the timer ends it when a handle stays open.
export function exitWhenIdle(code: number, fallbackMs = 5_000): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), fallbackMs).unref();
}

// the supervisor keeps the stderr of each start. the log file also gets the error when the logger exists.
export function exitOnFatal(err: unknown, logger?: Logger): never {
  if (logger) logger.error('fatal error', { err });
  else process.stderr.write(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)) + '\n');
  process.exit(1);
}

// without these handlers, node writes the error only to stderr, and the log file has no line about the stop.
export function exitOnUncaught(logger: () => Logger | undefined): void {
  process.on('uncaughtException', (err) => exitOnFatal(err, logger()));
  process.on('unhandledRejection', (err) => exitOnFatal(err, logger()));
}
