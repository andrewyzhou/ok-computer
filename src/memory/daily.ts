import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredEvent } from '../events/log.js';
import { headOf } from '../text.js';

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
    .map((line) => (line.length > EXCERPT_CHARS ? `${headOf(line, EXCERPT_CHARS)}...` : line).replace(/\s+/g, ' '));
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
  replaceInDailyNote(memoryDir, day, section, '', text);
}

// the last run of the old lines in the section changes to the new text. when the old lines are not there, the new
// text goes to the end of the section. an empty text only removes the old lines.
export function replaceInDailyNote(memoryDir: string, day: string, section: DailySection, old: string, text: string): void {
  const path = dailyNotePath(memoryDir, day);
  const { preamble, sections } = parseNote(existsSync(path) ? readFileSync(path, 'utf8') : `# ${day}\n`);
  const lines = text.trim() ? text.trim().split('\n') : [];
  const oldLines = old.trim() ? old.trim().split('\n') : [];

  let target = sections.find((s) => s.name === section);
  const kept = trimBlank(target?.lines ?? []);
  const at = lastRun(kept, oldLines);
  if (!lines.length && at === -1) return;
  if (!target) {
    target = { name: section, lines: [] };
    const rank = DAILY_SECTIONS.indexOf(section);
    const after = sections.findIndex((s) => {
      const other = DAILY_SECTIONS.indexOf(s.name as DailySection);
      return other > rank;
    });
    sections.splice(after === -1 ? sections.length : after, 0, target);
  }
  target.lines = at === -1 ? [...kept, ...lines] : [...kept.slice(0, at), ...lines, ...kept.slice(at + oldLines.length)];
  mkdirSync(join(memoryDir, 'daily'), { recursive: true });
  writeFileSync(path, serializeNote(preamble, sections));
}

function lastRun(lines: string[], run: string[]): number {
  if (!run.length) return -1;
  for (let start = lines.length - run.length; start >= 0; start--) {
    if (run.every((line, i) => lines[start + i] === line)) return start;
  }
  return -1;
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
