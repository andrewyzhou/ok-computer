import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCliChannel } from './cli.js';
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
