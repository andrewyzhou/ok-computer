import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

type Schema = Record<string, unknown>;

// a schema over this size cannot fit in one tool_search answer, so the model could never read it.
export const SCHEMA_BYTES_LIMIT = 16 * 1024;
// ajv compiles a schema with recursion, and a deep schema overflows the stack.
export const SCHEMA_DEPTH_LIMIT = 32;

const isSchema = (value: unknown): value is Schema => value !== null && typeof value === 'object' && !Array.isArray(value);

// the keywords whose value maps a name to a schema. the names are data, so a property that is named pattern stays.
const NAME_MAPS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
// the keywords whose value is data. ajv compiles them only when a reference points into them, and the guard refuses
// such a reference.
const DATA = new Set(['const', 'enum', 'default', 'examples', 'required']);
const REFERENCES = new Set(['$ref', '$dynamicRef', '$recursiveRef']);
// the keys that give a schema its own name. without them, a reference can only be a json pointer from the root.
const NAMES = new Set(['$id', '$anchor', '$dynamicAnchor']);

export type Prepared = { ok: true; schema: Schema } | { ok: false; reason: string };

// the server writes the schema, and the model writes the input. so the guard removes what lets the input or the schema
// take the event loop or another server's schema:
// - pattern and patternProperties run a regular expression of the server on text of the model. a pattern such as
//   ^(a+)+$ took 11 s on 29 characters, on the event loop of the live app. a list of the keywords that hold a schema
//   is not enough: ajv also reads draft-07 dependencies, and a $ref can point to any key, for example #/x-shared/slow.
//   so the walk goes into every value, and it removes each pattern that is not a name in a map of properties.
// - $id lets one server's schema replace another server's schema in the shared ajv cache.
// each change makes the check looser, never stricter, so a valid input never fails. the server checks its input again.
// a reference must point to a part that the walk saw as a schema. a reference into data or into a map of names can
// reach a pattern that the walk kept, so the guard refuses the schema.
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
  const walk: Walk = { schemas: new Set(), references: [] };
  const schema = { ...(loosen(JSON.parse(text), '', walk) as Schema), type: 'object' };
  const outside = walk.references.find((reference) => !pointsToSchema(reference, walk.schemas));
  if (outside !== undefined) return { ok: false, reason: `the input schema has the reference ${JSON.stringify(outside)}, which does not point to a schema in it` };
  return { ok: true, schema };
}

function depth(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depth));
  if (isSchema(value)) return 1 + Math.max(0, ...Object.values(value).map(depth));
  return 0;
}

// schemas gets the json pointer of each part that the walk loosened as a schema, and references gets each reference.
interface Walk {
  schemas: Set<string>;
  references: string[];
}

function loosen(node: unknown, at: string, walk: Walk): unknown {
  if (Array.isArray(node)) return node.map((each, i) => loosen(each, `${at}/${i}`, walk));
  if (!isSchema(node)) return node;
  walk.schemas.add(at);
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pattern' || key === 'patternProperties' || NAMES.has(key)) continue;
    const path = `${at}/${escapePointer(key)}`;
    if (REFERENCES.has(key) && typeof value === 'string') walk.references.push(value);
    if (DATA.has(key)) out[key] = value;
    else if (NAME_MAPS.has(key) && isSchema(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, each]) => [name, loosen(each, `${path}/${escapePointer(name)}`, walk)]));
    } else out[key] = loosen(value, path, walk);
  }
  // keys that matched a pattern now fall to additionalProperties and unevaluatedProperties, so a false there would
  // refuse them.
  if (node.patternProperties !== undefined) {
    if (out.additionalProperties === false) delete out.additionalProperties;
    if (out.unevaluatedProperties === false) delete out.unevaluatedProperties;
  }
  return out;
}

const escapePointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

// ajv reads a reference as a uri, so its fragment can have percent escapes. the guarded schema has no $id, so a
// reference without # at the start cannot resolve, and ajv refuses the schema when it compiles it.
function pointsToSchema(reference: string, schemas: Set<string>): boolean {
  const hash = reference.indexOf('#');
  if (hash < 0) return true;
  // an anchor (#name) has no target, because the walk removed every anchor. ajv refuses it when it compiles.
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(hash + 1));
  } catch {
    return false;
  }
  if (pointer !== '' && !pointer.startsWith('/')) return true;
  return schemas.has(pointer.replace(/\/$/, ''));
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
