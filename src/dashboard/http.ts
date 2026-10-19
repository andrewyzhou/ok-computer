import type { Context } from 'hono';
import type { z } from 'zod';

// readBody reads the json body of a request with a schema. it gives undefined for a body that is not json or does not
// match, and the route answers 400. the auth middleware of server.ts already refused a write that is not json.
export async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
}
