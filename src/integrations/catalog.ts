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
  // tools that the config allows and the server offers, but the catalog left out, with the reason.
  rejected: Array<{ mcpName: string; reason: string }>;
  // tools that the config allows and the server does not offer, for example a typo or a server upgrade.
  missing: string[];
}

export interface Catalog {
  snapshot: CatalogSnapshot;
  hash: string;
  // stored means that the catalog came from the database at the start, before the server answered.
  stored: boolean;
  validators: Map<string, Validate>;
  // the hash of the snapshot before the compile. an equal list from the server keeps this catalog.
  source?: string;
  // the names of the server's tools that the config does not allow. they are not part of the version, so a server
  // that changes only such tools makes no new version. a stored catalog does not know them.
  hidden: string[];
}

// the page shows at most this many hidden names, each cut to a short length. the server writes them.
const HIDDEN_LIMIT = 200;
const HIDDEN_NAME_LIMIT = 100;

// the server names its tools, and a name such as constructor or __proto__ reads a value of Object.prototype from a
// plain object. so only an own key of the risk map counts.
const configuredRisk = (entry: IntegrationEntry, tool: CatalogTool): Risk | undefined =>
  Object.hasOwn(entry.risk, tool.mcpName) ? entry.risk[tool.mcpName] : undefined;

export function riskOf(entry: IntegrationEntry, tool: CatalogTool): Risk {
  // a hint of the server never makes a tool read. the config decides, and the default asks for a review at least.
  return configuredRisk(entry, tool) ?? (tool.readOnlyHint ? 'write' : 'external');
}

// the owner sees where a risk comes from, so a default that asks for each call is easy to find and change.
export function riskFrom(entry: IntegrationEntry, tool: CatalogTool): string {
  if (configuredRisk(entry, tool)) return 'okc.integrations.json';
  return tool.readOnlyHint ? 'default: the server says read only' : 'default: the server does not say read only';
}

// the change from one version to the next. a new description is new text in front of the model, so the page marks it.
export interface CatalogDiff {
  added: string[];
  removed: string[];
  changed: Array<{ name: string; fields: string[] }>;
}

export function diffCatalogs(before: CatalogTool[], after: CatalogTool[]): CatalogDiff {
  const old = new Map(before.map((tool) => [tool.name, tool]));
  const now = new Map(after.map((tool) => [tool.name, tool]));
  const changed: CatalogDiff['changed'] = [];
  for (const tool of after) {
    const was = old.get(tool.name);
    if (!was) continue;
    const fields = [
      ...(was.description !== tool.description ? ['description'] : []),
      ...(JSON.stringify(was.inputSchema) !== JSON.stringify(tool.inputSchema) ? ['input schema'] : []),
      ...(was.readOnlyHint !== tool.readOnlyHint ? ['read only hint'] : []),
    ];
    if (fields.length) changed.push({ name: tool.name, fields });
  }
  return {
    added: after.filter((tool) => !old.has(tool.name)).map((tool) => tool.name),
    removed: before.filter((tool) => !now.has(tool.name)).map((tool) => tool.name),
    changed,
  };
}

// the server's list goes through the allow list of the config first. tools outside it never reach the model.
export function buildSnapshot(entry: IntegrationEntry, listed: McpTool[]): CatalogSnapshot & { hidden: string[] } {
  const tools: CatalogTool[] = [];
  const rejected: CatalogSnapshot['rejected'] = [];
  const hidden: string[] = [];
  const allowed = new Set(entry.tools.allow);
  const seen = new Map<string, string>();
  for (const tool of listed) {
    if (!allowed.has(tool.name)) {
      if (!entry.tools.allow.includes(tool.name) && hidden.length < HIDDEN_LIMIT) hidden.push(headOf(String(tool.name), HIDDEN_NAME_LIMIT));
      continue;
    }
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
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { integrationId: entry.id, tools, rejected, missing: [...allowed], hidden: hidden.sort() };
}

// compile turns a snapshot into a catalog. a schema that ajv cannot compile moves the tool to the rejected list.
function compile(snapshot: CatalogSnapshot, stored: boolean, logger: Logger, hidden: string[] = []): Catalog {
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
  const final: CatalogSnapshot = { integrationId: snapshot.integrationId, tools, rejected, missing: snapshot.missing };
  return { snapshot: final, hash: hashOf(final), stored, validators, hidden };
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
      const keep = (name: string) => allowed.has(name);
      // an older version of the guard stored the schema. the guard of today must apply to it too, because the model
      // can call the tool before the server sends its list again.
      const tools: CatalogTool[] = [];
      const rejected = stored.rejected.filter((each) => keep(each.mcpName));
      for (const tool of stored.tools.filter((each) => keep(each.mcpName))) {
        const prepared = prepareSchema(tool.inputSchema);
        if (prepared.ok) tools.push({ ...tool, inputSchema: prepared.schema });
        else rejected.push({ mcpName: tool.mcpName, reason: prepared.reason });
      }
      catalogs.set(
        entry.id,
        compile(
          {
            integrationId: entry.id,
            tools,
            rejected,
            missing: (stored.missing ?? []).filter(keep),
          },
          true,
          logger,
        ),
      );
    } catch (err) {
      logger.warn('stored mcp catalog is not readable', { integration: entry.id, err });
    }
  }

  return {
    get: (id) => catalogs.get(id),
    update(entry, listed) {
      // a server can send list_changed often. the compile of 200 schemas takes about 120 ms on the event loop, so an
      // unchanged list keeps the catalog that exists.
      const { hidden, ...built } = buildSnapshot(entry, listed);
      const source = hashOf(built);
      const current = catalogs.get(entry.id);
      if (current && !current.stored && current.source === source) {
        current.hidden = hidden;
        return current;
      }
      const catalog = { ...compile(built, false, logger, hidden), source };
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
