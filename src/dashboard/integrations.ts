import type { Db } from '../db/index.js';
import { diffCatalogs, type CatalogSnapshot } from '../integrations/catalog.js';
import type { IntegrationStatus } from '../integrations/integrations.js';
import { toDecision, toMcpMessage, toToolCall } from './queries.js';
import type { CatalogVersion, IntegrationDetail, IntegrationSummary } from './types.js';

const DAY_MS = 24 * 60 * 60_000;

// the page shows the live state of this process next to the counts from the database. a second process, for example
// npm run chat, never connects, but its calls show in the counts too.
export function summaryOf(db: Db, status: IntegrationStatus, now: Date): IntegrationSummary {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const counts = db
    .prepare("SELECT COUNT(*) AS calls, SUM(isError) AS errors FROM tool_calls WHERE serverId = ? AND source = 'mcp' AND createdAt >= ?")
    .get(status.id, since);
  // the newest row by id reads one entry of the (serverId, id) index. MAX(createdAt) read every row of the server, and
  // with weeks of messages each load of the page held the event loop for more than half a second.
  const last = db.prepare('SELECT createdAt AS at FROM mcp_messages WHERE serverId = ? ORDER BY id DESC LIMIT 1').get(status.id);
  return {
    ...status,
    state: { ...status.state },
    calls24h: Number(counts?.calls ?? 0),
    errors24h: Number(counts?.errors ?? 0),
    lastMessageAt: last?.at === null || last?.at === undefined ? null : String(last.at),
  };
}

// the newest version comes first. each version has its change from the version before.
export function catalogVersions(db: Db, id: string, limit = 50): CatalogVersion[] {
  const rows = db
    .prepare(
      `SELECT c.hash, c.createdAt, s.tools FROM integration_catalogs c JOIN tool_catalog_snapshots s ON s.hash = c.hash
       WHERE c.integrationId = ? ORDER BY c.id DESC LIMIT ?`,
    )
    .all(id, limit + 1)
    .reverse();
  const snapshots = rows.map((row) => JSON.parse(String(row.tools)) as CatalogSnapshot);
  const versions = rows.map((row, i) => ({
    hash: String(row.hash),
    createdAt: String(row.createdAt),
    toolCount: snapshots[i]!.tools.length,
    diff: i ? diffCatalogs(snapshots[i - 1]!.tools, snapshots[i]!.tools) : null,
  }));
  // with more rows than the limit, the oldest row is only the base of the next diff.
  return (rows.length > limit ? versions.slice(1) : versions).reverse();
}

export function integrationDetail(db: Db, status: IntegrationStatus, now: Date): IntegrationDetail {
  const id = status.id;
  const messages = db.prepare('SELECT * FROM mcp_messages WHERE serverId = ? ORDER BY id DESC LIMIT 100').all(id).map(toMcpMessage);
  // the outcome word needs the decision and the approval, or a call that waits for the owner looks like it ran.
  const rows = db.prepare("SELECT * FROM tool_calls WHERE serverId = ? AND source = 'mcp' ORDER BY id DESC LIMIT 20").all(id);
  const decisions = new Map(
    rows
      .filter((row) => row.policyDecisionId !== null)
      .flatMap((row) => {
        const decision = db
          .prepare(
            `SELECT policy_decisions.*, approvals.status AS approvalStatus FROM policy_decisions
             LEFT JOIN approvals ON approvals.id = policy_decisions.approvalId WHERE policy_decisions.id = ?`,
          )
          .get(Number(row.policyDecisionId));
        return decision ? [[Number(decision.id), toDecision(decision)] as const] : [];
      }),
  );
  return { ...summaryOf(db, status, now), catalogs: catalogVersions(db, id), calls: rows.map((row) => toToolCall(row, decisions)), messages };
}
