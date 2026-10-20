// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationDetail } from '../../../../src/dashboard/desk-types';
import { seedDashboard } from '../../../../test/seed';
import { installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { DelegationPanel, eventSummary } from './Details';
import { board, delegation, detail } from './fixtures';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await seeded.t.app.stop();
});

// the desk routes as stubs: the board, the detail of each fixture id, a 404 for 999, and the writes, whose bodies
// go into posts. a test gives other routes in extra, which replace these.
function stubDesk(extra: StubRoutes = {}) {
  const posts: unknown[] = [];
  const calls = stubFetch(seeded.dashboard, {
    'GET /api/desk': () => board(),
    'GET /api/desk/delegations/:id': ({ params }) => (params.id === '999' ? json({ error: 'delegation not found' }, 404) : detail(Number(params.id))),
    'POST /api/desk/delegations/:id': ({ params, body }) => {
      posts.push(body);
      return delegation(Number(params.id));
    },
    ...extra,
  });
  const detailLoads = (id: number) => calls.filter((call) => call.method === 'GET' && call.url === `/api/desk/delegations/${id}`).length;
  return { posts, calls, detailLoads };
}

function renderPanel(id: number) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<DelegationPanel id={id} onClose={onClose} onChanged={onChanged} />);
  const panel = () => within(screen.getByRole('complementary', { name: 'details' }));
  return { onClose, onChanged, panel };
}

const historyKinds = () => [...document.querySelectorAll('.desk-history-kind')].map((node) => node.textContent);
const historyActors = () => [...document.querySelectorAll('.desk-history-row')].map((row) => row.querySelector('.desk-history-actor')?.textContent ?? null);

