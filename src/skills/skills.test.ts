import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../tools/registry.js';
import { createSkillTools, loadSkills, skillsIndex } from './skills.js';

function skillsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'okc-skills-'));
  for (const [folder, text] of Object.entries(files)) {
    mkdirSync(join(dir, folder));
    writeFileSync(join(dir, folder, 'SKILL.md'), text);
  }
  return dir;
}

const weekly = '---\nname: weekly-review\ndescription: "Review the week with the owner."\n---\n\n1. List the goals.';

describe('skills', () => {
  it('lists the skills with a name and a description in name order', () => {
    const dir = skillsDir({
      weekly,
      trip: '---\r\nname: trip-plan\r\ndescription: Plan a trip.\r\n---\r\nsteps',
      broken: '---\nname: no-description\n---\n',
      plain: 'no frontmatter',
    });
    expect(loadSkills(dir).map((skill) => skill.name)).toEqual(['trip-plan', 'weekly-review']);
    expect(skillsIndex(loadSkills(dir))).toContain('- weekly-review: Review the week with the owner.');
    expect(skillsIndex([])).toBe('');
    expect(loadSkills(join(dir, 'missing'))).toEqual([]);
  });

  it('reads a skill by its name and refuses an unknown name', async () => {
    const dir = skillsDir({ weekly });
    const registry = createToolRegistry(createSkillTools({ skillsDir: dir }));
    const ctx = { runId: 'r', sessionKey: 'main', timeZone: 'UTC', clock: () => new Date(), signal: new AbortController().signal };
    const read = (name: string) => registry.run({ id: 't', name: 'skill_read', input: { name } }, ['skill_read'], ctx);
    expect((await read('weekly-review')).content).toBe(weekly);
    expect(await read('../USER.md')).toEqual({ content: 'no skill has the name ../USER.md', isError: true });
  });
});
