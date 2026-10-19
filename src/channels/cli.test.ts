import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cliWanted, createCliChannel } from './cli.js';
import type { InboundMessage } from './types.js';

describe('cli channel', () => {
  it('shows buttons as numbered choices and turns a number into a button press one time', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = '';
    output.on('data', (chunk: Buffer) => (printed += chunk.toString()));
    const received: InboundMessage[] = [];
    const cli = createCliChannel({ input, output });
    await cli.start((message) => received.push(message));

    await cli.send({
      chatId: 'local',
      text: 'Approval needed (#1)',
      buttons: [[{ text: 'Approve', data: 'approval:1:approve' }, { text: 'Deny', data: 'approval:1:deny' }]],
    });
    expect(printed).toContain('okc> Approval needed (#1)\n  1. Approve\n  2. Deny\n');

    input.write('2\n2\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(received.map((m) => [m.text, m.button])).toEqual([
      ['2', 'approval:1:deny'],
      ['2', undefined],
    ]);
    await cli.stop();
  });

  it('removes the choices when a later message has no buttons', async () => {
    const input = new PassThrough();
    const received: InboundMessage[] = [];
    const cli = createCliChannel({ input, output: new PassThrough() });
    await cli.start((message) => received.push(message));
    await cli.send({ chatId: 'local', text: 'Approval needed (#3)', buttons: [[{ text: 'Approve', data: 'approval:3:approve' }]] });
    await cli.send({ chatId: 'local', text: 'How many goals, 1 or 2?' });

    input.write('1\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(received.map((m) => [m.text, m.button])).toEqual([['1', undefined]]);
    await cli.stop();
  });
});

describe('when the cli runs', () => {
  const base = { chatMode: false, telegram: false, service: false, tty: false };

  it('runs no cli in a service, also without telegram, because its stdin ends at once', () => {
    expect(cliWanted({ ...base, service: true })).toBe(false);
    expect(cliWanted({ ...base, service: true, tty: true })).toBe(false);
  });

  it('runs the cli for npm run chat, also in a service', () => {
    expect(cliWanted({ ...base, chatMode: true, service: true, telegram: true })).toBe(true);
  });

  it('runs the cli outside a service when telegram is off or a terminal is attached', () => {
    expect(cliWanted(base)).toBe(true);
    expect(cliWanted({ ...base, telegram: true, tty: true })).toBe(true);
    expect(cliWanted({ ...base, telegram: true })).toBe(false);
  });
});
