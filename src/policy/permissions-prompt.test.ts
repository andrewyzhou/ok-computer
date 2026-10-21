import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { DOMAINS } from './autonomy.js';
import { changeLevel } from './autonomy-store.js';
import { permissionsInstructions } from './permissions-prompt.js';

const open: Db[] = [];
function memoryDb(): Db {
  const db = openDb(':memory:');
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe('the permissions part of the prompt', () => {
  it('names every domain of the ladder with its level in plain words', () => {
    const text = permissionsInstructions(memoryDb());
    for (const domain of DOMAINS) expect(text).toContain(`- ${domain.label}: `);
    expect(text).toContain('- Purchases: get it ready, they approve it');
    expect(text).toContain('- Docs and notes: do it, then tell them');
  });

  it('follows a level that the owner changes', () => {
    const db = memoryDb();
    expect(permissionsInstructions(db)).toContain('- Mail drafts: do it, a second check looks first');
    changeLevel(db, { domain: 'mail_drafts', level: 'ask', actor: 'owner', via: 'dashboard' }, new Date('2026-10-20T09:00:00Z'));
    expect(permissionsInstructions(db)).toContain('- Mail drafts: get it ready, they approve it');
  });
});
