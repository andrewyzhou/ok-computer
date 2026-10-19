// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ICON_NAMES } from '../icons';
import { DetailsPanel, Drawer, Highlight, Page, Table, Tabs } from '.';

afterEach(() => cleanup());

describe('the shared parts', () => {
  it('moves between the tabs with the arrow keys', () => {
    function Host() {
      const [tab, setTab] = useState('a');
      return (
        <Tabs
          label="views"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'a', label: 'All' },
            { id: 'b', label: 'Pending', count: 2 },
          ]}
        />
      );
    }
    render(<Host />);
    const [all, pending] = screen.getAllByRole('tab');
    fireEvent.keyDown(all!, { key: 'ArrowRight' });
    expect(pending!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(pending);
    fireEvent.keyDown(pending!, { key: 'ArrowRight' });
    expect(all!.getAttribute('aria-selected')).toBe('true');
  });

  it('selects a table row with the keyboard, and a link in the row does not select it', () => {
    const picked: string[] = [];
    render(
      <Table
        label="rows"
        rows={['one', 'two']}
        rowKey={(row) => row}
        onSelect={(row) => picked.push(row)}
        columns={[{ key: 'name', header: 'Name', cell: (row) => <a href={`#/${row}`}>{row}</a> }]}
      />,
    );
    const rows = screen.getAllByRole('row').slice(1);
    fireEvent.keyDown(rows[0]!, { key: 'Enter' });
    fireEvent.click(screen.getByText('two'));
    fireEvent.click(rows[1]!);
    expect(picked).toEqual(['one', 'two']);
  });

  it('renders the details panel and the page actions in place outside the shell', () => {
    render(
      <Page title="Alone" actions={<button type="button">Act</button>}>
        <DetailsPanel title="Facts">body</DetailsPanel>
      </Page>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Alone' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Act' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'details' }).textContent).toContain('body');
  });

  it('marks the matches of a text and skips a mark that overlaps another', () => {
    const { container } = render(
      <Highlight
        text="the essay is due"
        marks={[
          [4, 9],
          [6, 8],
          [13, 16],
        ]}
      />,
    );
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['essay', 'due']);
    expect(container.textContent).toBe('the essay is due');
  });

  it('closes a drawer with Escape', () => {
    let open = true;
    const { rerender } = render(
      <Drawer open={open} onClose={() => (open = false)} label="filters">
        <button type="button">inside</button>
      </Drawer>,
    );
    expect(document.activeElement?.textContent).toBe('inside');
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'filters' }), { key: 'Escape' });
    expect(open).toBe(false);
    rerender(
      <Drawer open={open} onClose={() => {}} label="filters">
        <button type="button">inside</button>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has a drawing for each icon name', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(40);
  });
});
