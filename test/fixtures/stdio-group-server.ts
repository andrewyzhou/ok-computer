import { spawn } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createTestServer } from '../mcp-server.js';

// this server starts a stubborn helper, as a wrapper such as npx or a shell does. the helper ignores SIGTERM and the
// end of stdin, and it keeps the pipes of the server open, so only a SIGKILL to the group ends it.
const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"], { stdio: 'inherit' });
// the server itself ends at the end of stdin. the helper does not keep it alive.
helper.unref();
process.stderr.write(`group server ready pid ${process.pid} helper ${helper.pid}\n`);
// a server that ignores SIGTERM only ends with SIGKILL.
if (process.argv.includes('--ignore-term')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
}
// a server that exits by itself leaves the helper behind.
const exitAt = process.argv.indexOf('--exit-after');
if (exitAt !== -1) setTimeout(() => process.exit(0), Number(process.argv[exitAt + 1]));
await createTestServer().connect(new StdioServerTransport());
