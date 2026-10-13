import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { nowTool } from './now.js';
import { createToolRegistry, defineTool, type ToolContext } from './registry.js';

const echo = defineTool({
  name: 'echo',
  description: 'Repeat the text.',
  input: z.object({ text: z.string() }),
  risk: 'read',
  async run({ text }) {
    if (text === 'boom') throw new Error('exploded');
    return { content: text };
  },
});

const ctx: ToolContext = {
  runId: 'r1',
  sessionKey: 'main',
  timeZone: 'America/Los_Angeles',
  clock: () => new Date('2026-10-13T03:15:00Z'),
  signal: new AbortController().signal,
};

const registry = createToolRegistry([nowTool, echo]);
const allowed = ['echo', 'now'];

describe('tool registry', () => {
  it('lists allowed tools sorted by name with json schema input', () => {
    expect(registry.specs(['now', 'echo'])).toEqual([
      {
        name: 'echo',
        description: 'Repeat the text.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      { name: 'now', description: expect.any(String), inputSchema: expect.objectContaining({ type: 'object' }) },
    ]);
    expect(registry.specs(['now']).map((s) => s.name)).toEqual(['now']);
  });

  it('runs a tool with valid input', async () => {
    expect(await registry.run({ id: '1', name: 'echo', input: { text: 'hi' } }, allowed, ctx)).toEqual({ content: 'hi' });
  });

  it('returns error results instead of throwing', async () => {
    const invalid = await registry.run({ id: '1', name: 'echo', input: { text: 5 } }, allowed, ctx);
    expect(invalid.isError).toBe(true);
    const failed = await registry.run({ id: '1', name: 'echo', input: { text: 'boom' } }, allowed, ctx);
    expect(failed).toEqual({ content: 'echo failed: exploded', isError: true });
  });

  it('treats a tool outside the allowlist as unknown', async () => {
    const result = await registry.run({ id: '1', name: 'echo', input: { text: 'hi' } }, ['now'], ctx);
    expect(result).toEqual({ content: 'unknown tool: echo', isError: true });
  });

  it('gives the time in the owner time zone', async () => {
    const result = await registry.run({ id: '1', name: 'now', input: {} }, allowed, ctx);
    expect(result.content).toBe('Monday, October 12, 2026 at 20:15 PDT (2026-10-13T03:15:00.000Z)');
  });
});
