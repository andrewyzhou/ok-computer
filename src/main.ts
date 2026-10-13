import { join } from 'node:path';
import { Bot } from 'grammy';
import { createApp } from './app.js';
import { createCliChannel } from './channels/cli.js';
import { createTelegramChannel, TELEGRAM } from './channels/telegram.js';
import type { ChannelAdapter } from './channels/types.js';
import { loadConfig, loadDotEnv, loadSecrets } from './config/load.js';
import { openDb } from './db/index.js';
import { startDashboard, type RunningDashboard } from './dashboard/server.js';
import { loadIntegrations } from './integrations/config.js';
import { createKeyringStore } from './integrations/secrets.js';
import { createClients } from './models/clients.js';
import { createLogger } from './observability/logger.js';
import { registerSecret } from './observability/redact.js';
import { loadPolicy } from './policy/policy.js';
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
  const rules = loadPolicy();
  if (!rules.ok) {
    console.error(rules.error);
    process.exit(1);
  }
  const integrations = loadIntegrations();
  if (!integrations.ok) {
    console.error(integrations.error);
    process.exit(1);
  }
  const { telegramOwnerId, ...secrets } = loadSecrets();
  Object.values(secrets).forEach((value) => registerSecret(value));

  const logger = createLogger({ dir: join(config.paths.data, 'logs'), consoleLevel: chatMode ? 'warn' : 'info' });
  const clients = createClients(config, secrets);
  if (!clients.ok) {
    logger.error('model setup failed', { error: clients.error });
    process.exit(1);
  }
  const db = openDb(join(config.paths.data, 'okc.sqlite'));

  let dashboard: RunningDashboard | undefined;
  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { reason });
    await dashboard?.close();
    await app.stop();
    db.close();
    process.exit(0);
  };

  const channels: ChannelAdapter[] = [];
  const ownerIds: Record<string, string> = {};
  // npm run chat is the cli only. without a token or an owner id, telegram does not start and the cli still runs.
  if (!chatMode && secrets.telegramBotToken && telegramOwnerId) {
    channels.push(createTelegramChannel({ bot: new Bot(secrets.telegramBotToken), logger }));
    ownerIds[TELEGRAM] = telegramOwnerId;
  } else if (!chatMode) {
    logger.info('telegram is off, because TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID is not set');
  }
  const telegram = channels.length > 0;
  // a service has no terminal. the cli then runs only when no other channel runs.
  if (chatMode || !telegram || process.stdin.isTTY) {
    // when piped input ends, the runs that it started finish before the process stops. telegram keeps the process up.
    const onClose = () => (telegram ? logger.info('cli input ended') : void app.idle().then(() => stop('cli input ended')));
    channels.push(createCliChannel({ onClose }));
  }
  const app = createApp({
    config,
    db,
    logger,
    clients: clients.value,
    channels,
    ownerIds,
    clock: systemClock,
    rules: rules.value,
    integrations: integrations.value,
    ...(integrations.value.length ? { secrets: createKeyringStore() } : {}),
    connectIntegrations: !chatMode,
    background: !chatMode,
  });
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  await app.start();
  // npm run chat is the cli only. a dashboard that cannot start does not stop the agent.
  if (!chatMode) {
    try {
      const token = secrets.dashboardToken ? { token: secrets.dashboardToken } : {};
      dashboard = await startDashboard({ db, config, clock: systemClock, logger, app, port: config.dashboard.port, ...token });
      logger.info('dashboard started', { url: `http://127.0.0.1:${dashboard.port}` });
    } catch (err) {
      logger.error('dashboard did not start', { port: config.dashboard.port, err });
    }
  }
  if (chatMode) process.stdout.write('ok computer is ready. type a message, /new for a fresh session, ctrl+c to quit.\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
