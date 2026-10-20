import { describe, expect, it } from 'vitest';
import { listEvents } from '../src/events/log.js';
import { fakeResponse, textStep } from '../src/models/fake.js';
import { createTestApp } from './app-harness.js';
import { seedDocs } from './docs-seed.js';
import { pdt } from './seed.js';

describe('a doc comment in the app', () => {
  it('lands after the active run of main and reaches the next model call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = createTestApp(
      [
        async () => {
          await gate;
          return fakeResponse({ text: 'Here is the plan.' });
        },
        textStep('I will move the dinner.'),
      ],
      { start: pdt('09:00') },
    );
    await t.app.start();
    // the seed comes after the start, so its two waiting comments are not sent.
    const { tripId } = seedDocs(t.db);
    await t.type('plan my trip');
    expect(t.model.calls).toHaveLength(1);

    const added = t.app.docs.add({ docId: tripId, version: 3, text: 'Move the dinner on Friday to 20:00.\nThe rooftop closes early.' });
    expect(added).toMatchObject({ ok: true, value: { eventId: null } });
    await new Promise((resolve) => setImmediate(resolve));
    // the run still waits on the model, so the comment has no event yet.
    expect(listEvents(t.db, 'main').some((each) => each.type === 'system_event')).toBe(false);

    release();
    await t.settle();
    const events = listEvents(t.db, 'main');
    const comment = events.findIndex((each) => each.type === 'system_event');
    const runId = events.find((each) => each.type === 'user_message')!.runId;
    expect(comment).toBeGreaterThan(-1);
    expect(events[comment]!.runId).toBeNull();
    expect(events.findLastIndex((each) => each.runId === runId)).toBeLessThan(comment);

    await t.say('what do you think?');
    expect(t.model.calls).toHaveLength(2);
    const sent = JSON.stringify(t.model.calls[1]!.messages);
    expect(sent).toContain('Move the dinner on Friday to 20:00.\\nThe rooftop closes early.');
    expect(sent).toContain(`The owner commented on doc #${tripId}, version 3.`);
    expect(sent).not.toContain('Trip plan: Lisbon');
    expect(t.printed()).toContain('I will move the dinner.');
    await t.app.stop();
  });
});
