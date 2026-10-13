import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createTestServer } from '../mcp-server.js';

process.stderr.write('test server ready\n');
await createTestServer().connect(new StdioServerTransport());
