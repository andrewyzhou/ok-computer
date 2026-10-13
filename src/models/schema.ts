type Schema = Record<string, unknown>;

export type SchemaDialect = 'anthropic' | 'openai-compat';

// the plain form puts each reference in place. a schema whose references double at each level grew from 2 kb to 124 mb
// in 3.8 s, so the output has a budget of nodes, and a part past the budget accepts any value. the server still checks
// its input, so a looser schema never lets a bad call through.
export const NODE_BUDGET = 2_000;
export const DEPTH_LIMIT = 32;

const isSchema = (value: unknown): value is Schema => value !== null && typeof value === 'object' && !Array.isArray(value);
const ANY = (why: string): Schema => ({ description: `any value (${why})` });

// claude takes json schema almost unchanged. local models through the openai-compatible api often fail on $ref, and on
// a union where a list of types or an enum says the same. so that dialect gets a plain schema. the change keeps every
// valid input valid: a union of objects stays a choice, because one shape would hide the others, for example the cron
// and interval schedules of automations_create.
export function normalizeSchema(schema: Schema, dialect: SchemaDialect): Schema {
  const { $schema: _ignored, ...rest } = schema;
  if (dialect === 'anthropic') return rest;
  const { $defs, definitions, ...body } = rest;
  const defs = { ...(isSchema(definitions) ? definitions : {}), ...(isSchema($defs) ? $defs : {}) };
  return plain(body, defs, [], 0, { left: NODE_BUDGET });
}

function plain(schema: Schema, defs: Schema, seen: string[], depth: number, budget: { left: number }): Schema {
  if (--budget.left < 0) return ANY('the schema is too large to show in full');
  if (depth > DEPTH_LIMIT) return ANY('the schema is too deep to show in full');
  const next = (part: Schema) => plain(part, defs, seen, depth + 1, budget);
  if (typeof schema.$ref === 'string') {
    const name = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(schema.$ref)?.[1];
    const target = name === undefined ? undefined : defs[name];
    const { $ref: _ref, ...siblings } = schema;
    // a reference to itself has no finite plain form, so the inner level accepts any value.
    if (!name || !isSchema(target) || seen.includes(name)) return { ...siblings, ...(siblings.description ? {} : { description: 'any value' }) };
    return plain({ ...target, ...siblings }, defs, [...seen, name], depth, budget);
  }
  // the walk goes into every value and not only into a list of keywords, because the $defs are gone, and a reference
  // that it misses, for example in prefixItems or not, would point to nothing. the unions come after it, and their
  // variants get their own walk.
  let out: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DATA.has(key) || UNIONS.has(key)) out[key] = value;
    else if (NAME_MAPS.has(key) && isSchema(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, each]) => [name, isSchema(each) ? next(each) : each]));
    } else if (isSchema(value)) out[key] = next(value);
    else if (Array.isArray(value)) out[key] = value.map((each) => (isSchema(each) ? next(each) : each));
    else out[key] = value;
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(out[key])) out = { ...withoutKey(out, key), ...simplifyUnion(out[key] as unknown[], next) };
  }
  if (Array.isArray(out.allOf)) out = mergeAll(withoutKey(out, 'allOf'), (out.allOf as unknown[]).filter(isSchema).map(next));
  return out;
}

// the keywords whose value maps a name to a schema, the keywords whose value is data, and the unions.
const NAME_MAPS = new Set(['properties', 'patternProperties', 'dependentSchemas', 'dependencies']);
const DATA = new Set(['const', 'enum', 'default', 'examples', 'required']);
const UNIONS = new Set(['anyOf', 'oneOf', 'allOf']);

// a null variant only makes a field nullable. the model can leave out the field instead.
function simplifyUnion(variants: unknown[], next: (part: Schema) => Schema): Schema {
  const parts = variants.filter(isSchema).map(next).filter((part) => part.type !== 'null');
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0]!;
  const only = (part: Schema, keys: string[]) => Object.keys(part).every((key) => keys.includes(key));
  if (parts.every((part) => typeof part.type === 'string' && only(part, ['type', 'description']))) {
    return { type: [...new Set(parts.map((part) => part.type as string))] };
  }
  if (parts.every((part) => 'const' in part && only(part, ['const', 'type', 'description']))) return { enum: parts.map((part) => part.const) };
  // more local runtimes read anyOf than oneOf. every input that matches one variant also matches anyOf.
  return { anyOf: parts };
}

function mergeAll(base: Schema, parts: Schema[]): Schema {
  const out: Schema = { ...base };
  for (const part of parts) {
    const { properties, required, ...rest } = part;
    Object.assign(out, rest);
    if (isSchema(properties)) out.properties = { ...(isSchema(out.properties) ? out.properties : {}), ...properties };
    if (Array.isArray(required)) out.required = [...new Set([...((out.required as string[] | undefined) ?? []), ...required])];
  }
  return out;
}

function withoutKey(schema: Schema, key: string): Schema {
  const { [key]: _removed, ...rest } = schema;
  return rest;
}
