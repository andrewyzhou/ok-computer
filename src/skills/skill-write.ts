import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { redact } from '../observability/redact.js';
import { defineTool, type Tool } from '../tools/registry.js';
import { frontmatter, loadSkills } from './skills.js';

// the card shows the full body with a bar on each line, and one telegram message holds 4,096 characters. a body at
// these limits and the other fields at their limits give a card under that size.
export const BODY_LIMIT = 2500;
export const BODY_LINES = 80;
const DESCRIPTION_LIMIT = 200;

// the version is the start of the sha-256 of the file. the review input shows it, and a change names it as its base.
export const skillVersion = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

// the name is also the folder name, so it must be a safe folder name on windows and linux. lower case only, because
// windows does not tell "Foo" from "foo".
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
// a control character other than a line break or a tab, a format character, or another character that a reader need
// not show can hide text from the owner. tag characters can spell a full instruction that the model reads and the
// owner does not see. a skill has no use for them, so the draft is refused. this set holds every character that the
// card shows as a \u code, so a draft that passes gives a card without such codes, and the card keeps its size limit.
// one variation selector after an emoji and a joiner between two emoji parts stay, because they make emoji.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;
const EMOJI = /\p{Emoji}$/u;
const EMOJI_PART = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f]$/u;
const EMOJI_NEXT = /^\p{Extended_Pictographic}/u;

function hiddenIn(text: string): string | undefined {
  for (const found of text.matchAll(HIDDEN)) {
    const char = found[0];
    const before = text.slice(0, found.index);
    if (char === '\n' || char === '\t') continue;
    if ((char === '\ufe0e' || char === '\ufe0f') && EMOJI.test(before)) continue;
    if (char === '\u200d' && EMOJI_PART.test(before) && EMOJI_NEXT.test(text.slice(found.index + 1))) continue;
    return `it has a hidden or control character (U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}) at position ${found.index}`;
  }
  return undefined;
}

// a skill has no reason to hold a secret. the card shows a secret as [redacted], and the file would get the real value.
const noSecret = (text: string) => redact(text) === text;

const text = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .superRefine((value, ctx) => {
      const hidden = hiddenIn(value);
      if (hidden) ctx.addIssue({ code: 'custom', message: `${hidden}. Remove it.` });
      if (!noSecret(value)) ctx.addIssue({ code: 'custom', message: 'it holds a secret. A skill must not hold a secret.' });
    });

export const skillWriteInput = z
  .object({
    name: z
      .string()
      .max(64)
      .regex(NAME, 'use lower-case words with single hyphens, for example "expense-report"')
      .refine((name) => !DEVICE.test(name), 'this is a device name on windows. Choose another name.'),
    description: text(DESCRIPTION_LIMIT).refine((value) => !value.includes('\n'), 'the description is one line'),
    body: text(BODY_LIMIT).refine((value) => value.split('\n').length <= BODY_LINES, `the body has at most ${BODY_LINES} lines`),
    replaces: z.boolean(),
    base: z.string().regex(/^[0-9a-f]{12}$/).optional(),
    why: z.string().min(1).max(300),
  })
  .refine((input) => !input.replaces || input.base !== undefined, { message: 'a change needs base: the version of the skill from the review input', path: ['base'] })
  // the loader trims a field and removes quotes around it, and it leaves out a skill without a description. so a
  // description that the loader reads in a different form is refused before the owner approves a skill that the app
  // cannot load.
  .refine(
    (input) => {
      const read = frontmatter(renderSkill({ ...input, body: 'x' }));
      return read.name === input.name && read.description === input.description.trim() && read.description !== '';
    },
    { message: 'the description must have text and must not start and end with the same quote mark', path: ['description'] },
  );

export type SkillWriteInput = z.infer<typeof skillWriteInput>;

// code writes the frontmatter, so a body cannot replace it. a change keeps every field other than name and
// description, because the owner can add a field by hand.
export function renderSkill(input: Pick<SkillWriteInput, 'name' | 'description' | 'body'>, base?: string): string {
  const kept = (base === undefined ? '' : (/^---\r?\n([\s\S]*?)\r?\n---/.exec(base)?.[1] ?? ''))
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^(name|description):/.test(line));
  return ['---', `name: ${input.name}`, `description: ${input.description.trim()}`, ...kept, '---', '', input.body.trim(), ''].join('\n');
}

