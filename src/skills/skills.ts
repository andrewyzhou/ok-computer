import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, type Tool } from '../tools/registry.js';

export interface Skill {
  name: string;
  description: string;
  path: string;
}

function frontmatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const fields: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const field = /^(\w+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}

// the app reads the skills folder again for each prompt and each skill_read call. a changed file is then used at once.
// a skill without a name or a description is left out, because the model cannot choose it.
export function loadSkills(dir: string): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, 'SKILL.md'))
    .filter((path) => existsSync(path))
    .flatMap((path) => {
      const { name, description } = frontmatter(readFileSync(path, 'utf8'));
      return name && description ? [{ name, description, path }] : [];
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function skillsIndex(skills: Skill[]): string {
  if (!skills.length) return '';
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return `# Skills\n\nA skill is a procedure for one type of task. When a task matches a skill, read the skill with skill_read before you start.\n\n${lines.join('\n')}`;
}

export function createSkillTools(deps: { skillsDir: string }): Tool[] {
  const read = defineTool({
    name: 'skill_read',
    description: 'Read the full instructions of a skill from the skills list by its name.',
    input: z.object({ name: z.string().min(1) }),
    risk: 'read',
    async run({ name }) {
      // the tool finds the file by the skill name, not by a path, so it cannot read other files.
      const skill = loadSkills(deps.skillsDir).find((candidate) => candidate.name === name);
      if (!skill) return { content: `no skill has the name ${name}`, isError: true };
      return { content: readFileSync(skill.path, 'utf8') };
    },
  });
  return [read];
}
