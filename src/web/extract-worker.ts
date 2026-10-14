import { parentPort, workerData } from 'node:worker_threads';
import { extractReadable } from './extract.js';

const { html, url } = workerData as { html: string; url: string };
parentPort!.postMessage(extractReadable(html, url));
