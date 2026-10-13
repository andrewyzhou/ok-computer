import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../events/log.js';
import { createToolRegistry } from '../tools/registry.js';
import { appendToDailyNote, dailyNotePath, sessionExcerpt } from './daily.js';
import { createMemoryTools } from './tools.js';

const DAY = '2026-10-12';
const dir = () => mkdtempSync(join(tmpdir(), 'okc-mem-'));
const read = (memoryDir: string) => readFileSync(dailyNotePath(memoryDir, DAY), 'utf8');

describe('daily notes', () => {
  it('adds text to the end of its section and keeps the sections in the fixed order', () => {
    const memoryDir = dir();
    appendToDailyNote(memoryDir, DAY, 'notes', 'The owner moved the gym to mornings.');
    appendToDailyNote(memoryDir, DAY, 'goals', '- finish essay');
    appendToDailyNote(memoryDir, DAY, 'notes', 'The owner likes tea.');
    appendToDailyNote(memoryDir, DAY, 'mood and energy', 'Tired after 22:00.');
    expect(read(memoryDir)).toBe(
      [
        `# ${DAY}`,
        '',
        '## goals',
        '',
        '- finish essay',
        '',
        '## notes',
        '',
        'The owner moved the gym to mornings.',
        'The owner likes tea.',
        '',
        '## mood and energy',
        '',
        'Tired after 22:00.',
        '',
        '',
      ].join('\n'),
    );
  });

  it('keeps a section that the owner added by hand', () => {
    const memoryDir = dir();
    appendToDailyNote(memoryDir, DAY, 'notes', 'first');
    writeFileSync(dailyNotePath(memoryDir, DAY), read(memoryDir) + '## travel\r\n\r\nflight at 09:10\r\n');
    appendToDailyNote(memoryDir, DAY, 'done', '- laundry');
    appendToDailyNote(memoryDir, DAY, 'mood and energy', 'good');
    expect(read(memoryDir)).toBe(
      `# ${DAY}\n\n## done\n\n- laundry\n\n## notes\n\nfirst\n\n## travel\n\nflight at 09:10\n\n## mood and energy\n\ngood\n\n`,
    );
  });

  it('writes through memory_write with notes as the default section and today as the default day', async () => {
    const memoryDir = dir();
    const registry = createToolRegistry(createMemoryTools({ memoryDir }));
    const ctx = {
      runId: 'r',
      sessionKey: 'main',
      timeZone: 'America/Los_Angeles',
      clock: () => new Date('2026-10-13T03:15:00Z'),
      signal: new AbortController().signal,
    };
    const out = await registry.run({ id: 't', name: 'memory_write', input: { text: 'Prefers short answers.' } }, ['memory_write'], ctx);
    expect(out.content).toBe(`saved to daily/${DAY}.md under ## notes`);
    expect(read(memoryDir)).toContain('## notes\n\nPrefers short answers.');
    const bad = await registry.run({ id: 't', name: 'memory_write', input: { text: 'x', section: 'other' } }, ['memory_write'], ctx);
    expect(bad.isError).toBe(true);
  });

  it('makes an excerpt from the last owner and assistant messages', () => {
    const event = (type: string, payload: object) => ({ type, payload }) as unknown as StoredEvent;
    const turn = (text: string) =>
      event('assistant_message', { provider: 'fake', model: 'm', content: [], text, toolCalls: [], stopReason: 'end_turn' });
    const events = [
      event('user_message', { text: 'plan my week', channel: 'cli', chatId: 'local' }),
      event('context', { text: '<context>...</context>' }),
      turn('Here is a plan.'),
      turn('NO_REPLY'),
    ];
    expect(sessionExcerpt(events, '21:40')).toBe(
      'Session closed with /new at 21:40. The last messages:\n- owner: plan my week\n- assistant: Here is a plan.',
    );
    expect(sessionExcerpt([], '21:40')).toBeUndefined();
  });
});
