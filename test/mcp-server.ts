import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

// the test server has a read tool, a write tool, a long result, an error, and a tool that adds a tool. the stdio
// fixture runs the same server in a child process.
// with needsBook, add_note asks for a book too, as a newer version of the server would.
export function createTestServer(options: { needsBook?: boolean } = {}): McpServer {
  const server = new McpServer({ name: 'okc-test-server', version: '1.2.3' });
  server.registerTool(
    'echo',
    { description: 'Echo the text back.', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } },
    async ({ text: value }) => text(value),
  );
  server.registerTool(
    'add_note',
    {
      description: 'Add a note to the shared notebook.',
      inputSchema: z.object({ note: z.string(), tags: z.array(z.string()).optional(), ...(options.needsBook ? { book: z.string() } : {}) }),
    },
    async ({ note }) => text(`saved: ${note}`),
  );
  server.registerTool('long_report', { description: 'Give a long report.' }, async () =>
    text(Array.from({ length: 2000 }, (_, i) => `report line ${i}`).join('\n')),
  );
  server.registerTool('broken', { description: 'Always fails.' }, async () => ({ ...text('the notebook is locked'), isError: true }));
  server.registerTool('hidden_admin', { description: 'Delete every note.' }, async () => text('deleted'));
  server.registerTool('grow', { description: 'Add the calendar tool to this server.' }, async () => {
    server.registerTool(
      'calendar_lookup',
      { description: 'Find calendar events by word.', inputSchema: z.object({ query: z.string() }), annotations: { readOnlyHint: true } },
      async ({ query }) => text(`no events match ${query}`),
    );
    return text('grown');
  });
  server.registerTool(
    'slow',
    { description: 'Answer after a delay.', inputSchema: z.object({ ms: z.number() }) },
    async ({ ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return text(`done after ${ms} ms`);
    },
  );
  server.registerTool('hang', { description: 'Never answer.' }, () => new Promise(() => {}));
  server.registerTool('crash', { description: 'Stop the server process.' }, async () => {
    setTimeout(() => process.exit(1), 10);
    return text('stopping');
  });
  return server;
}
