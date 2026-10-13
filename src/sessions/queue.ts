export interface RunQueue {
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T>;
  // drain waits until every queued task has ended.
  drain(): Promise<void>;
  // busy is true while the session has a task that runs or waits.
  busy(key: string): boolean;
}

// one session runs one task at a time. tasks of different sessions run in parallel.
export function createRunQueue(): RunQueue {
  const tails = new Map<string, Promise<unknown>>();
  return {
    enqueue(key, task) {
      const previous = tails.get(key) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(task);
      const tail = next.catch(() => {});
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return next;
    },
    async drain() {
      while (tails.size) await Promise.all(tails.values());
    },
    busy: (key) => tails.has(key),
  };
}
