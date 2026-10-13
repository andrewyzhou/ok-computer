import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDb } from '../db/index.js';
import { createAutomationTools } from '../scheduler/tools.js';
import { createToolRegistry } from '../tools/registry.js';
import { normalizeSchema } from './schema.js';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    when: { $ref: '#/$defs/Range', description: 'the time range' },
    label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    id: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    mode: { anyOf: [{ const: 'fast' }, { const: 'slow' }] },
    target: { anyOf: [{ type: 'object', properties: { email: { type: 'string' } } }, { type: 'array', items: { type: 'string' } }] },
    tree: { $ref: '#/$defs/Node' },
    both: { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'number' } }, required: ['b'] }] },
  },
  $defs: {
    Range: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from'] },
    Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } },
  },
};

describe('schema normalization', () => {
  it('keeps the schema for claude and drops only $schema', () => {
    const { $schema: _ignored, ...rest } = schema;
    expect(normalizeSchema(schema, 'anthropic')).toEqual(rest);
  });

  it('puts references in place and keeps only the unions that a type list or an enum cannot say', () => {
    const out = normalizeSchema(schema, 'openai-compat') as { properties: Record<string, unknown> } & Record<string, unknown>;
    expect(out.$defs).toBeUndefined();
    expect(out.$schema).toBeUndefined();
    expect(out.properties.when).toEqual({
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from'],
      description: 'the time range',
    });
    expect(out.properties.label).toEqual({ type: 'string' });
    expect(out.properties.id).toEqual({ type: ['string', 'integer'] });
    expect(out.properties.mode).toEqual({ enum: ['fast', 'slow'] });
    // both shapes stay. the first shape alone would refuse a list of addresses.
    expect(out.properties.target).toEqual({
      anyOf: [{ type: 'object', properties: { email: { type: 'string' } } }, { type: 'array', items: { type: 'string' } }],
    });
    expect(out.properties.tree).toEqual({ type: 'object', properties: { child: { description: 'any value' } } });
    expect(out.properties.both).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'] });
    expect(JSON.stringify(out)).not.toMatch(/\$ref|oneOf|allOf/);
  });

  it('keeps every schedule kind of automations_create valid', () => {
    const registry = createToolRegistry(createAutomationTools({ db: openDb(':memory:'), replan: () => {} }));
    const plain = z.fromJSONSchema(normalizeSchema(registry.specs(['automations_create'])[0]!.inputSchema, 'openai-compat'));
    const payload = { type: 'agent', prompt: 'Ask for my goals.' };
    for (const schedule of [
      { kind: 'cron', expr: '0 19 * * *' },
      { kind: 'every', everyMs: 3_600_000 },
      { kind: 'at', at: '2026-10-14T19:00:00-07:00' },
    ]) {
      expect(plain.safeParse({ name: 'goals', schedule, payload }).success).toBe(true);
    }
  });
});

describe('schema normalization of hostile schemas', () => {
  it('keeps a schema whose references double at each level within the node budget', () => {
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) defs[`d${i}`] = { type: 'object', properties: { l: { $ref: `#/$defs/d${i + 1}` }, r: { $ref: `#/$defs/d${i + 1}` } } };
    defs.d30 = { type: 'string' };
    const start = performance.now();
    const out = normalizeSchema({ type: 'object', properties: { root: { $ref: '#/$defs/d0' } }, $defs: defs }, 'openai-compat');
    expect(performance.now() - start).toBeLessThan(500);
    expect(JSON.stringify(out).length).toBeLessThan(200_000);
    expect(JSON.stringify(out)).toContain('too large');
  });

  it('cuts a deep schema instead of overflowing the stack', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20_000; i++) deep = { type: 'object', properties: { x: deep } };
    expect(JSON.stringify(normalizeSchema(deep, 'openai-compat'))).toContain('too deep');
  });

  it('gives the same bytes for the same schema, so the tools parameter stays stable', () => {
    expect(JSON.stringify(normalizeSchema(schema, 'openai-compat'))).toBe(JSON.stringify(normalizeSchema(structuredClone(schema), 'openai-compat')));
  });
});
