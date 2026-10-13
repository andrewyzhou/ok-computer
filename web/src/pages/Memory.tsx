import { useState } from 'react';
import type { MemoryFile } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Empty, Load, Page, Panel } from '../components';
import { time } from '../format';

function FileView({ path }: { path: string }) {
  const loaded = useApi<{ text: string }>(`/api/memory/file?path=${encodeURIComponent(path)}`);
  return <Load loaded={loaded}>{(file) => <pre className="file">{file.text}</pre>}</Load>;
}

export function Memory() {
  const loaded = useApi<MemoryFile[]>('/api/memory');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  return (
    <Page title="Memory">
      <Load loaded={loaded}>
        {(files) => {
          if (!files.length) return <Empty>No memory files yet.</Empty>;
          const path = selected ?? files[0]!.path;
          return (
            <div className="browser">
              <nav className="file-list" aria-label="memory files">
                {files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className={file.path === path ? 'active' : ''}
                    onClick={() => setSelected(file.path)}
                  >
                    <span>{file.path}</span>
                    <span className="muted small">{time(file.modifiedAt)}</span>
                  </button>
                ))}
              </nav>
              <Panel title={path}>
                <FileView path={path} />
              </Panel>
            </div>
          );
        }}
      </Load>
    </Page>
  );
}
