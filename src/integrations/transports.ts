import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { StreamableHTTPClientTransport, type OAuthClientProvider, type Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Logger } from '../observability/logger.js';
import type { HttpEntry, StdioEntry } from './config.js';
import type { SecretStore } from './secrets.js';

// the child process gets the safe default variables and the variables of its entry. it does not get the secrets of
// this process, for example the api keys in .env.
export async function stdioTransport(entry: StdioEntry, secrets: SecretStore, logger: Logger): Promise<Transport> {
  const env: Record<string, string> = getDefaultEnvironment();
  for (const [name, value] of Object.entries(entry.env)) {
    if (typeof value === 'string') {
      env[name] = value;
      continue;
    }
    const secret = await secrets.get(value.secretRef);
    if (secret === undefined) throw new Error(`the secret ${value.secretRef} for ${name} is not in the credential manager`);
    env[name] = secret;
  }
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    stderr: 'pipe',
  });
  const stderr = transport.stderr as Readable | null;
  if (stderr) {
    createInterface({ input: stderr }).on('line', (line) => logger.info('mcp server stderr', { integration: entry.id, line }));
  }
  return transport;
}

export async function httpTransport(
  entry: HttpEntry,
  secrets: SecretStore,
  oauth: (entry: HttpEntry) => OAuthClientProvider,
): Promise<Transport> {
  const url = new URL(entry.url);
  if (entry.auth?.type === 'oauth') return new StreamableHTTPClientTransport(url, { authProvider: oauth(entry) });
  if (entry.auth?.type === 'bearer') {
    const token = await secrets.get(entry.auth.secretRef);
    if (token === undefined) throw new Error(`the secret ${entry.auth.secretRef} is not in the credential manager`);
    return new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  }
  return new StreamableHTTPClientTransport(url);
}
