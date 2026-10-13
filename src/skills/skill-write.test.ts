import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerSecret } from '../observability/redact.js';
import { createSkillWriteTool, renderSkill, skillVersion, skillWriteInput, writeSkillFile, type SkillWriteInput } from './skill-write.js';

const char = (point: number) => String.fromCodePoint(point);
const valid: SkillWriteInput = { name: 'calendar-booking', description: 'Book an event.', body: '1. Check the work calendar.', replaces: false, why: 'The owner corrected it.' };
const refused = (change: Partial<SkillWriteInput>) => !skillWriteInput.safeParse({ ...valid, ...change }).success;

function folder(files: Record<string, string> = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'okc-skill-write-')), 'skills');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), text);
  }
  return dir;
}

const ctx = { runId: 'r', sessionKey: 'workshop:r', timeZone: 'UTC', clock: () => new Date(), signal: new AbortController().signal };
async function write(dir: string, input: Partial<SkillWriteInput>) {
  const parsed = skillWriteInput.parse({ ...valid, ...input });
  return createSkillWriteTool({ skillsDir: dir }).run(parsed, ctx);
}

describe('skill_write input', () => {
  it('accepts a normal draft and an emoji with a joiner', () => {
    expect(refused({})).toBe(false);
    expect(refused({ body: `1. Say thanks ${char(0x1f469)}${char(0x200d)}${char(0x1f4bb)}${char(0xfe0f)}` })).toBe(false);
    expect(refused({ body: Array.from({ length: 80 }, () => 'x').join('\n') })).toBe(false);
    expect(refused({ body: 'x'.repeat(2500) })).toBe(false);
  });

  it('refuses a name that is a path or a windows device name', () => {
    for (const name of ['../x', 'con', 'NUL', 'com1', 'lpt9', 'Calendar', 'a--b', '-a', 'a'.repeat(65), '']) expect(refused({ name }), name).toBe(true);
    expect(refused({ name: 'console' })).toBe(false);
  });

  it('refuses a description of two lines and hidden characters in the body', () => {
    expect(refused({ description: 'one\ntwo' })).toBe(true);
    expect(refused({ description: 'x'.repeat(201) })).toBe(true);
    for (const point of [0x202e, 0x200b, 0x0d, 0x2028, 0xad, 0xfeff, 0x07]) expect(refused({ body: `step${char(point)}one` }), point.toString(16)).toBe(true);
    expect(refused({ description: `book${char(0x202e)}` })).toBe(true);
  });

  it('refuses a body over 2,500 characters or 80 lines', () => {
    expect(refused({ body: 'x'.repeat(2501) })).toBe(true);
    expect(refused({ body: Array.from({ length: 81 }, () => 'x').join('\n') })).toBe(true);
  });

  it('refuses a registered secret and a change without its base', () => {
    registerSecret('sk-skill-write-secret-42');
    expect(refused({ body: 'use the key sk-skill-write-secret-42' })).toBe(true);
    expect(refused({ description: 'key sk-skill-write-secret-42' })).toBe(true);
    expect(refused({ replaces: true })).toBe(true);
    expect(refused({ replaces: true, base: 'abc' })).toBe(true);
    expect(refused({ replaces: true, base: skillVersion('x') })).toBe(false);
  });
});

describe('renderSkill', () => {
  it('writes the frontmatter in code and keeps the extra fields of the owner on a change', () => {
    const base = '---\nname: old\ndescription: old text\nowner-note: keep short\n---\n\nold steps\n';
    expect(renderSkill({ ...valid, body: '---\nname: evil\n---\nsteps' }, base)).toBe(
      '---\nname: calendar-booking\ndescription: Book an event.\nowner-note: keep short\n---\n\n---\nname: evil\n---\nsteps\n',
    );
    expect(renderSkill(valid)).toBe('---\nname: calendar-booking\ndescription: Book an event.\n---\n\n1. Check the work calendar.\n');
  });
});

describe('the skill_write tool', () => {
  it('writes a new skill, and a second run of the same write says that it is already saved', async () => {
    const dir = folder();
    expect(await write(dir, {})).toEqual({ content: 'wrote the new skill calendar-booking' });
    expect(await write(dir, {})).toEqual({ content: 'the skill calendar-booking is already saved with this text' });
    expect(readFileSync(join(dir, 'calendar-booking', 'SKILL.md'), 'utf8')).toBe(renderSkill(valid));
  });

  it('refuses a new skill when a skill or a folder with the name exists in another case', async () => {
    const dir = folder({ 'Calendar-Booking': '---\nname: mine\ndescription: mine\n---\nmy steps' });
    expect((await write(dir, {})).content).toContain('exists now, so the new skill was not written');
    const named = folder({ other: '---\nname: Calendar-Booking\ndescription: mine\n---\nmy steps' });
    expect((await write(named, {})).isError).toBe(true);
    expect(readdirSync(named)).toEqual(['other']);
  });

  it('writes a change only on its base, keeps the extra fields, and puts the old text in the result', async () => {
    const old = '---\nname: calendar-booking\ndescription: old\nowner-note: keep short\n---\n\nold steps\n';
    const dir = folder({ calendar: old });
    const path = join(dir, 'calendar', 'SKILL.md');
    expect((await write(dir, { replaces: true, base: skillVersion('other text') })).content).toBe(
      'the skill calendar-booking changed after the draft, so the draft was not written. The file keeps the newer text.',
    );
    expect(readFileSync(path, 'utf8')).toBe(old);
    const change = { replaces: true, base: skillVersion(old), body: 'new steps' };
    expect((await write(dir, change)).content).toBe(`changed the skill calendar-booking. The old text was:\n${old}`);
    expect(readFileSync(path, 'utf8')).toBe('---\nname: calendar-booking\ndescription: Book an event.\nowner-note: keep short\n---\n\nnew steps\n');
    expect(await write(dir, change)).toEqual({ content: 'the skill calendar-booking is already saved with this text' });
    expect((await write(dir, { ...change, name: 'deleted-skill' })).content).toBe('the skill deleted-skill does not exist now, so the change was not written');
    expect(existsSync(join(dir, 'deleted-skill'))).toBe(false);
  });
});

describe('writeSkillFile', () => {
  it('refuses a path through a junction to a folder outside the skills folder', () => {
    const dir = folder();
    const outside = mkdtempSync(join(tmpdir(), 'okc-outside-'));
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, 'evil'), 'junction');
    expect(writeSkillFile(dir, join(dir, 'evil', 'SKILL.md'), 'x')).toBe('the path of the skill is outside the skills folder');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('keeps the old file and leaves no temporary file when the rename fails', () => {
    const dir = folder({ weekly: 'old text' });
    const path = join(dir, 'weekly', 'SKILL.md');
    const error = writeSkillFile(dir, path, 'new text', () => {
      throw new Error('EPERM: the file is locked');
    });
    expect(error).toBe('EPERM: the file is locked');
    expect(readFileSync(path, 'utf8')).toBe('old text');
    expect(readdirSync(join(dir, 'weekly'))).toEqual(['SKILL.md']);
  });
});
