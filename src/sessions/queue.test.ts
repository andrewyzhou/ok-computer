import { describe, expect, it } from 'vitest';
import { createRunQueue } from './queue.js';

describe('run queue', () => {
  it('keeps going after a failed task', async () => {
    const queue = createRunQueue();
    const failed = queue.enqueue('main', async () => {
      throw new Error('bad');
    });
    const next = queue.enqueue('main', async () => 'ok');
    await expect(failed).rejects.toThrow('bad');
    await expect(next).resolves.toBe('ok');
  });

  it('runs different sessions in parallel and drains all of them', async () => {
    const queue = createRunQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const done: string[] = [];
    void queue.enqueue('a', async () => {
      await gate;
      done.push('a');
    });
    await queue.enqueue('b', async () => done.push('b'));
    expect(done).toEqual(['b']);
    release();
    await queue.drain();
    expect(done).toEqual(['b', 'a']);
  });
});
