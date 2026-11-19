import { useState } from 'react';
import Editor from './components/Editor';
import Batch from './components/Batch';
import Icon from './components/Icon';
import { useProcessingSettings } from './hooks/useProcessingSettings';

type Tab = 'editor' | 'batch';

export default function App() {
  const settings = useProcessingSettings();
  const [tab, setTab] = useState<Tab>('editor');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 32 32" width="26" height="26">
              <rect width="32" height="32" rx="9" fill="currentColor" />
              <path
                d="M8 16h1.5M12 12v8M16 8v16M20 11.5v9M24 14.5v3"
                stroke="var(--accent-contrast)"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <h1>Audio Editor</h1>
        </div>

        <nav className="tabs" role="tablist" aria-label="Mode">
          {(['editor', 'batch'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'is-active' : ''}
              onClick={() => setTab(t)}
            >
              {t === 'editor' ? 'Editor' : 'Batch'}
            </button>
          ))}
        </nav>

        <span className="privacy" title="Everything runs in your browser. Nothing is uploaded.">
          <Icon name="lock" size={14} />
          Private · on-device
        </span>
      </header>

      {/* Both stay mounted so switching tabs keeps your file and queue. */}
      <Editor s={settings} hidden={tab !== 'editor'} />
      <Batch s={settings} hidden={tab !== 'batch'} />

      <footer className="footer">The live preview is approximate. Exports are rendered with FFmpeg.</footer>
    </div>
  );
}
