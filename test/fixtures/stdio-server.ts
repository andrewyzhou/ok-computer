import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createTestServer } from '../mcp-server.js';

process.stderr.write(`test server ready pid ${process.pid}\n`);
// a stubborn server keeps a timer, so the end of stdin does not end it. many real servers behave like this.
if (process.argv.includes('--stubborn')) setInterval(() => {}, 1_000);
// a noisy server writes many stderr lines at the start.
if (process.argv.includes('--noisy')) for (let i = 0; i < 500; i++) process.stderr.write(`noise ${i}\n`);
await createTestServer().connect(new StdioServerTransport());
