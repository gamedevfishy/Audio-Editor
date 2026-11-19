import { useEffect, useRef, useState } from 'react';
import { zipSync } from 'fflate';
import { TabbedPanel, TextField } from './Controls';
import DropZone from './DropZone';
import Icon from './Icon';
import { outputSummary, processingTabs } from './ProcessingPanels';
import type { ProcessingState } from '../hooks/useProcessingSettings';
import { FORMATS, exportAudio, sanitizeFileName, type Job } from '../lib/ffmpeg';
import { baseName, formatBytes, formatTime } from '../lib/format';

type ItemStatus = 'queued' | 'working' | 'done' | 'error';

interface Item {
  id: number;
  file: File;
  status: ItemStatus;
  progress: number | null;
  error?: string;
  out?: { url: string; blob: Blob; name: string; duration: number };
}

const SILENCE_LEVELS = [-70, -60, -50, -40, -30];
let nextId = 1;

export default function Batch({ s, hidden }: { s: ProcessingState; hidden: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);

  const [trimOn, setTrimOn] = useState(false);
  const [silenceDb, setSilenceDb] = useState(-50);
  const [suffix, setSuffix] = useState('-edited');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [zipping, setZipping] = useState(false);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Revoke object URLs on unmount.
  useEffect(() => () => itemsRef.current.forEach((i) => i.out && URL.revokeObjectURL(i.out.url)), []);

  const patch = (id: number, p: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)));

  const addFiles = (files: File[]) => {
    setItems((list) => [...list, ...files.map((file) => ({ id: nextId++, file, status: 'queued' as const, progress: null }))]);
  };

  const remove = (id: number) =>
    setItems((list) => {
      const it = list.find((i) => i.id === id);
      if (it?.out) URL.revokeObjectURL(it.out.url);
      return list.filter((i) => i.id !== id);
    });

  const clearAll = () => {
    items.forEach((i) => i.out && URL.revokeObjectURL(i.out.url));
    setItems([]);
  };

  const ext = FORMATS[s.format].ext;

  /** Output names, de-duplicated so nothing overwrites in the zip. */
  const outNameFor = (file: File, used: Set<string>) => {
    const base = sanitizeFileName(`${baseName(file.name)}${suffix}`) || 'audio';
    let name = `${base}.${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).${ext}`;
    used.add(name.toLowerCase());
    return name;
  };

  /** Processes everything not done yet (queued + failed), or every file when `all`. */
  const run = async (all: boolean) => {
    stopRef.current = false;
    setRunning(true);
    const job: Job = {
      process: s.process,
      trimSilenceDb: trimOn ? silenceDb : null,
      tags: { mode: 'keep', overrides: { artist, album } },
    };
    const todo = itemsRef.current.filter((i) => all || i.status !== 'done');
    if (all) {
      for (const i of todo) if (i.out) URL.revokeObjectURL(i.out.url);
      setItems((list) => list.map((i) => ({ ...i, status: 'queued', progress: null, error: undefined, out: undefined })));
    }
    const used = new Set<string>(
      all ? [] : itemsRef.current.filter((i) => i.status === 'done' && i.out).map((i) => i.out!.name.toLowerCase()),
    );
    for (const it of todo) {
      if (stopRef.current) break;
      if (!itemsRef.current.some((i) => i.id === it.id)) continue; // removed meanwhile
      patch(it.id, { status: 'working', progress: null, error: undefined });
      try {
        const { blob, info } = await exportAudio(it.file, job, (p) => patch(it.id, { progress: p.progress }));
        const name = outNameFor(it.file, used);
        patch(it.id, {
          status: 'done',
          progress: 1,
          out: { url: URL.createObjectURL(blob), blob, name, duration: info.duration },
        });
      } catch (err) {
        patch(it.id, { status: 'error', error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
      }
    }
    setRunning(false);
  };

  const downloadZip = async () => {
    const done = items.filter((i) => i.out);
    if (!done.length) return;
    setZipping(true);
    try {
      const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
      for (const i of done) entries[i.out!.name] = [new Uint8Array(await i.out!.blob.arrayBuffer()), { level: 0 }];
      const zip = zipSync(entries);
      const url = URL.createObjectURL(new Blob([new Uint8Array(zip)], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audio-batch.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setZipping(false);
    }
  };

  const doneCount = items.filter((i) => i.status === 'done').length;
  const pending = items.filter((i) => i.status !== 'done').length;
  const totalIn = items.reduce((n, i) => n + i.file.size, 0);
  const totalOut = items.reduce((n, i) => n + (i.out?.blob.size ?? 0), 0);
  const doneIn = items.reduce((n, i) => n + (i.out ? i.file.size : 0), 0);

  const optionsTab = {
    id: 'options',
    label: 'Batch',
    dot: trimOn,
    hint: 'Applied to every file. Each whole file is processed.',
    content: (
      <div className="tab-grid">
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={trimOn} onChange={(e) => setTrimOn(e.target.checked)} />
            <span>Trim silence from start and end</span>
          </label>
          <select
            aria-label="Silence threshold"
            value={silenceDb}
            disabled={!trimOn}
            onChange={(e) => setSilenceDb(Number(e.target.value))}
          >
            {SILENCE_LEVELS.map((db) => (
              <option key={db} value={db}>
                Quieter than {db} dB
              </option>
            ))}
          </select>
        </div>
        <div>
          <TextField label="Add to file names" value={suffix} onChange={setSuffix} placeholder="(nothing)" suffix={`.${ext}`} />
          <p className="hint name-example">
            e.g. <code>{sanitizeFileName(`interview${suffix}`) || 'interview'}.{ext}</code>
          </p>
        </div>
        <TextField label="Artist" value={artist} onChange={setArtist} placeholder="Keep each file’s own" />
        <TextField label="Album" value={album} onChange={setAlbum} placeholder="Keep each file’s own" />
      </div>
    ),
  };

  return (
    <div hidden={hidden} className="workspace">
      <div className="main-col">
        <section className="panel">
          <header className="panel-head">
            <h2 className="panel-title">
              Files {items.length > 0 && <span className="count">{items.length}</span>}
            </h2>
            {items.length > 0 && !running && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearAll}>
                Clear all
              </button>
            )}
          </header>

          {items.length > 0 && (
            <ul className="batch-list">
              {items.map((it) => (
                <li key={it.id} className={`batch-item is-${it.status}`}>
                  <span className="file-icon">
                    {it.status === 'done' ? <Icon name="check" size={15} /> : <Icon name="file" size={15} />}
                  </span>
                  <div className="batch-name">
                    <span className="file-name" title={it.file.name}>
                      {it.file.name}
                    </span>
                    <span className="file-meta">
                      {formatBytes(it.file.size)}
                      {it.out && (
                        <>
                          {' → '}
                          <strong>{formatBytes(it.out.blob.size)}</strong> · {formatTime(it.out.duration)}
                        </>
                      )}
                    </span>
                    {it.status === 'working' && (
                      <div className={`progress progress-sm ${it.progress === null ? 'is-indeterminate' : ''}`}>
                        <div className="progress-bar" style={{ width: `${(it.progress ?? 0) * 100}%` }} />
                      </div>
                    )}
                    {it.error && <span className="error-text">{it.error}</span>}
                  </div>
                  <div className="batch-actions">
                    {it.status === 'queued' && <span className="badge">Waiting</span>}
                    {it.status === 'working' && (
                      <span className="badge badge-accent">
                        {it.progress != null ? `${Math.round(it.progress * 100)}%` : 'Starting'}
                      </span>
                    )}
                    {it.status === 'error' && <span className="badge badge-bad">Failed</span>}
                    {it.out && (
                      <a
                        className="btn btn-ghost btn-square"
                        href={it.out.url}
                        download={it.out.name}
                        title={`Download ${it.out.name}`}
                        aria-label={`Download ${it.out.name}`}
                      >
                        <Icon name="download" size={16} />
                      </a>
                    )}
                    {!(running && it.status === 'working') && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-square"
                        aria-label={`Remove ${it.file.name}`}
                        title="Remove"
                        onClick={() => remove(it.id)}
                      >
                        <Icon name="close" size={15} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <DropZone onFiles={addFiles} multiple compact={items.length > 0} title={items.length ? 'Add more files' : undefined} />
        </section>

        <TabbedPanel label="Batch settings" tabs={[optionsTab, ...processingTabs(s)]} />
      </div>

      <aside className="side-col">
        <section className="panel export">
          <h2 className="panel-title">Process</h2>

          <dl className="summary">
            <div>
              <dt>Files</dt>
              <dd>{items.length ? `${doneCount} of ${items.length} done` : '—'}</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>{outputSummary(s)}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>
                {doneCount ? (
                  <>
                    {formatBytes(doneIn)} → <strong>{formatBytes(totalOut)}</strong>
                  </>
                ) : items.length ? (
                  formatBytes(totalIn)
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>

          {running ? (
            <button type="button" className="btn btn-lg btn-block" onClick={() => (stopRef.current = true)}>
              Stop after this file
            </button>
          ) : pending === 0 && items.length > 0 ? (
            <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => void run(true)}>
              Process all again
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              disabled={pending === 0}
              onClick={() => void run(false)}
            >
              {pending ? `Process ${pending} file${pending === 1 ? '' : 's'}` : 'Add files to start'}
            </button>
          )}

          {doneCount > 0 && (
            <button type="button" className="btn btn-block" disabled={zipping || running} onClick={() => void downloadZip()}>
              <Icon name="download" size={16} />
              {zipping ? 'Zipping…' : 'Download all (.zip)'}
            </button>
          )}

          <p className="hint">Volume, Dynamics and Output are shared with the editor.</p>
        </section>
      </aside>
    </div>
  );
}
