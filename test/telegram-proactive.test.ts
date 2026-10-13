import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramChannel } from '../src/channels/telegram.js';
import { textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { silentLogger } from '../src/observability/logger.js';
import { setChecklist } from '../src/scheduler/heartbeat.js';
import { createTestApp } from './app-harness.js';
import { createFakeTelegram, textUpdate, until } from './fake-telegram.js';

const OWNER = 777;
const pdt = (time: string) => new Date(`2026-10-12T${time}:00-07:00`).toISOString();

// the model writes markdown in each message that it sends to the owner on its own, so each goes out as rich text.
function setup(steps: FakeStep[], config: Record<string, unknown> = {}) {
  const telegram = createFakeTelegram();
  const t = createTestApp(steps, {
    start: pdt('09:00'),
    config,
    deps: {
      channels: [createTelegramChannel({ bot: telegram.bot, ownerId: String(OWNER), logger: silentLogger, clock: () => t.clock() })],
      ownerIds: { telegram: String(OWNER) },
    },
  });
  const rich = () => telegram.calls.filter((c) => c.method === 'sendRichMessage').map((c) => (c.payload.rich_message as { markdown: string }).markdown);
  return { ...t, telegram, rich };
}

const apps: Array<{ app: { stop(): Promise<void> } }> = [];
afterEach(async () => {
  for (const each of apps.splice(0)) await each.app.stop();
});

describe('proactive messages in telegram', () => {
  it('sends the text of message_owner from a background run as markdown', async () => {
    const t = setup([
      toolStep({
        id: 'a1',
        name: 'automations_create',
        input: { name: 'build', schedule: { kind: 'cron', expr: '0 10 * * *' }, payload: { type: 'agent', prompt: 'Tell the owner about the build.' } },
      }),
      textStep('Done.'),
      toolStep({ id: 'm1', name: 'message_owner', input: { text: '**Heads up:** the build is green.' } }),
      textStep('NO_REPLY'),
    ]);
    apps.push(t);
    await t.app.start();
    t.telegram.push(textUpdate(OWNER, 'tell me about the build at 10am'));
    await until(() => t.rich().length === 1);
    await t.app.idle();
    await t.at(pdt('10:00'));
    expect(t.rich()).toEqual(['Done.', '**Heads up:** the build is green.']);
  });

  it('sends a heartbeat notification as markdown', async () => {
    const t = setup(
      [toolStep({ id: 'h1', name: 'heartbeat_respond', input: { notify: true, text: 'Your **essay** ETA passed.' } }), textStep('NO_REPLY')],
      { heartbeat: { every: '30m' } },
    );
    apps.push(t);
    await t.app.start();
    setChecklist(t.db, '- goals with a passed eta', t.clock());
    await t.at(pdt('09:30'));
    expect(t.rich()).toEqual(['Your **essay** ETA passed.']);
  });

  it('sends the text of an isolated automation as markdown', async () => {
    const t = setup([
      toolStep({
        id: 'a1',
        name: 'automations_create',
        input: { name: 'water', schedule: { kind: 'cron', expr: '0 10 * * *' }, payload: { type: 'agent', prompt: 'Remind the owner to drink water.' } },
      }),
      textStep('Done.'),
      textStep('Time to *drink* some water.'),
    ]);
    apps.push(t);
    await t.app.start();
    t.telegram.push(textUpdate(OWNER, 'remind me to drink water at 10am'));
    await until(() => t.rich().length === 1);
    await t.app.idle();
    await t.at(pdt('10:00'));
    expect(t.rich()).toEqual(['Done.', 'Time to *drink* some water.']);
  });
});

describe('proactive messages in telegram from the main session', () => {
  it('sends the reply of an automation in the main session as markdown', async () => {
    const t = setup([
      toolStep({
        id: 'a1',
        name: 'automations_create',
        input: { name: 'plan', schedule: { kind: 'cron', expr: '0 10 * * *' }, sessionMode: 'main', payload: { type: 'agent', prompt: 'Ask for the plan.' } },
      }),
      textStep('Done.'),
      textStep('What is the **plan** for today?'),
    ]);
    apps.push(t);
    await t.app.start();
    t.telegram.push(textUpdate(OWNER, 'ask me for my plan at 10am'));
    await until(() => t.rich().length === 1);
    await t.app.idle();
    await t.at(pdt('10:00'));
    expect(t.rich()).toEqual(['Done.', 'What is the **plan** for today?']);
  });
});