describe('the details panel of a delegation', () => {
  it('shows the facts, the links, the nudge with the never-sent note and the history oldest first', async () => {
    stubDesk();
    const { panel } = renderPanel(2);
    expect(await panel().findByRole('heading', { name: 'Get the lease renewal from Dana' })).toBeTruthy();
    const facts = document.querySelector('.facts-stacked') as HTMLElement;
    const factText = [...facts.querySelectorAll('.fact')].map((fact) => `${fact.querySelector('dt')!.textContent}: ${fact.querySelector('dd')!.textContent}`);
    expect(factText[0]).toBe('Status: Waiting');
    expect(factText).toContain('Waiting on: Dana Park · dana@landlord.example');
    expect(factText).toContain('Nudges: 1');
    expect(factText.map((each) => each.split(':')[0])).toEqual(['Status', 'Waiting on', 'Waiting since', 'Due', 'Next follow-up', 'Last checked', 'Nudges', 'Created']);
    expect(factText.at(-1)).toMatch(/^Created: by ok computer, /);
    // the email is plain text and never a mail link.
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(panel().getByText("Wait for Dana's reply with the new lease")).toBeTruthy();

    const link = document.querySelector('.desk-link') as HTMLElement;
    expect(link.textContent).toBe('Lease renewalMail thread in personal t-lease');
    expect(within(link).getByText('t-lease').tagName).toBe('CODE');
    expect(within(link).queryByRole('link')).toBeNull();

    expect(panel().getByText('dana@landlord.example', { selector: 'dd' })).toBeTruthy();
    expect(panel().getByText('Re: Lease renewal')).toBeTruthy();
    expect(panel().getByText(/Could you send the new lease when it is ready/)).toBeTruthy();
    expect(panel().getByText('Saved in Gmail Drafts (personal account). ok computer never sends it.')).toBeTruthy();
    expect(panel().queryByRole('button', { name: /send/i })).toBeNull();

    expect(historyKinds()).toEqual(['Created', 'Link added', 'Checked for a reply', 'Nudge drafted', 'Note']);
    expect(historyActors()).toEqual(['ok computer', 'ok computer', 'Follow-up', 'Follow-up', 'You']);
    const rows = [...document.querySelectorAll('.desk-history-row')];
    expect(rows[1]!.querySelector('.desk-history-summary')!.textContent).toBe('Mail thread: Lease renewal');
    expect(rows[3]!.textContent).toContain('Saved a nudge to Dana in Gmail Drafts. It is not sent.');
    expect(rows[4]!.textContent).toContain('Dana said on the phone that the lease comes this week.');
  });

  it('links the runs of the history to the run page', async () => {
    stubDesk();
    const { panel } = renderPanel(2);
    await panel().findByText('Nudge drafted');
    const runs = panel().getAllByRole('link', { name: 'run run-1' });
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.getAttribute('href')).toBe('#/runs/run-1');
  });

  it('links a run and a doc of the links, and says when there are none', async () => {
    stubDesk({
      'GET /api/desk/delegations/:id': ({ params }) =>
        params.id === '6'
          ? detail(6)
          : {
              ...detail(1),
              links: [
                { kind: 'run', ref: 'run-1', account: null, label: 'The chat where you asked', href: 'runs/run-1' },
                { kind: 'run', ref: 'run-2', account: null, label: null, href: null },
                { kind: 'doc', ref: '1', account: null, label: 'Passport checklist', href: 'docs/1' },
                { kind: 'doc', ref: 'doc-9', account: null, label: 'An old doc link', href: null },
                { kind: 'event', ref: 'ev-1', account: 'school', label: null, href: null },
              ],
            },
    });
    const { panel } = renderPanel(1);
    expect((await panel().findByRole('link', { name: 'The chat where you asked' })).getAttribute('href')).toBe('#/runs/run-1');
    expect(panel().getByRole('link', { name: 'Run run-2' }).getAttribute('href')).toBe('#/runs/run-2');
    expect(panel().getByRole('link', { name: 'Passport checklist' }).getAttribute('href')).toBe('#/docs/1');
    // an old doc link whose ref is not the id of a doc has no href, so it shows as text and not as a dead link.
    expect(panel().queryByRole('link', { name: 'An old doc link' })).toBeNull();
    expect(panel().getByText('An old doc link')).toBeTruthy();
    expect([...document.querySelectorAll('.desk-link')].at(-1)!.textContent).toBe('Calendar event in school ev-1');
    cleanup();
    renderPanel(6);
    expect(await screen.findByText('No links')).toBeTruthy();
  });

  it('marks the history rows that the agent wrote after it read outside text', async () => {
    const base = detail(4);
    stubDesk({
      'GET /api/desk/delegations/:id': () => ({
        ...base,
        history: [
          { ...base.history[0]!, id: 1, actor: 'owner', tainted: false },
          { ...base.history[0]!, id: 2, kind: 'note', actor: 'agent', text: 'The mail says to bring two photos.', tainted: true },
        ],
      }),
    });
    const { panel } = renderPanel(4);
    await panel().findByText('The mail says to bring two photos.');
    const rows = [...document.querySelectorAll('.desk-history-row')];
    expect(rows.map((row) => row.querySelector('.badge')?.textContent ?? null)).toEqual([null, 'outside text']);
    expect(rows[1]!.querySelector('.badge')!.getAttribute('title')).toContain('read outside text');
  });

  it('marks a delegation done with its status, then loads it again and tells the board', async () => {
    const { posts, detailLoads } = stubDesk();
    const { panel, onChanged } = renderPanel(2);
    await panel().findByText('Nudge drafted');
    const actions = within(panel().getByRole('group', { name: 'status actions' }));
    expect(actions.getAllByRole('button').map((button) => button.textContent)).toEqual(['Mark done', 'Move to needs you', 'Drop']);
    fireEvent.click(actions.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([{ status: 'done' }]);
    await waitFor(() => expect(detailLoads(2)).toBe(2));
  });

  it('offers to open a blocked or a closed delegation again', async () => {
    const { posts } = stubDesk();
    const { panel } = renderPanel(4);
    await panel().findByText('Sign the form and choose a photo');
    let actions = within(panel().getByRole('group', { name: 'status actions' }));
    expect(actions.getAllByRole('button').map((button) => button.textContent)).toEqual(['Mark done', 'Open again', 'Drop']);
    cleanup();
    const closed = renderPanel(5);
    await closed.panel().findByText('Closed');
    actions = within(closed.panel().getByRole('group', { name: 'status actions' }));
    expect(actions.getAllByRole('button').map((button) => button.textContent)).toEqual(['Open again']);
    fireEvent.click(actions.getByRole('button', { name: 'Open again' }));
    await waitFor(() => expect(posts).toEqual([{ status: 'open' }]));
  });

  it('shows the text of a 409 by the buttons and keeps them usable', async () => {
    let answer: () => Response = () => json({ error: 'delegation #2 is done, so it takes no follow-up time' }, 409);
    stubDesk({ 'POST /api/desk/delegations/:id': () => answer() });
    const { panel, onChanged } = renderPanel(2);
    await panel().findByText('Nudge drafted');
    const done = panel().getByRole('button', { name: 'Mark done' });
    fireEvent.click(done);
    expect(done.hasAttribute('disabled')).toBe(true);
    expect((await panel().findByRole('alert')).textContent).toBe('delegation #2 is done, so it takes no follow-up time');
    expect(done.hasAttribute('disabled')).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
    answer = () => json(delegation(2));
    fireEvent.click(panel().getByRole('button', { name: 'Drop' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(panel().queryByRole('alert')).toBeNull();
  });

  it('adds a note, clears the field and tells the board', async () => {
    const { posts } = stubDesk();
    const { panel, onChanged } = renderPanel(2);
    await panel().findByText('Nudge drafted');
    const field = panel().getByLabelText('Add a note') as HTMLTextAreaElement;
    const add = panel().getByRole('button', { name: 'Add note' });
    expect(add.hasAttribute('disabled')).toBe(true);
    fireEvent.change(field, { target: { value: '  Call Dana on Friday.  ' } });
    fireEvent.click(add);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([{ note: 'Call Dana on Friday.' }]);
    expect(field.value).toBe('');
  });

  it('counts the note near its limit and refuses a note over it', async () => {
    stubDesk();
    const { panel } = renderPanel(2);
    await panel().findByText('Nudge drafted');
    const field = panel().getByLabelText('Add a note');
    fireEvent.change(field, { target: { value: 'a'.repeat(1_700) } });
    expect(document.querySelector('.desk-note-form .desk-counter')).toBeNull();
    fireEvent.change(field, { target: { value: 'a'.repeat(2_001) } });
    expect(panel().getByText('2001/2000')).toBeTruthy();
    expect(panel().getByRole('button', { name: 'Add note' }).hasAttribute('disabled')).toBe(true);
  });

  it('says that a missing delegation is not on the desk, with a close action', async () => {
    stubDesk();
    const { panel, onClose } = renderPanel(999);
    expect(await panel().findByText('This delegation is not on the desk.')).toBeTruthy();
    fireEvent.click(panel().getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows another error with a try again button', async () => {
    let fail = true;
    stubDesk({ 'GET /api/desk/delegations/:id': () => (fail ? json({ error: 'the database is busy' }, 500) : detail(2)) });
    const { panel } = renderPanel(2);
    expect((await panel().findByRole('alert')).textContent).toContain('Could not load the delegation: the database is busy');
    fail = false;
    fireEvent.click(panel().getByRole('button', { name: 'Try again' }));
    expect(await panel().findByText('Nudge drafted')).toBeTruthy();
  });

  it('shows a skeleton while the delegation loads', async () => {
    let release: (() => void) | undefined;
    stubDesk({ 'GET /api/desk/delegations/:id': () => new Promise((done) => (release = () => done(detail(2)))) });
    const { panel } = renderPanel(2);
    expect(panel().getByText('Loading the delegation…')).toBeTruthy();
    await waitFor(() => expect(release).toBeDefined());
    release!();
    expect(await panel().findByText('Nudge drafted')).toBeTruthy();
  });

  it('renders a history row of an unknown kind and odd data without a crash', async () => {
    const odd: DelegationDetail = {
      ...detail(3),
      history: [
        { id: 1, delegationId: 3, kind: 'mystery' as never, actor: 'robot' as never, text: null, data: null as never, runId: null, toolCallId: null, tainted: false, createdAt: '2026-10-12T01:00:00.000Z' },
        { id: 2, delegationId: 3, kind: 'status', actor: 'owner', text: null, data: { from: 5, to: 'gone' }, runId: null, toolCallId: null, tainted: false, createdAt: '2026-10-12T02:00:00.000Z' },
        { id: 3, delegationId: 3, kind: 'updated', actor: 'owner', text: null, data: { changes: 'all' }, runId: null, toolCallId: null, tainted: false, createdAt: '2026-10-12T03:00:00.000Z' },
        { id: 4, delegationId: 3, kind: 'reply_seen', actor: 'system', text: null, data: { from: 'front@dentist.example' }, runId: null, toolCallId: null, tainted: false, createdAt: '2026-10-12T04:00:00.000Z' },
      ],
    };
    stubDesk({ 'GET /api/desk/delegations/:id': () => odd });
    const { panel } = renderPanel(3);
    expect(await panel().findByText('mystery')).toBeTruthy();
    expect(historyKinds()).toEqual(['mystery', 'Status', 'Changed', 'Reply came']);
    expect(historyActors()).toEqual([null, 'You', 'You', 'Follow-up']);
    const summaries = [...document.querySelectorAll('.desk-history-row')].map((row) => row.querySelector('.desk-history-summary')?.textContent ?? null);
    expect(summaries).toEqual([null, '? → gone', null, 'from front@dentist.example']);
  });

  it('words the data of each kind of history row', () => {
    expect(eventSummary({ kind: 'status', data: { from: 'open', to: 'waiting' } })).toBe('Open → Waiting');
    expect(eventSummary({ kind: 'updated', data: { changes: { title: {}, details: {}, nextStep: {}, dueAt: {}, nextFollowUpAt: {} } } })).toBe('Title; Details; Next step; Due; Follow-up');
    expect(eventSummary({ kind: 'updated', data: { changes: { nextStep: { from: 'Call the bank', to: null } } } })).toBe('Next step: Call the bank → none');
    expect(eventSummary({ kind: 'waiting_on', data: { name: 'Dana', email: 'dana@landlord.example' } })).toBe('Dana');
    expect(eventSummary({ kind: 'waiting_on', data: { name: null, email: 'dana@landlord.example' } })).toBe('dana@landlord.example');
    expect(eventSummary({ kind: 'waiting_on', data: { name: null, email: null } })).toBe('No one');
    expect(eventSummary({ kind: 'link_removed', data: { kind: 'doc', ref: 'doc-1', label: null } })).toBe('Doc: doc-1');
    expect(eventSummary({ kind: 'reply_seen', data: { from: 'Dana <dana@landlord.example>' } })).toBe('from Dana <dana@landlord.example>');
    expect(eventSummary({ kind: 'note', data: {} })).toBeNull();
  });

  it('switches to the edit form and back, and saves only the changed fields', async () => {
    const { posts, detailLoads } = stubDesk();
    const { panel, onChanged } = renderPanel(2);
    await panel().findByText('Nudge drafted');
    fireEvent.click(panel().getByRole('button', { name: 'Edit' }));
    const title = panel().getByLabelText('Title') as HTMLInputElement;
    expect(title.value).toBe('Get the lease renewal from Dana');
    fireEvent.click(panel().getByRole('button', { name: 'Cancel' }));
    expect(await panel().findByText('Nudge drafted')).toBeTruthy();
    fireEvent.click(panel().getByRole('button', { name: 'Edit' }));
    fireEvent.change(panel().getByLabelText('Title'), { target: { value: 'Get the signed lease from Dana' } });
    fireEvent.click(panel().getByRole('button', { name: 'Save changes' }));
    expect(await panel().findByText('Nudge drafted')).toBeTruthy();
    expect(posts).toEqual([{ title: 'Get the signed lease from Dana' }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(detailLoads(2)).toBe(2));
  });
});

describe('the details panel on the desk page', () => {
  const details = () => within(document.querySelector('.details') as HTMLElement);

  it('opens the delegation of #/desk?id=2', async () => {
    stubDesk();
    openApp('#/desk?id=2');
    expect(await details().findByText('Nudge drafted')).toBeTruthy();
    expect(details().getByText('Saved in Gmail Drafts (personal account). ok computer never sends it.')).toBeTruthy();
    expect(historyKinds()).toEqual(['Created', 'Link added', 'Checked for a reply', 'Nudge drafted', 'Note']);
    for (const run of details().getAllByRole('link', { name: 'run run-1' })) expect(run.getAttribute('href')).toBe('#/runs/run-1');
  });

  it('says that #/desk?id=999 is not on the desk', async () => {
    stubDesk();
    openApp('#/desk?id=999');
    expect(await details().findByText('This delegation is not on the desk.')).toBeTruthy();
    fireEvent.click(details().getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(location.hash).toBe('#/desk'));
  });
});
