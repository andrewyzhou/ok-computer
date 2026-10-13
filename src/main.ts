import { join } from 'node:path';
import { createApp } from './app.js';
import { createCliChannel } from './channels/cli.js';
import { loadConfig, loadDotEnv, loadSecrets } from './config/load.js';
import { openDb } from './db/index.js';
import { createClients } from './models/clients.js';
import { createLogger } from './observability/logger.js';
import { registerSecret } from './observability/redact.js';
import { systemClock } from './time.js';

async function main(): Promise<void> {
  // in chat mode the terminal shows only warnings and errors from the log, so the chat stays readable.
  const chatMode = process.argv.includes('--chat');

  loadDotEnv();
  const loaded = loadConfig();
  if (!loaded.ok) {
    console.error(loaded.error);
    process.exit(1);
  }
  const config = loaded.value;
  const secrets = loadSecrets();
  Object.values(secrets).forEach(registerSecret);

  const logger = createLogger({ dir: join(config.paths.data, 'logs'), consoleLevel: chatMode ? 'warn' : 'info' });
  const clients = createClients(config, secrets);
  if (!clients.ok) {
    logger.error('model setup failed', { error: clients.error });
    process.exit(1);
  }
  const db = openDb(join(config.paths.data, 'okc.sqlite'));

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { reason });
    await app.stop();
    db.close();
    process.exit(0);
  };

  // when piped input ends, the runs that it started finish before the process stops.
  const cli = createCliChannel({ onClose: () => void app.idle().then(() => stop('cli input ended')) });
  const app = createApp({ config, db, logger, clients: clients.value, channels: [cli], clock: systemClock });
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  await app.start();
  if (chatMode) process.stdout.write('ok computer is ready. type a message, /new for a fresh session, ctrl+c to quit.\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
