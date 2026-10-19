import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot } from 'grammy';
import { createApp } from './app.js';
import { cliWanted, createCliChannel } from './channels/cli.js';
import { createTelegramChannel, TELEGRAM } from './channels/telegram.js';
import type { ChannelAdapter } from './channels/types.js';
import { createWebChannel } from './channels/web.js';
import { loadConfig, loadDotEnv, loadSecrets } from './config/load.js';
import { openDb } from './db/index.js';
import { createLoginCodes } from './dashboard/login.js';
import { startDashboard, type RunningDashboard } from './dashboard/server.js';
import { loadIntegrations } from './integrations/config.js';
import { createClients } from './models/clients.js';
import { exitOnFatal, exitOnUncaught, exitWhenIdle } from './exit.js';
import { holdInstanceLock } from './instance.js';
import { createLogger, pruneLogs, type Logger } from './observability/logger.js';
import { registerSecret } from './observability/redact.js';
import { loadPolicy } from './policy/policy.js';
import { createSecretVault } from './secrets/index.js';
import { systemClock } from './time.js';

// the handlers of a fatal error use the logger once it exists.
let fatalLogger: Logger | undefined;

async function main(): Promise<void> {
  exitOnUncaught(() => fatalLogger);
  const chatMode = process.argv.includes('--chat');

  loadDotEnv();
  const loaded = loadConfig();
  if (!loaded.ok) {
    exitOnFatal(loaded.error);
  }
  const config = loaded.value;
  const rules = loadPolicy();
  if (!rules.ok) {
    exitOnFatal(rules.error);
  }
  const integrations = loadIntegrations();
  if (!integrations.ok) {
    exitOnFatal(integrations.error);
  }
  const { telegramOwnerId, ...secrets } = loadSecrets();
  Object.values(secrets).forEach((value) => registerSecret(value));

  // the terminal shows only warnings and errors, so the chat stays readable. the supervisor keeps stderr in a file, and
  // the log file has every line.
  const logDir = join(config.paths.data, 'logs');
  const logger = createLogger({ dir: logDir, consoleLevel: 'warn' });
  fatalLogger = logger;
  pruneLogs(logDir, new Date());
  // one process runs the scheduler and the telegram polling on a database. npm run chat runs neither, so it needs no
  // lock and works next to the service.
  if (!chatMode && !(await holdInstanceLock(config.paths.data))) {
    exitOnFatal(new Error(`another ok computer process runs on the data folder ${config.paths.data}. stop it first, for example with okc stop.`), logger);
  }
  const clients = createClients(config, secrets);
  if (!clients.ok) {
    logger.error('model setup failed', { error: clients.error });
    process.exit(1);
  }
  const db = openDb(join(config.paths.data, 'okc.sqlite'));

  let dashboard: RunningDashboard | undefined;
  let stopping = false;
  const stop = async (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { reason });
    await dashboard?.close();
    await app.stop();
    db.close();
    exitWhenIdle(code);
  };

  const channels: ChannelAdapter[] = [];
  const ownerIds: Record<string, string> = {};
  // npm run chat is the cli only. without a token or an owner id, telegram does not start and the cli still runs.
  if (!chatMode && secrets.telegramBotToken && telegramOwnerId) {
    // a new start polls again. the supervisor waits longer after each quick stop, so a wrong token does not loop fast.
    const onPollingFailed = () => void stop('telegram polling stopped', 1);
    channels.push(createTelegramChannel({ bot: new Bot(secrets.telegramBotToken), ownerId: telegramOwnerId, logger, onPollingFailed }));
    ownerIds[TELEGRAM] = telegramOwnerId;
  } else if (!chatMode) {
    logger.info('telegram is off, because TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID is not set');
  }
  const telegram = channels.length > 0;
  let inputEnded = false;
  const stopAfterInput = () => void app.idle().then(() => stop('cli input ended'));
  // the web chat lives in the dashboard, and npm run chat runs no dashboard. the web chat runs the main session as the
  // owner, and a dashboard without a token lets each local request in, so the web chat needs the token.
  const web = !chatMode && Boolean(secrets.dashboardToken);
  if (!chatMode && !web) logger.info('the web chat is off, because DASHBOARD_TOKEN is not set');
  // the web chat can be reached only while its dashboard runs. it is false after the dashboard did not start.
  let webReachable = web;
  // a service has no terminal, so its stdin ends at once. see cliWanted.
  const service = process.env.OKC_SERVICE === '1';
  if (cliWanted({ chatMode, telegram, service, tty: Boolean(process.stdin.isTTY) })) {
    // when piped input ends, the runs that it started finish before the process stops. telegram keeps the process up,
    // and so does the web chat, unless its dashboard did not start (see below).
    const onClose = () => {
      inputEnded = true;
      if (telegram || webReachable) logger.info('cli input ended');
      else stopAfterInput();
    };
    channels.push(createCliChannel({ onClose }));
  }
  if (web) channels.push(createWebChannel({ clock: systemClock, logger }));
  // the sign-in codes live in the process that runs the dashboard. npm run chat runs no dashboard.
  // the secrets block of the config chooses the store: the keyring on a desktop, a file or aws on a server.
  const vault = createSecretVault(config.secrets);
  const loginCodes = !chatMode && secrets.dashboardToken && config.dashboard.publicUrl ? createLoginCodes(systemClock) : undefined;
  const app = createApp({
    config,
    db,
    logger,
    clients: clients.value,
    channels,
    ownerIds,
    clock: systemClock,
    rules: rules.value,
    policyPath: 'okc.policy.json',
    integrations: integrations.value,
    ...(integrations.value.length || config.google || vault.backend !== 'keyring' ? { secrets: vault.store } : {}),
    secretVault: vault,
    connectIntegrations: !chatMode,
    background: !chatMode,
    ...(loginCodes ? { loginCodes } : {}),
    // the code sandbox finds the docker of this host. without docker the tool is off and the rest runs.
    sandbox: {},
  });
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  await app.start();
  // npm run chat is the cli only. a dashboard that cannot start does not stop the agent.
  if (!chatMode) {
    try {
      const token = secrets.dashboardToken ? { token: secrets.dashboardToken, ...(loginCodes ? { codes: loginCodes } : {}) } : {};
      // okc stop reads this token from the data folder and asks for a graceful stop (see the shutdown request).
      const shutdown = { token: randomBytes(32).toString('hex'), stop: () => void stop('okc stop') };
      dashboard = await startDashboard({ db, config, clock: systemClock, logger, app, port: config.dashboard.port, shutdown, ...token });
      writeFileSync(join(config.paths.data, 'okc.stop-token'), shutdown.token);
      logger.info('dashboard started', { url: `http://127.0.0.1:${dashboard.port}` });
    } catch (err) {
      logger.error('dashboard did not start', { port: config.dashboard.port, err });
      // without a dashboard nobody can reach the web chat, so it does not keep the process up.
      webReachable = false;
      if (!telegram && inputEnded) stopAfterInput();
    }
  }
  if (chatMode) process.stdout.write('ok computer is ready. type a message, /new for a fresh session, ctrl+c to quit.\n');
}

main().catch((err: unknown) => exitOnFatal(err, fatalLogger));
