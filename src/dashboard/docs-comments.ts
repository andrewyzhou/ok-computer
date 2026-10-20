import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { DOC_NOT_FOUND, VERSION_NOT_FOUND } from '../docs/comments.js';
import type { DashboardDeps } from './server.js';

// the comment routes of the docs: POST /api/docs/:id/comments (docs/API.md, T4). docs.ts mounts this module, so the
// comment routes stay apart from the routes that read and export a doc. server.ts already answered
// 401 without a sign-in and 415 for a write without a json body.

// the body checks only the types. add trims the text and the quote before it checks their lengths, so a text of
// spaces is empty and the length errors name the limits of comments.ts.
const commentBody = z
  .object({
    text: z.string({ error: 'give text as the text of the comment' }),
    version: z
      .number({ error: 'give version as the number of the version that you read' })
      .int('give version as a whole number from 1')
      .min(1, 'give version as a whole number from 1'),
    quote: z.string({ error: 'give quote as text, or leave it out' }).optional(),
  })
  .strict();

// the first sentence that zod gives, as in inbox.ts. a key that the schema does not know gets its own sentence.
const firstError = (error: z.ZodError) => {
  const issue = error.issues[0];
  if (!issue) return 'the request is not valid';
  if (issue.code === 'unrecognized_keys') return `leave out ${issue.keys.join(', ')}, because this request does not take it`;
  return issue.message;
};

// a path id is a positive whole number. anything else names no doc.
const idOf = (c: Context): number | undefined => {
  const raw = c.req.param('id') ?? '';
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : undefined;
};

export function mountDocComments(server: Hono, deps: DashboardDeps): void {
  const { app, logger } = deps;

  server.post('/api/docs/:id/comments', async (c) => {
    try {
      const docId = idOf(c);
      if (docId === undefined) return c.json({ error: DOC_NOT_FOUND }, 404);
      const raw: unknown = await c.req.json().catch(() => undefined);
      if (raw === undefined) return c.json({ error: 'send a json object as the body' }, 400);
      const parsed = commentBody.safeParse(raw);
      if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
      const { text, version, quote } = parsed.data;
      const result = app.docs.add({ docId, version, text, ...(quote !== undefined ? { quote } : {}) });
      if (!result.ok) return c.json({ error: result.error }, result.error === DOC_NOT_FOUND || result.error === VERSION_NOT_FOUND ? 404 : 400);
      logger.info('the owner commented on a doc', { docId, commentId: result.value.id });
      return c.json(result.value, 201);
    } catch (err) {
      logger.error('doc comment failed', { docId: c.req.param('id'), err });
      return c.json({ error: 'the comment could not be saved' }, 500);
    }
  });
}
