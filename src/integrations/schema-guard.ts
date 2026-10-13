import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

type Schema = Record<string, unknown>;

// a schema over this size cannot fit in one tool_search answer, so the model could never read it.
export const SCHEMA_BYTES_LIMIT = 16 * 1024;
// ajv compiles a schema with recursion, and a deep schema overflows the stack.
export const SCHEMA_DEPTH_LIMIT = 32;

const isSchema = (value: unknown): value is Schema => value !== null && typeof value === 'object' && !Array.isArray(value);

// the keywords whose value is one schema, a list of schemas, or a map of schemas.
const ONE = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'additionalItems'];
const LIST = ['anyOf', 'oneOf', 'allOf', 'prefixItems', 'items'];
const MAP = ['properties', '$defs', 'definitions', 'dependentSchemas'];

export type Prepared = { ok: true; schema: Schema } | { ok: false; reason: string };

// the server writes the schema, and the model writes the input. so the guard removes what lets the input or the schema
// take the event loop or another server's schema:
// - pattern and patternProperties run a regular expression of the server on text of the model. a pattern such as
//   ^(a+)+$ took 11 s on 29 characters, on the event loop of the live app.
// - $id lets one server's schema replace another server's schema in the shared ajv cache.
// each change makes the check looser, never stricter, so a valid input never fails. the server checks its input again.
export function prepareSchema(raw: unknown): Prepared {
  if (raw === undefined) return { ok: true, schema: { type: 'object' } };
  if (!isSchema(raw)) return { ok: false, reason: 'the input schema is not an object' };
  if (raw.type !== undefined && raw.type !== 'object') return { ok: false, reason: `the input schema has type ${JSON.stringify(raw.type)}, not object` };
  let text: string;
  try {
    text = JSON.stringify(raw);
  } catch {
    return { ok: false, reason: 'the input schema is not json' };
  }
  if (Buffer.byteLength(text) > SCHEMA_BYTES_LIMIT) return { ok: false, reason: `the input schema has ${Buffer.byteLength(text)} bytes, over ${SCHEMA_BYTES_LIMIT}` };
  const deep = depth(raw);
  if (deep > SCHEMA_DEPTH_LIMIT) return { ok: false, reason: `the input schema is ${deep} levels deep, over ${SCHEMA_DEPTH_LIMIT}` };
  return { ok: true, schema: { ...loosen(JSON.parse(text) as Schema), type: 'object' } };
}

function depth(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depth));
  if (isSchema(value)) return 1 + Math.max(0, ...Object.values(value).map(depth));
  return 0;
}

function loosen(schema: Schema): Schema {
  const { pattern: _pattern, patternProperties, $id: _id, $anchor: _anchor, $dynamicAnchor: _dynamic, ...rest } = schema;
  // keys that matched a pattern would now fall to additionalProperties, so a false there would refuse them.
  if (patternProperties !== undefined && rest.additionalProperties === false) delete rest.additionalProperties;
  for (const key of ONE) if (isSchema(rest[key])) rest[key] = loosen(rest[key]);
  for (const key of LIST) if (Array.isArray(rest[key])) rest[key] = (rest[key] as unknown[]).map((each) => (isSchema(each) ? loosen(each) : each));
  for (const key of MAP) {
    if (isSchema(rest[key])) {
      rest[key] = Object.fromEntries(Object.entries(rest[key]).map(([name, each]) => [name, isSchema(each) ? loosen(each) : each]));
    }
  }
  return rest;
}

export type Validate = (input: unknown) => { ok: true } | { ok: false; message: string };

// each catalog version gets its own validator, so the compiled schemas of an old catalog go away with it. a schema
// that ajv cannot compile gives an error, and the catalog leaves the tool out with the reason.
export function createValidatorSet() {
  const ajv = new AjvJsonSchemaValidator();
  return (schema: Schema): Validate => {
    const check = ajv.getValidator(schema);
    return (input) => {
      const result = check(input);
      if (result.valid) return { ok: true };
      // ajv names the input "data", as in "data/text must be string". the model knows the field path, not that name.
      const message = String(result.errorMessage ?? 'the input does not match the schema')
        .replace(/(^|, )data\//g, '$1')
        .replace(/(^|, )data /g, '$1the input ');
      return { ok: false, message: message.slice(0, 1_000) };
    };
  };
}
