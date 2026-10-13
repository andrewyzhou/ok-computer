import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/index.js';
import { silentLogger } from '../observability/logger.js';
import { BUILTIN_RULES, type Rule } from '../policy/policy.js';
import { addRule, alwaysButtonData, createAlwaysAllow, parseAlwaysButton } from './always.js';
import { createApproval, getApproval, resolveApproval } from './store.js';

const rule = { tool: 'notes__add_note', effect: 'allow' as const, note: 'from approval #1' };
const fresh = () => join(mkdtempSync(join(tmpdir(), 'okc-always-')), 'okc.policy.json');

describe('addRule', () => {
  it('creates the file, keeps the rules of the owner, and gives the new list with ids', () => {
    const path = fresh();
    const first = addRule(path, rule);
    expect(first.ok && first.value.at(-1)).toEqual({ ...rule, id: `${path}#1` });
    writeFileSync(path, JSON.stringify({ rules: [{ tool: 'x', effect: 'deny', note: 'mine' }, rule] }));
    const second = addRule(path, { ...rule, tool: 'other' });
    expect(second.ok && second.value.filter((each) => each.id.startsWith(path)).map((each) => each.tool)).toEqual(['x', 'notes__add_note', 'other']);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('does not add a rule that the file already has, but adds a narrower one', () => {
    const path = fresh();
    writeFileSync(path, JSON.stringify({ rules: [{ tool: 'Notes__Add_Note', effect: 'allow' }] }));
    const same = addRule(path, rule);
    expect(same.ok && same.value.filter((each) => each.id.startsWith(path))).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).rules).toHaveLength(1);

    writeFileSync(path, JSON.stringify({ rules: [{ tool: 'notes__add_note', effect: 'allow', session: 'auto:*' }] }));
    expect(addRule(path, rule).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).rules).toHaveLength(2);
  });

  it('changes nothing when the file is broken or the result would be invalid', () => {
    const broken = fresh();
    writeFileSync(broken, '{ not json');
    expect(addRule(broken, rule)).toMatchObject({ ok: false, error: expect.stringContaining('is not valid json') });
    expect(readFileSync(broken, 'utf8')).toBe('{ not json');

    // the owner added a key that the loader refuses. the old file stays, and the error names it.
    const strict = fresh();
    writeFileSync(strict, '{"rules": [], "extra": 1}');
    const refused = addRule(strict, rule);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining(`${strict} is invalid`) });
    expect(readFileSync(strict, 'utf8')).toBe('{"rules": [], "extra": 1}');
    expect(existsSync(`${strict}.tmp`)).toBe(false);

    const missing = fresh();
    expect(addRule(missing, { ...rule, tool: '' }).ok).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });
});

describe('always allow buttons', () => {
  it('reads only its own buttons, with the expiry of the confirmation', () => {
    const expires = new Date('2026-10-13T03:10:00Z');
    expect(parseAlwaysButton(alwaysButtonData(3))).toEqual({ id: 3 });
    expect(parseAlwaysButton(alwaysButtonData(3, expires))).toEqual({ id: 3, expires });
    expect(Buffer.byteLength(alwaysButtonData(999_999_999, expires))).toBeLessThanOrEqual(47);
    expect(parseAlwaysButton('approval:3:always-yes')).toBeUndefined();
    expect(parseAlwaysButton('approval:3:approve')).toBeUndefined();
    expect(parseAlwaysButton('approval:3:always-yes:zz-please')).toBeUndefined();
  });
});

describe('createAlwaysAllow', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', 'x')").run();
  const now = new Date('2026-10-13T03:00:00Z');
  const approve = async (id: number) => (resolveApproval(db, id, 'approve', 'button', now).ok ? 'Approved.' : 'Not pending.');

  function setup(resolve: (id: number) => Promise<string> = approve) {
    const path = fresh();
    const rules: Rule[] = [...BUILTIN_RULES];
    const spy = vi.fn(resolve);
    const always = createAlwaysAllow({ db, clock: () => now, logger: silentLogger, timeZone: 'UTC', policyPath: path, rules, resolve: spy });
    const { id } = createApproval(db, { runId: 'r1', toolName: 'notes__add_note', input: {}, summary: 's' }, now);
    const yes = parseAlwaysButton(always.confirm(id).buttons![0]![0]!.data)!;
    return { path, rules, always, id, expires: yes.expires!, resolve: spy };
  }

  it('gives the yes button an expiry 10 minutes ahead, and refuses an expired yes', async () => {
    const { path, always, id, expires, resolve } = setup();
    expect(expires).toEqual(new Date('2026-10-13T03:10:00Z'));
    expect(await always.apply(id, new Date(now.getTime() - 1000))).toMatch(/^That confirmation expired/);
    expect(existsSync(path)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(getApproval(db, id)!.status).toBe('pending');
  });

  it('adds the rule, then approves; a second yes adds and runs nothing', async () => {
    const { path, rules, always, id, expires, resolve } = setup();
    expect(await always.apply(id, expires)).toBe('notes__add_note is now always allowed.\nApproved.');
    expect(rules.at(-1)).toMatchObject({ tool: 'notes__add_note', effect: 'allow', id: `${path}#1` });
    expect(await always.apply(id, expires)).toBe(`Approval #${id} is already approved.`);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).rules).toHaveLength(1);
  });

  it('leaves the approval pending with the rule in place when the approval fails after the write', async () => {
    const { path, always, id, expires } = setup(async () => {
      throw new Error('the database is locked');
    });
    await expect(always.apply(id, expires)).rejects.toThrow('the database is locked');
    expect(JSON.parse(readFileSync(path, 'utf8')).rules).toEqual([expect.objectContaining({ tool: 'notes__add_note', effect: 'allow' })]);
    expect(getApproval(db, id)!.status).toBe('pending');
  });
});
