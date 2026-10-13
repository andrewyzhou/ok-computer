import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { registerSecret } from './redact.js';

describe('logger', () => {
  it('writes redacted json lines to a daily file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'okc-logs-'));
    registerSecret('bot-token-value-xyz');
    const clock = () => new Date('2026-10-12T15:00:00Z');
    const logger = createLogger({ dir, consoleLevel: 'off', clock }).child({ runId: 'r1' });
    logger.info('started', { token: 'bot-token-value-xyz' });
    logger.error('failed', { err: new Error('boom') });

    const lines = readFileSync(join(dir, 'okc-2026-10-12.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ ts: '2026-10-12T15:00:00.000Z', level: 'info', msg: 'started', runId: 'r1', token: '[redacted]' });
    expect(lines[1].err.message).toBe('boom');
  });
});
