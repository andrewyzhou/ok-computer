import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredEvent } from '../events/log.js';

export const DAILY_SECTIONS = ['goals', 'done', 'slipped and why', 'notes', 'mood and energy'] as const;
export type DailySection = (typeof DAILY_SECTIONS)[number];

export function dailyNotePath(memoryDir: string, day: string): string {
  return join(memoryDir, 'daily', `${day}.md`);
}

const EXCERPT_MESSAGES = 6;
const EXCERPT_CHARS = 300;

// the excerpt keeps a trace of a session that /new closes. old context then comes back through memory search.
export function sessionExcerpt(events: StoredEvent[], time: string): string | undefined {
  const lines = events
    .flatMap((event) => {
      if (event.type === 'user_message') return [`- owner: ${event.payload.text}`];
      if (event.type === 'assistant_message' && event.payload.text.trim() && event.payload.text.trim() !== 'NO_REPLY') {
        return [`- assistant: ${event.payload.text}`];
      }
      return [];
    })
    .slice(-EXCERPT_MESSAGES)
    .map((line) => (line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}...` : line).replace(/\s+/g, ' '));
  if (!lines.length) return undefined;
  return [`Session closed with /new at ${time}. The last messages:`, ...lines].join('\n');
}

interface Section {
  name: string;
  lines: string[];
}

// the text goes to the end of its section. a missing section goes in the fixed order, so every note has the same
// layout. sections that the owner adds by hand stay where they are.
export function appendToDailyNote(memoryDir: string, day: string, section: DailySection, text: string): void {
  const path = dailyNotePath(memoryDir, day);
  mkdirSync(join(memoryDir, 'daily'), { recursive: true });
  const { preamble, sections } = parseNote(existsSync(path) ? readFileSync(path, 'utf8') : `# ${day}\n`);

  let target = sections.find((s) => s.name === section);
  if (!target) {
    target = { name: section, lines: [] };
    const rank = DAILY_SECTIONS.indexOf(section);
    const after = sections.findIndex((s) => {
      const other = DAILY_SECTIONS.indexOf(s.name as DailySection);
      return other > rank;
    });
    sections.splice(after === -1 ? sections.length : after, 0, target);
  }
  target.lines = [...trimBlank(target.lines), ...text.trim().split('\n')];
  writeFileSync(path, serializeNote(preamble, sections));
}

function parseNote(text: string): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) sections.push({ name: heading[1]!.trim(), lines: [] });
    else if (sections.length) sections.at(-1)!.lines.push(line);
    else preamble.push(line);
  }
  return { preamble, sections };
}

function serializeNote(preamble: string[], sections: Section[]): string {
  const parts = [trimBlank(preamble).join('\n'), ...sections.map((s) => `## ${s.name}\n\n${trimBlank(s.lines).join('\n')}`)];
  return parts.join('\n\n') + '\n\n';
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start++;
  while (end > start && !lines[end - 1]!.trim()) end--;
  return lines.slice(start, end);
}
