import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { stripTags, type Extracted } from './extract.js';

// a hostile page can make the parser or readability slow in ways that no check before the parse finds. a page inside
// the depth and element caps took up to 14 s (a list of 19,700 items under 117 levels), and 5 mb of nested tags took
// 2 minutes. the work runs in a worker thread with a time and memory limit, so it never holds the event loop of the
// app, which also serves telegram and the scheduler.
export const EXTRACT_TIMEOUT_MS = 5_000;

const here = fileURLToPath(import.meta.url);
// the tests run the source, so the worker needs tsx to load typescript. the build runs plain javascript.
const source = here.endsWith('.ts');
const WORKER = here.replace(/extract-run\.(ts|js)$/, `extract-worker.$1`);

export function extractIsolated(html: string, url: string, timeoutMs = EXTRACT_TIMEOUT_MS): Promise<Extracted & { note?: string }> {
  return new Promise((resolve) => {
    let done = false;
    // the fallback is a pass over the page on the main thread, so it runs only when no result came. terminate() after
    // a result also sends exit.
    const finish = (value: () => Extracted & { note?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value());
    };
    const worker = new Worker(WORKER, {
      workerData: { html, url },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      ...(source ? { execArgv: ['--import', 'tsx'] } : {}),
    });
    const timer = setTimeout(() => finish(() => ({ ...stripTags(html), note: `the page took more than ${timeoutMs / 1000} s to read, so only its plain text is here` })), timeoutMs);
    worker.once('message', (value: Extracted) => finish(() => value));
    worker.once('error', (err) => finish(() => ({ ...stripTags(html), note: `the page could not be read as a document (${err.message}), so only its plain text is here` })));
    worker.once('exit', () => finish(() => ({ ...stripTags(html), note: 'the reader stopped, so only the plain text of the page is here' })));
  });
}
