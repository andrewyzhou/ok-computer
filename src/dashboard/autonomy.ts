import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { DOMAINS, isDomain, LEVEL_TEXT, levelsUpTo, type DomainSpec } from '../policy/autonomy.js';
import { AutonomyError, changeLevel, HISTORY_LIMIT, listChanges, NOTE_LIMIT, storedLevels, type StoredLevel } from '../policy/autonomy-store.js';
import { glob, type Rule } from '../policy/policy.js';
import { errorText } from '../tools/registry.js';
import type { AutonomyDomainView, AutonomyHistoryPage, AutonomyPage, AutonomySetResponse } from './autonomy-types.js';
import { readBody } from './http.js';
import { idOf, limitOf } from './params.js';
import type { DashboardDeps } from './server.js';

const DEFAULT_PAGE = 50;
const LEVEL = z.enum(['ask', 'review', 'auto']);
const setBody = z.object({ level: LEVEL, from: LEVEL, note: z.string().max(NOTE_LIMIT).optional() }).strict();

// the status of each refusal of the store. a level that is not one of the three is a bad body, a domain that the store
// does not know names no row, and every other refusal is a level that the rules do not allow from the current one.
const STATUS = {
  bad_level: 400,
  unknown_domain: 404,
  fixed: 409,
  above_max: 409,
  stale: 409,
  not_lower: 409,
} as const;

// the allow rule of the owner that lets the calls of a domain run without the reviewer. at the default level the policy
// engine decides as it did before the ladder, so an allow rule on a tool of a domain whose default is review lets the
// call run with no check. a raised level decides over an allow rule, a lowered one makes the owner approve, and the
// tools of a domain whose default is ask always ask the owner, so no rule overrides those. the match looks only at the
// tool pattern: a rule with a session or args pattern can still let some of the calls through.
function overriddenBy(spec: DomainSpec, stored: StoredLevel, rules: readonly Rule[]): string | null {
  if (spec.defaultLevel === 'ask' || stored.level !== spec.defaultLevel) return null;
  const rule = rules.findLast((each) => each.effect === 'allow' && spec.tools.some((tool) => glob(each.tool, tool)));
  return rule?.id ?? null;
}

// the view of one domain for the page. a fixed domain offers only ask, so the page shows no control for it.
function viewOf(spec: DomainSpec, stored: StoredLevel, rules: readonly Rule[]): AutonomyDomainView {
  const fixed = spec.fixedReason !== null;
  return {
    id: spec.id,
    label: spec.label,
    explanation: spec.explanation,
    tools: [...spec.tools],
    level: stored.level,
    defaultLevel: spec.defaultLevel,
    maxLevel: spec.maxLevel,
    levels: fixed ? ['ask'] : levelsUpTo(spec.maxLevel),
    fixed,
    fixedReason: spec.fixedReason,
    updatedAt: stored.updatedAt,
    changeId: stored.changeId,
    overriddenBy: overriddenBy(spec, stored, rules),
  };
}

// one page of the history. it reads one row more than the limit, so before is null exactly when no older row exists.
// the store gives at most HISTORY_LIMIT rows in one read, so a page of that size asks for the next older row apart.
function historyPage(db: Db, query: { domain?: DomainSpec['id']; before?: number; limit: number }): AutonomyHistoryPage {
  const extra = query.limit < HISTORY_LIMIT;
  const rows = listChanges(db, { ...query, limit: extra ? query.limit + 1 : query.limit });
  const changes = rows.slice(0, query.limit);
  const last = changes[changes.length - 1];
  const more = extra ? rows.length > query.limit : last !== undefined && rows.length === query.limit && listChanges(db, { ...query, before: last.id, limit: 1 }).length > 0;
  return { changes, before: more && last ? last.id : null };
}

// phase 6 track T6 owns this module. it mounts GET /api/autonomy, GET /api/autonomy/history and
// POST /api/autonomy/:domain, with the shapes of autonomy-types.ts. server.ts calls it after the sign-in check, so each
// route is behind the dashboard auth, and the post is the only way to raise a level. docs/API.md gives the errors.
export function mountAutonomy(server: Hono, deps: DashboardDeps): void {
  const { db, clock, logger } = deps;
  const rules = () => deps.app.rules;
  // a damaged row is an error that the page shows, not a crash of the request.
  const failed = (c: Context, err: unknown) => c.json({ error: errorText(err) }, 500);

  server.get('/api/autonomy', (c) => {
    try {
      const stored = storedLevels(db);
      const page = historyPage(db, { limit: DEFAULT_PAGE });
      return c.json({
        domains: DOMAINS.map((spec) => viewOf(spec, stored[spec.id], rules())),
        levelText: LEVEL_TEXT,
        history: page.changes,
        before: page.before,
      } satisfies AutonomyPage);
    } catch (err) {
      return failed(c, err);
    }
  });

  server.get('/api/autonomy/history', (c) => {
    const query = c.req.query();
    const domain = query.domain === undefined || query.domain === '' ? undefined : query.domain;
    if (domain !== undefined && !isDomain(domain)) return c.json({ error: `domain must be one of ${DOMAINS.map((spec) => spec.id).join(', ')}` }, 400);
    let before: number | undefined;
    if (query.before !== undefined && query.before !== '') {
      before = idOf(query.before);
      if (before === undefined) return c.json({ error: 'before must be the id of a change' }, 400);
    }
    const limit = limitOf(query.limit, HISTORY_LIMIT, DEFAULT_PAGE);
    try {
      return c.json(historyPage(db, { ...(domain ? { domain } : {}), ...(before ? { before } : {}), limit }) satisfies AutonomyHistoryPage);
    } catch (err) {
      return failed(c, err);
    }
  });

  // the owner sets the level of one domain. from is the level that the page showed, so a change made in another tab
  // in the meantime gives 409 and not a silent overwrite. the store refuses a fixed domain and a level above the most.
  server.post('/api/autonomy/:domain', async (c) => {
    const domain = c.req.param('domain');
    if (!isDomain(domain)) return c.json({ error: 'autonomy domain not found' }, 404);
    const body = await readBody(c, setBody);
    if (!body) return c.json({ error: 'send {level, from}' }, 400);
    try {
      const change = changeLevel(
        db,
        { domain, level: body.level, actor: 'owner', via: 'dashboard', expected: body.from, ...(body.note !== undefined ? { note: body.note } : {}) },
        clock(),
      );
      if (change) logger.info('autonomy level changed', { domain, from: change.fromLevel, to: change.toLevel });
      const spec = DOMAINS.find((each) => each.id === domain)!;
      return c.json({ domain: viewOf(spec, storedLevels(db)[domain], rules()), change } satisfies AutonomySetResponse);
    } catch (err) {
      if (err instanceof AutonomyError) return c.json({ error: err.message }, STATUS[err.code]);
      return failed(c, err);
    }
  });
}
