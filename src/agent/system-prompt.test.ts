import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStablePrompt, buildVolatilePrompt, FILE_CAP, TOTAL_CAP } from './system-prompt.js';

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'okc-workspace-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('buildStablePrompt', () => {
  it('includes the base instructions and the persona files in a fixed order', () => {
    const dir = workspace({ 'USER.md': 'user facts', 'SOUL.md': 'soul text' });
    const prompt = buildStablePrompt({ workspaceDir: dir, timeZone: 'America/Los_Angeles' });
    expect(prompt).toContain('America/Los_Angeles');
    expect(prompt).toContain('NO_REPLY');
    expect(prompt).toContain('<untrusted');
    expect(prompt.indexOf('## SOUL.md')).toBeLessThan(prompt.indexOf('## USER.md'));
    expect(prompt).not.toContain('MEMORY.md');
  });

  it('adds MEMORY.md only when a memory path is given', () => {
    const dir = workspace({ 'MEMORY.md': 'long term fact' });
    const prompt = buildStablePrompt({ workspaceDir: dir, timeZone: 'UTC', memoryPath: join(dir, 'MEMORY.md') });
    expect(prompt).toContain('## MEMORY.md\n\nlong term fact');
  });

  it('cuts a long file and tells the model where the full file is', () => {
    const dir = workspace({ 'AGENTS.md': 'a'.repeat(FILE_CAP + 10) });
    const prompt = buildStablePrompt({ workspaceDir: dir, timeZone: 'UTC' });
    expect(prompt).toContain(`[this file was cut at ${FILE_CAP} characters. Read ${join(dir, 'AGENTS.md')}`);
    expect(prompt).not.toContain('a'.repeat(FILE_CAP + 1));
  });

  it('keeps the total of all files under the total cap', () => {
    const big = 'b'.repeat(FILE_CAP);
    const dir = workspace({ 'AGENTS.md': big, 'SOUL.md': big, 'IDENTITY.md': big, 'USER.md': big });
    const prompt = buildStablePrompt({ workspaceDir: dir, timeZone: 'UTC' });
    const fileChars = (prompt.match(/b{100,}/g) ?? []).reduce((sum, run) => sum + run.length, 0);
    expect(fileChars).toBe(TOTAL_CAP);
    expect(prompt).toContain(`## USER.md\n\n[this file was left out because the workspace files are over ${TOTAL_CAP}`);
  });

  it('gives the same text for the same files', () => {
    const dir = workspace({ 'USER.md': 'same' });
    const input = { workspaceDir: dir, timeZone: 'UTC' };
    expect(buildStablePrompt(input)).toBe(buildStablePrompt(input));
  });
});

describe('buildVolatilePrompt', () => {
  it('gives the local time and the channel', () => {
    const text = buildVolatilePrompt({ now: new Date('2026-10-13T03:15:00Z'), timeZone: 'America/Los_Angeles', channel: 'cli' });
    expect(text).toBe('<context>\ncurrent time: Monday, October 12, 2026 at 20:15 PDT\nchannel: cli\n</context>');
  });
});
