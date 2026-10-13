import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import type { Risk } from '../policy/policy.js';
import { headOf } from '../text.js';
import type { Clock } from '../time.js';
import type { IntegrationEntry } from './config.js';
import type { McpTool } from './mcp.js';
import { toolName } from './names.js';
import { createValidatorSet, prepareSchema, type Validate } from './schema-guard.js';

// a description is text of the server. the design allows 1 kb for each.
export const DESCRIPTION_LIMIT = 1_024;

export interface CatalogTool {
  name: string;
  integrationId: string;
  mcpName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
}

// the stored form of one catalog version. risk and visibility are not stored: they come from the config at each read,
// so a change of okc.integrations.json applies to a stored catalog too.
export interface CatalogSnapshot {
  integrationId: string;
  tools: CatalogTool[];
  // tools that the config allows but the catalog left out, with the reason. the dashboard shows them.
  rejected: Array<{ mcpName: string; reason: string }>;
}

export interface Catalog {
  snapshot: CatalogSnapshot;
  hash: string;
  // stored means that the catalog came from the database at the start, before the server answered.
  stored: boolean;
  validators: Map<string, Validate>;
  // the hash of the snapshot before the compile. an equal list from the server keeps this catalog.
  source?: string;
}

export function riskOf(entry: IntegrationEntry, tool: CatalogTool): Risk {
  // a hint of the server never makes a tool read. the config decides, and the default asks for a review at least.
  return entry.risk[tool.mcpName] ?? (tool.readOnlyHint ? 'write' : 'external');
}

// the server's list goes through the allow list of the config first. tools outside it never reach the model.
export function buildSnapshot(entry: IntegrationEntry, listed: McpTool[]): CatalogSnapshot {
  const tools: CatalogTool[] = [];
  const rejected: CatalogSnapshot['rejected'] = [];
  const allowed = new Set(entry.tools.allow);
  const seen = new Map<string, string>();
  for (const tool of listed) {
    if (!allowed.has(tool.name)) continue;
    allowed.delete(tool.name);
    const name = toolName(entry.id, tool.name);
    const other = seen.get(name);
    if (other !== undefined) {
      rejected.push({ mcpName: tool.name, reason: `its name ${name} is the same as the name of ${other}` });
      continue;
    }
    seen.set(name, tool.name);
    const prepared = prepareSchema(tool.inputSchema);
    if (!prepared.ok) {
      rejected.push({ mcpName: tool.name, reason: prepared.reason });
      continue;
    }
    tools.push({
      name,
      integrationId: entry.id,
      mcpName: tool.name,
      description: headOf(typeof tool.description === 'string' ? tool.description : '', DESCRIPTION_LIMIT),
      inputSchema: prepared.schema,
      readOnlyHint: tool.annotations?.readOnlyHint === true,
    });
  }
  for (const missing of allowed) rejected.push({ mcpName: missing, reason: 'the server does not offer this tool' });
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { integrationId: entry.id, tools, rejected };
}

// compile turns a snapshot into a catalog. a schema that ajv cannot compile moves the tool to the rejected list.
function compile(snapshot: CatalogSnapshot, stored: boolean, logger: Logger): Catalog {
  const validatorFor = createValidatorSet();
  const validators = new Map<string, Validate>();
  const tools: CatalogTool[] = [];
  const rejected = [...snapshot.rejected];
  for (const tool of snapshot.tools) {
    try {
      validators.set(tool.name, validatorFor(tool.inputSchema));
      tools.push(tool);
    } catch (err) {
      logger.warn('mcp tool schema does not compile', { integration: snapshot.integrationId, tool: tool.mcpName, err });
      rejected.push({ mcpName: tool.mcpName, reason: `the input schema does not compile: ${(err as Error).message}` });
    }
  }
  const final = { ...snapshot, tools, rejected };
  return { snapshot: final, hash: hashOf(final), stored, validators };
}

const hashOf = (snapshot: CatalogSnapshot) => createHash('sha256').update(redactedJson(snapshot)).digest('hex');

export interface CatalogStore {
  // update takes a new tool list of a server. it returns the catalog, and records a version only when the list changed.
  update(entry: IntegrationEntry, listed: McpTool[]): Catalog;
  get(integrationId: string): Catalog | undefined;
}

// the store keeps the last catalog of each server in the database. after a restart the model can find the tools at
// once, also while a slow server still starts, and the call waits for the connection.
export function createCatalogStore(deps: { db: Db; clock: Clock; logger: Logger; entries: IntegrationEntry[] }): CatalogStore {
  const { db, clock, logger } = deps;
  const catalogs = new Map<string, Catalog>();
  for (const entry of deps.entries) {
    const row = db
      .prepare(
        `SELECT s.tools FROM integration_catalogs c JOIN tool_catalog_snapshots s ON s.hash = c.hash
         WHERE c.integrationId = ? ORDER BY c.id DESC LIMIT 1`,
      )
      .get(entry.id);
    if (!row) continue;
    try {
      const stored = JSON.parse(String(row.tools)) as CatalogSnapshot;
      // the config can have changed since the snapshot. a tool that the config no longer allows stays hidden.
      const allowed = new Set(entry.tools.allow);
      catalogs.set(entry.id, compile({ ...stored, tools: stored.tools.filter((tool) => allowed.has(tool.mcpName)) }, true, logger));
    } catch (err) {
      logger.warn('stored mcp catalog is not readable', { integration: entry.id, err });
    }
  }

  return {
    get: (id) => catalogs.get(id),
    update(entry, listed) {
      // a server can send list_changed often. the compile of 200 schemas takes about 120 ms on the event loop, so an
      // unchanged list keeps the catalog that exists.
      const built = buildSnapshot(entry, listed);
      const source = hashOf(built);
      const current = catalogs.get(entry.id);
      if (current && !current.stored && current.source === source) return current;
      const catalog = { ...compile(built, false, logger), source };
      const last = db.prepare('SELECT hash FROM integration_catalogs WHERE integrationId = ? ORDER BY id DESC LIMIT 1').get(entry.id);
      if (last?.hash !== catalog.hash) {
        const now = clock().toISOString();
        db.prepare('INSERT OR IGNORE INTO tool_catalog_snapshots (hash, tools, createdAt) VALUES (?, ?, ?)').run(catalog.hash, redactedJson(catalog.snapshot), now);
        db.prepare('INSERT INTO integration_catalogs (integrationId, hash, createdAt) VALUES (?, ?, ?)').run(entry.id, catalog.hash, now);
        logger.info('mcp catalog changed', { integration: entry.id, hash: catalog.hash, tools: catalog.snapshot.tools.length });
      }
      catalogs.set(entry.id, catalog);
      return catalog;
    },
  };
}
