// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocComment } from '../../../../src/dashboard/docs-types';
import { json, stubFetch } from '../../testing';
import { DocComments, type DocCommentsProps } from './Comments';
import { docComment, tripComments, tripDetail } from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(props: Partial<DocCommentsProps> = {}) {
  const onAdded = vi.fn();
  const view = render(<DocComments doc={tripDetail.doc} version={3} comments={tripComments} onAdded={onAdded} {...props} />);
  return { ...view, onAdded };
}

const box = () => screen.getByLabelText('Comment on version 3') as HTMLTextAreaElement;
const button = () => screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement;
const items = () => within(screen.getByRole('list')).getAllByRole('listitem');

describe('the doc comments', () => {
  it('lists the comments oldest first with their version, time and delivery state', () => {
    show();
    const [first, second] = items();
    expect(first!.textContent).toContain('Can we find a hotel closer to the old town?');
    expect(second!.textContent).toContain('Set a reminder for November 9 so I can still cancel.');
    // the first is on another version, so it links there. the second is on the shown version.
    const link = within(first!).getByRole('link', { name: 'on version 2' });
    expect(link.getAttribute('href')).toBe('#/docs/1?version=2');
    expect(within(second!).queryByRole('link')).toBeNull();
    expect(within(second!).getByText('on version 3')).toBeTruthy();
    expect(within(first!).getByText('sent to the agent')).toBeTruthy();
    expect(within(second!).getByText('waits for the agent')).toBeTruthy();
    expect(within(second!).getByText('Free cancellation until November 10.').tagName).toBe('BLOCKQUOTE');
    expect(first!.querySelector('time')!.getAttribute('dateTime')).toBe('2026-10-10T19:00:00.000Z');
  });

  it('shows the empty state', () => {
    show({ comments: [] });
    expect(screen.getByText('No comments yet. A comment goes to the agent, and it reads it in its next run.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('shows html and markdown in a comment as text', () => {
    show({ comments: [docComment(5, { text: '<img src=x onerror=alert(1)> **bold**\nsecond line', quote: '<script>alert(1)</script>' })] });
    const item = items()[0]!;
    expect(item.querySelector('img, script, strong')).toBeNull();
    expect(item.querySelector('.doc-comment-text')!.textContent).toBe('<img src=x onerror=alert(1)> **bold**\nsecond line');
    expect(within(item).getByText('<script>alert(1)</script>')).toBeTruthy();
  });

  it('disables the button while the text is empty, and counts only near the limit', () => {
    show();
    expect(button().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: '   \n ' } });
    expect(button().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: 'a'.repeat(3500) } });
    expect(button().disabled).toBe(false);
    expect(screen.queryByText(/\/ 4,000/)).toBeNull();
    fireEvent.change(box(), { target: { value: 'a'.repeat(3501) } });
    expect(screen.getByText('3,501 / 4,000')).toBeTruthy();
  });

  it('sends the text, the version and the quote, then clears the form and calls onAdded', async () => {
    const calls = stubFetch(null, { 'POST /api/docs/:id/comments': ({ body }) => json({ ...docComment(9), ...(body as object) }, 201) });
    const long = 'q'.repeat(600);
    const { onAdded } = show({ selection: long });
    const preview = screen.getByText('q'.repeat(500));
    expect(preview.tagName).toBe('BLOCKQUOTE');
    fireEvent.change(box(), { target: { value: 'Move the dinner.\nTo 20:00.' } });
    fireEvent.click(button());
    expect(screen.getByRole('status').textContent).toBe('Sending…');
    expect(button().disabled).toBe(true);
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([{ method: 'POST', url: '/api/docs/1/comments', body: { text: 'Move the dinner.\nTo 20:00.', version: 3, quote: 'q'.repeat(500) } }]);
    expect(box().value).toBe('');
    expect(screen.queryByRole('button', { name: 'Remove quote' })).toBeNull();
  });

  it('sends with Ctrl+Enter and leaves out a removed quote', async () => {
    const calls = stubFetch(null, { 'POST /api/docs/:id/comments': () => json(docComment(9), 201) });
    const { onAdded } = show({ selection: 'Memmo Alfama, four nights' });
    expect(screen.getByText('Memmo Alfama, four nights')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove quote' }));
    expect(screen.queryByText('Memmo Alfama, four nights')).toBeNull();
    fireEvent.change(box(), { target: { value: 'Looks good.' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(calls[0]!.body).toEqual({ text: 'Looks good.', version: 3 });
  });

  it('keeps the text and shows the error of the server', async () => {
    stubFetch(null, { 'POST /api/docs/:id/comments': () => json({ error: 'the comment has more than 4,000 characters' }, 400) });
    const { onAdded } = show();
    const text = 'a'.repeat(4001);
    fireEvent.change(box(), { target: { value: text } });
    expect(box().getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(button());
    expect((await screen.findByRole('alert')).textContent).toBe('the comment has more than 4,000 characters');
    expect(box().value).toBe(text);
    expect(button().disabled).toBe(false);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('takes a new selection as the quote', () => {
    const { rerender, onAdded } = show({ selection: '' });
    expect(screen.queryByRole('button', { name: 'Remove quote' })).toBeNull();
    const comments: DocComment[] = [];
    rerender(<DocComments doc={tripDetail.doc} version={3} comments={comments} selection="Walking shoes" onAdded={onAdded} />);
    expect(screen.getByText('Walking shoes').tagName).toBe('BLOCKQUOTE');
  });
});
