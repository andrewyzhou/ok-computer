import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function dailyNotePath(memoryDir: string, day: string): string {
  return join(memoryDir, 'daily', `${day}.md`);
}

export function appendDailyNote(memoryDir: string, day: string, text: string): void {
  const path = dailyNotePath(memoryDir, day);
  mkdirSync(join(memoryDir, 'daily'), { recursive: true });
  const header = existsSync(path) ? '' : `# ${day}\n\n`;
  appendFileSync(path, `${header}${text.trim()}\n\n`);
}
