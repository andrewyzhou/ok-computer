// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { DelegationForm, NewDelegationPanel, localParts, whenOf } from './DelegationForm';
import { board, delegation, delegations, detail } from './fixtures';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

function stubDesk(extra: StubRoutes = {}) {
  const posts: Array<{ url: string; body: unknown }> = [];
  stubFetch(seeded.dashboard, {
    'GET /api/desk': () => board(),
    'GET /api/desk/delegations/:id': ({ params }) => detail(Number(params.id)),
    'POST /api/desk/delegations': ({ body }) => {
      posts.push({ url: '/api/desk/delegations', body });
      return json(delegation(9, { title: 'New one', createdBy: 'owner' }), 201);
    },
    'POST /api/desk/delegations/:id': ({ params, body }) => {
      posts.push({ url: `/api/desk/delegations/${params.id}`, body });
      return delegation(Number(params.id));
    },
    ...extra,
  });
  return posts;
}

function renderCreate() {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(<DelegationForm mode="create" onDone={onDone} onCancel={onCancel} />);
  return { onDone, onCancel };
}

function renderEdit(id: number) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const found = delegations.find((each) => each.id === id)!;
  render(<DelegationForm mode="edit" delegation={found} onDone={onDone} onCancel={onCancel} />);
  return { onDone, onCancel };
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('the delegation form', () => {
  it('creates a delegation with every field, a due day alone and a follow-up with a time', async () => {
    const posts = stubDesk();
    const { onDone } = renderCreate();
    type('Title', '  Book the Denver hotel  ');
    type('Details', 'Two nights near the venue.\nA quiet room.');
    type('Next step', 'Compare three hotels');
    type('Waiting on, name', 'Sam Lee');
    type('Waiting on, email', 'sam@example.com');
    type('Due', '2030-12-01');
    type('Follow-up', '2030-11-20');
    type('Follow-up, time', '10:30');
    submit('Create delegation');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone.mock.calls[0]![0]).toMatchObject({ id: 9, title: 'New one' });
    expect(posts).toEqual([
      {
        url: '/api/desk/delegations',
        body: {
          title: 'Book the Denver hotel',
          details: 'Two nights near the venue.\nA quiet room.',
          nextStep: 'Compare three hotels',
          waitingOn: { name: 'Sam Lee', email: 'sam@example.com' },
          dueAt: '2030-12-01',
          nextFollowUpAt: new Date('2030-11-20T10:30').toISOString(),
        },
      },
    ]);
    // the test runs in los angeles, so 10:30 there in november is 18:30 in utc.
    expect(new Date('2030-11-20T10:30').toISOString()).toBe('2030-11-20T18:30:00.000Z');
  });

  it('sends a due day with a time as an exact time, a follow-up day alone as the day, and only the filled fields', async () => {
    const posts = stubDesk();
    renderCreate();
    type('Title', 'Renew the parking permit');
    type('Waiting on, email', 'permits@city.example');
    type('Due', '2030-06-15');
    type('Due, time', '17:00');
    type('Follow-up', '2030-06-10');
    submit('Create delegation');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({
      title: 'Renew the parking permit',
      waitingOn: { email: 'permits@city.example' },
      dueAt: '2030-06-16T00:00:00.000Z',
      nextFollowUpAt: '2030-06-10',
    });
  });

  it('shows the client errors by their fields and sends nothing', async () => {
    const posts = stubDesk();
    renderCreate();
    submit('Create delegation');
    expect(screen.getByText('Give the delegation a title.')).toBeTruthy();
    expect(screen.getByLabelText('Title').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Title'));

    type('Title', 'Ask about the deposit');
    expect(screen.queryByText('Give the delegation a title.')).toBeNull();
    type('Waiting on, email', 'dana at landlord');
    type('Follow-up', '2020-01-01');
    type('Follow-up, time', '09:00');
    type('Next step', 'x'.repeat(501));
    submit('Create delegation');
    expect(screen.getByText('Give one email address, like name@example.com.')).toBeTruthy();
    expect(screen.getByText('The follow-up time is in the past.')).toBeTruthy();
    expect(screen.getByText('This can have at most 500 characters.')).toBeTruthy();
    expect(screen.getByText('501/500')).toBeTruthy();

    type('Waiting on, email', 'two@example.com, three@example.com');
    submit('Create delegation');
    expect(screen.getByText('Give one email address, like name@example.com.')).toBeTruthy();

    // a follow-up day alone is in the past only before today.
    type('Follow-up, time', '');
    type('Follow-up', localParts(new Date(Date.now() - 86_400_000).toISOString()).date);
    submit('Create delegation');
    expect(screen.getByText('The follow-up time is in the past.')).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it('needs a person or an email for a waiting delegation', async () => {
    const posts = stubDesk();
    renderEdit(1);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'waiting' } });
    submit('Save changes');
    expect(screen.getByText('A waiting delegation needs a person or an email.')).toBeTruthy();
    type('Waiting on, name', 'Sam');
    expect(screen.queryByText('A waiting delegation needs a person or an email.')).toBeNull();
    submit('Save changes');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/desk/delegations/1', body: { waitingOn: { name: 'Sam' }, status: 'waiting' } });
  });

  it('offers all five statuses in an edit only', () => {
    stubDesk();
    renderEdit(2);
    const options = within(screen.getByRole('combobox')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Open', 'Waiting', 'Needs you', 'Done', 'Dropped']);
    cleanup();
    renderCreate();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('prefills an edit in the local time of the browser and sends only the changed fields, with null for a cleared one', async () => {
    const posts = stubDesk();
    const { onDone } = renderEdit(2);
    const two = delegations.find((each) => each.id === 2)!;
    const due = localParts(two.dueAt);
    expect((screen.getByLabelText('Due') as HTMLInputElement).value).toBe(due.date);
    expect((screen.getByLabelText('Due, time') as HTMLInputElement).value).toBe(due.time);
    // the fixture is due at 01:00 utc on oct 18, which is 18:00 on oct 17 in los angeles.
    expect(due).toEqual({ date: '2026-10-17', time: '18:00' });
    expect((screen.getByLabelText('Waiting on, email') as HTMLInputElement).value).toBe('dana@landlord.example');

    // a submit with no change sends an empty body, which the server answers without a history row.
    submit('Save changes');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({});

    type('Title', 'Get the signed lease from Dana');
    type('Next step', '   ');
    type('Due', '');
    type('Due, time', '');
    type('Details', 'She is back on Monday.');
    submit('Save changes');
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({
      url: '/api/desk/delegations/2',
      body: { title: 'Get the signed lease from Dana', details: 'She is back on Monday.', nextStep: null, dueAt: null },
    });
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it('sends null for waiting on when both parts are cleared, and the new time of a changed follow-up', async () => {
    const posts = stubDesk();
    renderEdit(2);
    type('Waiting on, name', '');
    type('Waiting on, email', '');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'open' } });
    type('Follow-up', '2030-01-05');
    type('Follow-up, time', '08:15');
    submit('Save changes');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ waitingOn: null, nextFollowUpAt: whenOf('2030-01-05', '08:15'), status: 'open' });
    expect(whenOf('2030-01-05', '08:15')).toBe('2030-01-05T16:15:00.000Z');
  });

  it('keeps an old follow-up of an edit that the owner did not touch', async () => {
    const posts = stubDesk();
    // delegation 3 has a follow-up an hour in the past of the fixture time, which is before today.
    renderEdit(3);
    type('Title', 'Reschedule the dentist for next week');
    submit('Save changes');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ title: 'Reschedule the dentist for next week' });
  });

  it('shows the text of a server 400 at the top and keeps the input', async () => {
    stubDesk({ 'POST /api/desk/delegations': () => json({ error: 'a thread or event link needs its account' }, 400) });
    const { onDone } = renderCreate();
    type('Title', 'Find the receipts');
    const button = screen.getByRole('button', { name: 'Create delegation' });
    submit('Create delegation');
    expect(screen.getByRole('button', { name: 'Saving…' }).getAttribute('aria-busy')).toBe('true');
    expect((await screen.findByRole('alert')).textContent).toBe('a thread or event link needs its account');
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Find the receipts');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows the text of a 409 of an edit', async () => {
    stubDesk({ 'POST /api/desk/delegations/:id': () => json({ error: 'delegation #5 is done, so it takes no follow-up time' }, 409) });
    renderEdit(5);
    type('Follow-up', '2030-02-01');
    submit('Save changes');
    expect((await screen.findByRole('alert')).textContent).toBe('delegation #5 is done, so it takes no follow-up time');
  });

  it('submits with a form submit, as Enter in a single-line field does', async () => {
    const posts = stubDesk();
    renderCreate();
    type('Title', 'Call the bank');
    fireEvent.submit(screen.getByRole('form', { name: 'New delegation' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ title: 'Call the bank' });
  });

  it('cancels with Escape and with the cancel button', () => {
    stubDesk();
    const { onCancel } = renderCreate();
    fireEvent.keyDown(screen.getByLabelText('Title'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('renders the create form in the details panel', async () => {
    const posts = stubDesk();
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(<NewDelegationPanel onDone={onDone} onCancel={onCancel} />);
    const panel = within(screen.getByRole('complementary', { name: 'details' }));
    expect(panel.getByRole('heading', { name: 'New delegation' })).toBeTruthy();
    expect(document.activeElement).toBe(panel.getByLabelText('Title'));
    fireEvent.change(panel.getByLabelText('Title'), { target: { value: 'Order the textbooks' } });
    fireEvent.click(panel.getByRole('button', { name: 'Create delegation' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([{ url: '/api/desk/delegations', body: { title: 'Order the textbooks' } }]);
    fireEvent.click(panel.getByRole('button', { name: 'Close details' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('the create form on the desk page', () => {
  it('opens for #/desk?new=1 and goes to the new delegation when it is made', async () => {
    const posts = stubDesk();
    openApp('#/desk?new=1');
    const details = within(document.querySelector('.details') as HTMLElement);
    expect(await details.findByRole('heading', { name: 'New delegation' })).toBeTruthy();
    fireEvent.change(details.getByLabelText('Title'), { target: { value: 'Order the textbooks' } });
    fireEvent.click(details.getByRole('button', { name: 'Create delegation' }));
    await waitFor(() => expect(location.hash).toBe('#/desk?id=9'));
    expect(posts).toEqual([{ url: '/api/desk/delegations', body: { title: 'Order the textbooks' } }]);
  });
});