// a path outside the skills folder is refused, also through a junction that was made after the draft. the check
// follows links in the part of the path that exists.
function inside(dir: string, path: string): boolean {
  const root = realpathSync(dir);
  let existing = path;
  while (!existsSync(existing)) existing = dirname(existing);
  const rel = relative(root, realpathSync(existing));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export type Rename = (from: string, to: string) => void;

// the write goes to a temporary file in the same folder and a rename puts it in place, so the loader never reads half
// a skill. a failed write removes the temporary file and keeps the old file. it also removes the folder of a new
// skill, because an empty folder blocks the next write of that name.
export function writeSkillFile(dir: string, path: string, content: string, rename: Rename = renameSync): string | undefined {
  mkdirSync(dir, { recursive: true });
  if (!inside(dir, path)) return 'the path of the skill is outside the skills folder';
  const temporary = `${path}.${randomUUID()}.tmp`;
  const folder = dirname(path);
  const made = !existsSync(folder);
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(temporary, content, 'utf8');
    rename(temporary, path);
    return undefined;
  } catch (err) {
    rmSync(temporary, { force: true });
    if (made) {
      try {
        rmdirSync(folder);
      } catch {
        // the folder is not empty, so another writer uses it now. it stays.
      }
    }
    return err instanceof Error ? err.message : String(err);
  }
}

// a process that stopped in writeSkillFile can leave the folder of a new skill with only its temporary files. such a
// folder holds no skill, so a new skill can use it. the temporary files are removed first.
const LEFTOVER = /^SKILL\.md\..+\.tmp$/;
function clearLeftover(folder: string): boolean {
  let files: string[];
  try {
    files = readdirSync(folder);
  } catch {
    return false;
  }
  if (!files.every((file) => LEFTOVER.test(file))) return false;
  for (const file of files) rmSync(join(folder, file), { force: true });
  return true;
}

const failed = (content: string) => ({ content, isError: true });

// the tool always needs the owner's approval, so it runs only after the owner pressed Approve on the full text. it is
// the only code that writes to the skills folder. each check reads the folder when the tool runs, because the owner
// can change it while the draft waits.
export function createSkillWriteTool(deps: { skillsDir: string }): Tool {
  const { skillsDir } = deps;
  return defineTool<SkillWriteInput>({
    name: 'skill_write',
    description: `Propose a new skill, or a new text of a skill from the skills list. The owner reads the full text and must approve it before the tool writes it. name is the skill name in lower case with hyphens. description is one line that says when to use the skill. body is the full instructions, at most ${BODY_LIMIT} characters and ${BODY_LINES} lines, without frontmatter. replaces is true only to change a skill that exists, and then base is its version from the review input. why says which task showed the need, and for a change what changes, in one or two sentences.`,
    input: skillWriteInput,
    risk: 'write',
    needsApproval: true,
    // the owner approves instructions that every later run can follow, so the card must show all of them. the
    // description goes into the skills list of every prompt, so the card shows it in full too.
    fullFields: ['description', 'body'],
    taintNote: 'Careful: the task read untrusted content. A skill guides later runs, so check that it has no instruction that you did not give.',
    async run(input) {
      const skills = loadSkills(skillsDir);
      const existing = skills.find((skill) => skill.name === input.name);
      if (input.replaces) {
        if (!existing) return failed(`the skill ${input.name} does not exist now, so the change was not written`);
        const current = readFileSync(existing.path, 'utf8');
        const content = renderSkill(input, current);
        // an approved write can run again after a crash. the file then has the new text already.
        if (current === content) return { content: `the skill ${input.name} is already saved with this text` };
        if (skillVersion(current) !== input.base) {
          return failed(`the skill ${input.name} changed after the draft, so the draft was not written. The file keeps the newer text.`);
        }
        const error = writeSkillFile(skillsDir, existing.path, content);
        if (error) return failed(`the change of ${input.name} was not written: ${error}`);
        // the old text goes into the trace, so the owner can get it back from the dashboard.
        return { content: `changed the skill ${input.name}. The old text was:\n${current}` };
      }
      const path = join(skillsDir, input.name, 'SKILL.md');
      const content = renderSkill(input);
      if (existsSync(path) && readFileSync(path, 'utf8') === content) return { content: `the skill ${input.name} is already saved with this text` };
      // a new skill never replaces a skill or a folder that the owner made while the draft waited. windows does not
      // tell the case of a name apart, so the check ignores case.
      const taken = (other: string) => other.toLowerCase() === input.name;
      const folders = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
      if (skills.some((skill) => taken(skill.name)) || folders.some((other) => taken(other) && !clearLeftover(join(skillsDir, other)))) {
        return failed(`a skill or a folder with the name ${input.name} exists now, so the new skill was not written`);
      }
      const error = writeSkillFile(skillsDir, path, content);
      if (error) return failed(`the new skill ${input.name} was not written: ${error}`);
      return { content: `wrote the new skill ${input.name}` };
    },
  });
}
