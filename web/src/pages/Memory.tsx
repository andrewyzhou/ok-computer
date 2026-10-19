import { useState } from 'react';
import type { MemoryFile } from '../../../src/dashboard/types';
import { useApi } from '../api';
import type { RouteProps } from '../routes';
import { Load } from '../components';
import { bytes, time } from '../format';
import { DetailsPanel, EmptyState, FilterBar, Page, SearchField, Table, type Column } from '../ui';
import './agent.css';

const COLUMNS: Array<Column<MemoryFile>> = [
  {
    key: 'path',
    header: 'File',
    cell: (file) => <span className="memory-path">{file.path}</span>,
    wrap: true,
  },
  {
    key: 'size',
    header: 'Size',
    cell: (file) => bytes(file.size),
    align: 'end',
    hideBelow: 'sm',
  },
  {
    key: 'modified',
    header: 'Modified',
    cell: (file) => time(file.modifiedAt),
    align: 'end',
  },
];

function FileView({ path }: { path: string }) {
  const loaded = useApi<{ text: string }>(`/api/memory/file?path=${encodeURIComponent(path)}`);
  return (
    <Load loaded={loaded}>
      {(file) =>
        file.text ? (
          <pre className="memory-text" tabIndex={0} aria-label={`text of ${path}`}>
            {file.text}
          </pre>
        ) : (
          <p className="muted">This file is empty.</p>
        )
      }
    </Load>
  );
}

// the selected file is the path in the query of the hash, so a memory hit of the search opens its file, and a link
// to a file can be shared and kept.
function selectFile(path: string): void {
  location.hash = `#/memory?path=${encodeURIComponent(path)}`;
}

function MemoryBody({ files, filter, selected }: { files: MemoryFile[]; filter: string; selected: string | null }) {
  // each tap counts, so a second tap on the same file opens the drawer of a phone again after it was closed. a link
  // with a path counts as the first tap, so the drawer of a phone opens on the file of the link.
  const [taps, setTaps] = useState(selected ? 1 : 0);
  if (!files.length)
    return (
      <EmptyState icon="memory" title="No memory files yet.">
        The agent writes what it learns about you into these files.
      </EmptyState>
    );
  const needle = filter.trim().toLowerCase();
  const shown = needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
  // with no path in the hash the first file shows, so the panel is never empty.
  const path = selected ?? files[0]!.path;
  return (
    <>
      <Table
        label="memory files"
        columns={COLUMNS}
        rows={shown}
        rowKey={(file) => file.path}
        selected={path}
        onSelect={(file) => {
          selectFile(file.path);
          setTaps((count) => count + 1);
        }}
        empty={<EmptyState icon="search" title={`No file matches “${filter.trim()}”.`} />}
      />
      <DetailsPanel title={path} openKey={taps ? `${path}:${taps}` : null}>
        <FileView path={path} />
      </DetailsPanel>
    </>
  );
}

export function Memory({ query }: Partial<RouteProps>) {
  const selected = query?.get('path') || null;
  const loaded = useApi<MemoryFile[]>('/api/memory');
  const [filter, setFilter] = useState('');
  return (
    <Page
      title="Memory"
      subtitle={loaded.data ? `${loaded.data.length} files, ${bytes(loaded.data.reduce((sum, file) => sum + file.size, 0))}` : undefined}
      toolbar={
        <FilterBar>
          <SearchField label="filter files" placeholder="Filter files" value={filter} onChange={setFilter} />
        </FilterBar>
      }
    >
      <Load loaded={loaded}>{(files) => <MemoryBody files={files} filter={filter} selected={selected} />}</Load>
    </Page>
  );
}
