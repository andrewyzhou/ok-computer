import { describe, expect, it } from 'vitest';
import { TOOL_NAME, toolName } from './names.js';
import { createValidatorSet, prepareSchema, SCHEMA_DEPTH_LIMIT, SCHEMA_PARTS_LIMIT } from './schema-guard.js';

describe('tool names', () => {
  it('keeps a plain name and changes the others to a stable valid name', () => {
    expect(toolName('notes', 'echo')).toBe('notes__echo');
    const dotted = toolName('notes', 'files.read');
    expect(dotted).toMatch(TOOL_NAME);
    expect(dotted).toBe(toolName('notes', 'files.read'));
    // two names that clean to the same text stay apart.
    expect(toolName('notes', 'files/read')).not.toBe(dotted);
    const long = toolName('a-very-long-integration-id', 'x'.repeat(200));
    expect(long).toMatch(TOOL_NAME);
    expect(toolName('notes', 'späť')).toMatch(TOOL_NAME);
  });
});

describe('schema guard', () => {
  const compile = createValidatorSet();

  it('removes a pattern, so a hostile pattern cannot hold the event loop', () => {
    const prepared = prepareSchema({ type: 'object', properties: { q: { type: 'string', pattern: '^(a+)+$' } } });
    if (!prepared.ok) throw new Error(prepared.reason);
    const validate = compile(prepared.schema);
    const start = performance.now();
    expect(validate({ q: 'a'.repeat(40) + '!' })).toEqual({ ok: true });
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('keeps a property that is named pattern', () => {
    const prepared = prepareSchema({ type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(compile(prepared.schema)({})).toMatchObject({ ok: false, message: expect.stringContaining('pattern') });
  });

  it('only loosens: a key that a pattern property allowed stays allowed', () => {
    const prepared = prepareSchema({ type: 'object', patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(compile(prepared.schema)({ 'x-trace': 'a' })).toEqual({ ok: true });
  });

  it('removes $id, so one server cannot replace the schema of another', () => {
    const validators = createValidatorSet();
    const loose = prepareSchema({ $id: 'shared', type: 'object' });
    const strict = prepareSchema({ $id: 'shared', type: 'object', properties: { n: { type: 'number' } }, required: ['n'] });
    if (!loose.ok || !strict.ok) throw new Error('prepare failed');
    validators(loose.schema);
    expect(validators(strict.schema)({})).toMatchObject({ ok: false });
  });

  it('refuses a deep, a large, or a non-object schema with a reason', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < SCHEMA_DEPTH_LIMIT; i++) deep = { type: 'object', properties: { x: deep } };
    expect(prepareSchema(deep)).toMatchObject({ ok: false, reason: expect.stringContaining('deep') });
    expect(prepareSchema({ type: 'object', description: 'x'.repeat(20_000) })).toMatchObject({ ok: false, reason: expect.stringContaining('bytes') });
    expect(prepareSchema({ type: 'string' })).toMatchObject({ ok: false });
    expect(prepareSchema(undefined)).toEqual({ ok: true, schema: { type: 'object' } });
  });

  // a pattern that the old walk missed ran for 6 to 12 s on 28 characters. each case must answer at once.
  const slow = 'a'.repeat(30) + '!';
  const quick = (schema: Record<string, unknown>, input: Record<string, unknown>) => {
    const prepared = prepareSchema(schema);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(JSON.stringify(prepared.schema)).not.toContain('(a+)+');
    const validate = compile(prepared.schema);
    const start = performance.now();
    const result = validate(input);
    expect(performance.now() - start).toBeLessThan(100);
    return result;
  };

  it('removes a pattern under draft-07 dependencies', () => {
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' }, mode: { type: 'string' } },
      dependencies: { mode: { properties: { q: { pattern: '^(a+)+$' } } }, q: ['mode'] },
    };
    expect(quick(schema, { mode: 'x', q: slow })).toEqual({ ok: true });
    // the list form of dependencies still works.
    expect(quick(schema, { q: 'a' })).toMatchObject({ ok: false });
  });

  it('removes a pattern under a key that is not a keyword, when a reference points to it', () => {
    const schema = { type: 'object', 'x-shared': { slow: { type: 'string', pattern: '^(a+)+$' } }, properties: { s: { $ref: '#/x-shared/slow' } } };
    expect(quick(schema, { s: slow })).toEqual({ ok: true });
    expect(quick(schema, { s: 3 })).toMatchObject({ ok: false });
    // ajv also reads draft-07 schemas with its other class.
    expect(quick({ ...schema, $schema: 'http://json-schema.org/draft-07/schema#' }, { s: slow })).toEqual({ ok: true });
  });

  it('keeps the references of a converted zod schema, which point into properties', () => {
    const schema = { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' }, b: { $ref: '#/properties/a' }, c: { $ref: '#/%24defs/n' } }, $defs: { n: { type: 'number' } } };
    expect(quick(schema, { a: slow, b: slow, c: 1 })).toEqual({ ok: true });
    expect(quick(schema, { b: 1 })).toMatchObject({ ok: false });
    expect(quick(schema, { c: 'x' })).toMatchObject({ ok: false });
  });

  it('refuses a reference into data or into a map of names, where a pattern can stay', () => {
    const intoDefault = { type: 'object', properties: { a: { default: { type: 'string', pattern: '^(a+)+$' } }, s: { $ref: '#/properties/a/default' } } };
    expect(prepareSchema(intoDefault)).toMatchObject({ ok: false, reason: expect.stringContaining('#/properties/a/default') });
    const intoNames = { type: 'object', x: { properties: { pattern: '^(a+)+$' } }, properties: { s: { $ref: '#/x/properties' } } };
    expect(prepareSchema(intoNames)).toMatchObject({ ok: false, reason: expect.stringContaining('does not point to a schema') });
    expect(prepareSchema({ type: 'object', properties: { s: { $ref: '#/x%2' } } })).toMatchObject({ ok: false });
  });

  it('only loosens: unevaluatedProperties false does not refuse a key that a pattern property allowed', () => {
    expect(quick({ type: 'object', patternProperties: { '^x-': { type: 'string' } }, unevaluatedProperties: false }, { 'x-trace': 'a' })).toEqual({ ok: true });
  });

  it('checks the keywords that zod cannot read, such as if/then and a oneOf with a const', () => {
    const prepared = prepareSchema({
      type: 'object',
      oneOf: [
        { properties: { kind: { const: 'a' }, x: { type: 'string' } }, required: ['kind'] },
        { properties: { kind: { const: 'b' }, y: { type: 'number' } }, required: ['kind'] },
      ],
      if: { properties: { kind: { const: 'a' } } },
      then: { required: ['x'] },
    });
    if (!prepared.ok) throw new Error(prepared.reason);
    const validate = compile(prepared.schema);
    expect(validate({ kind: 'a', x: 'q' })).toEqual({ ok: true });
    expect(validate({ kind: 'a' })).toMatchObject({ ok: false });
  });

  // each level of the chain refers twice to the next level, so the check visits 2^levels parts. 24 levels of anyOf
  // ran out of heap memory, and 31 levels of allOf took 7.9 s on a valid input.
  const chain = (levels: number, keyword: string) => {
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < levels; i++) defs[`d${i}`] = { [keyword]: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
    defs[`d${levels}`] = { type: 'string' };
    return { type: 'object', properties: { text: { $ref: '#/$defs/d0' } }, $defs: defs };
  };
  const recursive = (a: Record<string, unknown>) => ({ type: 'object', properties: { a: { $ref: '#/$defs/a' } }, $defs: { a } });

  it('refuses a schema whose references branch into more parts than the limit', () => {
    const start = performance.now();
    expect(prepareSchema(chain(24, 'anyOf'))).toMatchObject({ ok: false, reason: expect.stringContaining(`more than ${SCHEMA_PARTS_LIMIT} parts`) });
    expect(prepareSchema(chain(31, 'allOf'))).toMatchObject({ ok: false, reason: expect.stringContaining('parts') });
    expect(performance.now() - start).toBeLessThan(100);
    // a short chain stays, and its check is quick.
    expect(quick(chain(8, 'allOf'), { text: 'x' })).toEqual({ ok: true });
  });

  it('refuses a recursion that comes back twice over the same input, or without a step into the input', () => {
    const twice = recursive({ allOf: [{ items: { $ref: '#/$defs/a' } }, { items: { $ref: '#/$defs/a' } }] });
    expect(prepareSchema(twice)).toMatchObject({ ok: false, reason: expect.stringContaining('exponentially') });
    // the paths x and x.x split a chain of x in fib(n) ways: 30 levels took 64 ms, and each level adds 60 %.
    const xx = recursive({ properties: { x: { $ref: '#/$defs/a' } }, allOf: [{ properties: { x: { properties: { x: { $ref: '#/$defs/a' } } } } }] });
    expect(prepareSchema(xx)).toMatchObject({ ok: false, reason: expect.stringContaining('exponentially') });
    expect(prepareSchema(recursive({ allOf: [{ $ref: '#/$defs/a' }] }))).toMatchObject({ ok: false, reason: expect.stringContaining('does not end') });
    // a reference to the root counts the same.
    const root = { properties: { a: { $ref: '#' } } };
    expect(prepareSchema({ type: 'object', ...root })).toMatchObject({ ok: true });
    expect(prepareSchema({ type: 'object', allOf: [root, root] })).toMatchObject({ ok: false, reason: expect.stringContaining('exponentially') });
  });

  it('keeps a recursion with one path over each input, such as a filter, a json value or a tree', () => {
    const nest = (n: number, make: (inner: unknown) => unknown, leaf: unknown) => {
      let value = leaf;
      for (let i = 0; i < n; i++) value = make(value);
      return value;
    };
    const filter = recursive({
      anyOf: [
        { properties: { and: { type: 'array', items: { $ref: '#/$defs/a' } } }, required: ['and'] },
        { properties: { or: { type: 'array', items: { $ref: '#/$defs/a' } } }, required: ['or'] },
        { properties: { property: { type: 'string' } }, required: ['property'] },
      ],
    });
    expect(quick(filter, { a: nest(200, (f) => ({ or: [f, { property: 'p' }] }), { property: 'p' }) })).toEqual({ ok: true });
    const json = recursive({ anyOf: [{ type: 'string' }, { type: 'array', items: { $ref: '#/$defs/a' } }, { type: 'object', additionalProperties: { $ref: '#/$defs/a' } }] });
    expect(quick(json, { a: nest(200, (v) => ({ k: [v, 'x'] }), 'x') })).toEqual({ ok: true });
    const tree = recursive({ type: 'object', properties: { left: { $ref: '#/$defs/a' }, right: { $ref: '#/$defs/a' } } });
    expect(quick(tree, { a: nest(200, (n) => ({ left: n, right: {} }), {}) })).toEqual({ ok: true });
    expect(quick(tree, { a: { left: 1 } })).toMatchObject({ ok: false });
  });

  it('removes format url, whose check is quadratic, and keeps the other formats', () => {
    const prepared = prepareSchema({ type: 'object', properties: { u: { type: 'string', format: 'url' }, v: { type: 'string', format: 'uri' } } });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.schema).toEqual({ type: 'object', properties: { u: { type: 'string' }, v: { type: 'string', format: 'uri' } } });
    expect(quick(prepared.schema, { u: `http://[${':'.repeat(40_000)}]`, v: 'https://example.com' })).toEqual({ ok: true });
  });
});
