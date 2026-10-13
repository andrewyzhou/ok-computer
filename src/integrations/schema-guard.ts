import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

type Schema = Record<string, unknown>;

// a schema over this size cannot fit in one tool_search answer, so the model could never read it.
export const SCHEMA_BYTES_LIMIT = 16 * 1024;
// ajv compiles a schema with recursion, and a deep schema overflows the stack.
export const SCHEMA_DEPTH_LIMIT = 32;
// the check of an input visits each part of the schema that applies to it, and a reference puts its target in place
// at each use. a schema of SCHEMA_BYTES_LIMIT without references has fewer parts than this limit, so references must
// not make a schema larger than that.
export const SCHEMA_PARTS_LIMIT = 5_000;

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
// - format url runs a regular expression of ajv-formats that is quadratic: 40,000 characters took 1.2 s. the other
//   formats took less than 3 ms on 20,000 characters, so they stay, and the model still reads them.
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
  const costly = checkCost(schema);
  if (costly !== undefined) return { ok: false, reason: costly };
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
    if (key === 'pattern' || key === 'patternProperties' || NAMES.has(key) || (key === 'format' && value === 'url')) continue;
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
  const pointer = pointerOf(reference.slice(hash + 1));
  // an anchor (#name) has no target, because the walk removed every anchor. ajv refuses it when it compiles.
  if (pointer === null) return true;
  return pointer !== undefined && schemas.has(pointer);
}

// the json pointer of a fragment without its last slash, null for a name, or undefined when it has a bad escape.
function pointerOf(fragment: string): string | null | undefined {
  let pointer: string;
  try {
    pointer = decodeURIComponent(fragment);
  } catch {
    return undefined;
  }
  if (pointer !== '' && !pointer.startsWith('/')) return null;
  return pointer.replace(/\/$/, '');
}

// the keywords whose schema applies to the items of an array, or to the values of an object. the other keywords, for
// example allOf, anyOf and if, apply their schema to the same value.
const ITEMS = new Set(['items', 'prefixItems', 'additionalItems', 'unevaluatedItems', 'contains']);
const VALUES = new Set(['additionalProperties', 'unevaluatedProperties', 'propertyNames']);
// a step from a value into a part of it: p: and the name of a property, or a wildcard: p:* for any property, and i:*
// for any item.
type Step = string;

// the sdk gives ajv allErrors, so ajv checks every branch of allOf, anyOf and oneOf. so a schema where each level refers
// twice to the next level is small, but its check visits 2^levels parts: 24 levels in 1.6 kb ran out of heap memory,
// and that stops the process. checkCost counts the parts with each reference put in place. it stops at the limit, so
// its own work is small too.
// a reference back to a part that the count is in is a recursion, and its check grows with the input. for one path,
// for example a tree of items, the growth is linear. when two paths come back over the same input, the growth is
// exponential: a = allOf [items a, items a] took 211 ms on 22 nested arrays, and each level doubles it. paths into
// different properties are safe, for example a filter with and and or. a path that is the start of another path can
// be safe too, but the count refuses it, because it cannot tell.
function checkCost(root: Schema): string | undefined {
  let parts = 0;
  const input: Step[] = [];
  // the parts that the count is in through a reference: the input steps at the start, and the steps of each path back.
  const open: Array<{ pointer: string; at: number; back: Step[][] }> = [];
  const visit = (node: unknown): string | undefined => {
    if (Array.isArray(node)) {
      for (const each of node) {
        const found = visit(each);
        if (found) return found;
      }
      return undefined;
    }
    if (!isSchema(node)) return undefined;
    if (++parts > SCHEMA_PARTS_LIMIT) {
      return `the input schema has more than ${SCHEMA_PARTS_LIMIT} parts when each reference is put in place, so its check could hold the app`;
    }
    for (const [key, value] of Object.entries(node)) {
      // a definition applies only through a reference, and data is not a schema.
      if (DATA.has(key) || key === '$defs' || key === 'definitions') continue;
      let found: string | undefined;
      if (REFERENCES.has(key)) found = typeof value === 'string' ? follow(value) : undefined;
      else if (key === 'properties' && isSchema(value)) {
        for (const [name, each] of Object.entries(value)) if ((found = within(`p:${name}`, each))) break;
      } else if (ITEMS.has(key)) found = within('i:*', value);
      else if (VALUES.has(key)) found = within('p:*', value);
      // the names of dependentSchemas and dependencies are names of properties, not schemas.
      else found = visit(NAME_MAPS.has(key) && isSchema(value) ? Object.values(value) : value);
      if (found) return found;
    }
    return undefined;
  };
  const within = (step: Step, node: unknown) => {
    input.push(step);
    const found = visit(node);
    input.pop();
    return found;
  };
  const follow = (reference: string): string | undefined => {
    // ajv refuses a reference that is not local when it compiles the schema.
    const pointer = reference.startsWith('#') ? pointerOf(reference.slice(1)) : undefined;
    if (pointer === undefined || pointer === null) return undefined;
    const loop = open.find((each) => each.pointer === pointer);
    if (loop) {
      const path = input.slice(loop.at);
      if (!path.length) return `the reference ${JSON.stringify(reference)} comes back to itself on the same value, so its check does not end`;
      if (loop.back.some((other) => overlaps(other, path))) {
        return `the reference ${JSON.stringify(reference)} comes back to itself on two paths over the same input, so its check grows exponentially with the input`;
      }
      loop.back.push(path);
      return undefined;
    }
    const target = partAt(root, pointer);
    if (target === undefined) return undefined;
    open.push({ pointer, at: input.length, back: [] });
    const found = visit(target);
    open.pop();
    return found;
  };
  return visit(root);
}

// two paths overlap when one is the start of the other, and each step can be the same step in the input.
function overlaps(a: Step[], b: Step[]): boolean {
  const same = (x: Step, y: Step) => x === y || ((x === 'p:*' || y === 'p:*') && x.startsWith('p:') && y.startsWith('p:'));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (!same(a[i]!, b[i]!)) return false;
  return true;
}

function partAt(root: Schema, pointer: string): unknown {
  let node: unknown = root;
  for (const token of pointer.split('/').slice(1)) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isSchema(node) && Object.hasOwn(node, key)) node = node[key];
    else return undefined;
  }
  return node;
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
