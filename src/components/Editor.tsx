import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Waveform, { MAX_ZOOM, type Edge, type Selection, type WaveformHandle } from './Waveform';
import { Segmented, Slider, TabbedPanel, TextField, TimeField, nudgeStep } from './Controls';
import DropZone, { AUDIO_ACCEPT } from './DropZone';
import Icon from './Icon';
import { outputSummary, processingTabs } from './ProcessingPanels';
import type { ProcessingState } from '../hooks/useProcessingSettings';
import {
  CUT_JOIN_SECONDS,
  FORMATS,
  TAG_KEYS,
  estimateSize,
  exportAudio,
  outputDuration,
  readSourceInfo,
  sanitizeFileName,
  type Job,
  type TagKey,
  type Tags,
} from '../lib/ffmpeg';
import { PreviewGraph } from '../lib/previewGraph';
import { buildCutPreview, buildLoopBuffer, detectSoundBounds } from '../lib/audioEdit';
import { baseName, formatBytes, formatTime } from '../lib/format';

type Mode = 'keep' | 'delete';
type PlayState = 'none' | 'media' | 'loop' | 'cut';

type ExportState =
  | { status: 'idle' }
  | { status: 'working'; stage: 'engine' | 'processing'; progress: number | null }
  | { status: 'error'; message: string };

interface ResultView {
  url: string;
  fileName: string;
  size: number;
  duration: number;
}

const MIN_SELECTION = 0.05;
const CUT_PREVIEW_CONTEXT = 2;
const SILENCE_LEVELS = [-70, -60, -50, -40, -30];
const TAG_LABELS: Record<TagKey, string> = { title: 'Title', artist: 'Artist', album: 'Album', comment: 'Comment' };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export default function Editor({ s, hidden }: { s: ProcessingState; hidden: boolean }) {
  const media = useMemo(() => {
    const a = new Audio();
    a.preload = 'auto';
    return a;
  }, []);
  const graphRef = useRef<PreviewGraph | null>(null);
  const waveRef = useRef<WaveformHandle>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [sourceChannels, setSourceChannels] = useState(2);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const [activeEdge, setActiveEdge] = useState<Edge>('start');
  const [currentTime, setCurrentTime] = useState(0);
  const [zoomFactor, setZoomFactor] = useState(1);

  const [mode, setMode] = useState<Mode>('keep');
  const [loopOn, setLoopOn] = useState(false);
  const [crossfadeOn, setCrossfadeOn] = useState(false);
  const [crossfadeMs, setCrossfadeMs] = useState(50);
  const [silenceDb, setSilenceDb] = useState(-50);
  const [notice, setNotice] = useState<string | null>(null);
  const [playState, setPlayState] = useState<PlayState>('none');
  const [preparing, setPreparing] = useState(false);

  const [tags, setTags] = useState<Tags>({});
  const [outName, setOutName] = useState('');
  const [exportState, setExportState] = useState<ExportState>({ status: 'idle' });
  const [result, setResult] = useState<ResultView | null>(null);

  // Shortcuts popover: closes on outside click or Escape.
  const [showKeys, setShowKeys] = useState(false);
  const keysRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showKeys) return;
    const onDown = (e: PointerEvent) => {
      if (!keysRef.current?.contains(e.target as Node)) setShowKeys(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShowKeys(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showKeys]);

  const ready = duration > 0;
  const selLength = selection.end - selection.start;
  const maxCrossfadeMs = Math.max(5, Math.min(1000, Math.floor(selLength * 450)));
  const crossfadeSec = mode === 'keep' && crossfadeOn ? Math.min(crossfadeMs, maxCrossfadeMs) / 1000 : 0;

  // Latest values for rAF / keyboard / async callbacks.
  const fileRef = useRef(file);
  fileRef.current = file;
  const selRef = useRef(selection);
  selRef.current = selection;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const playStateRef = useRef(playState);
  playStateRef.current = playState;
  const crossfadeRef = useRef(crossfadeSec);
  crossfadeRef.current = crossfadeSec;

  // ---------- audio graph / full-quality decode ----------
  const ensureGraph = useCallback(() => {
    if (!graphRef.current) graphRef.current = new PreviewGraph(media);
    const g = graphRef.current;
    void g.resume();
    g.setGainDb(s.gainDb);
    g.setCompressor(s.comp);
    return g;
  }, [media, s.gainDb, s.comp]);

  useEffect(() => {
    graphRef.current?.setGainDb(s.gainDb);
  }, [s.gainDb]);
  useEffect(() => {
    graphRef.current?.setCompressor(s.comp);
  }, [s.comp]);

  const fullRef = useRef<{ file: File; promise: Promise<AudioBuffer> } | null>(null);
  const getFullBuffer = async (): Promise<AudioBuffer | null> => {
    const f = fileRef.current;
    if (!f) return null;
    const g = ensureGraph();
    if (!fullRef.current || fullRef.current.file !== f) {
      fullRef.current = { file: f, promise: f.arrayBuffer().then((d) => g.decode(d)) };
    }
    setPreparing(true);
    try {
      const buf = await fullRef.current.promise;
      return fileRef.current === f ? buf : null;
    } catch {
      fullRef.current = null;
      setNotice("This browser can't decode the file for loop preview or silence detection.");
      return null;
    } finally {
      setPreparing(false);
    }
  };

  // ---------- playback ----------
  const rafRef = useRef(0);
  const lastClockRef = useRef(0);
  const mapRef = useRef<(pos: number) => number>((t) => t);

  const tick = () => {
    const pos = graphRef.current?.bufferPosition();
    if (pos == null) {
      rafRef.current = 0;
      return;
    }
    const t = mapRef.current(pos);
    waveRef.current?.showPlayhead(t);
    if (Math.abs(t - lastClockRef.current) > 0.03) {
      lastClockRef.current = t;
      setCurrentTime(t);
    }
    rafRef.current = requestAnimationFrame(tick);
  };
  const startTick = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  };

  const stopAll = () => {
    graphRef.current?.stopBuffer();
    waveRef.current?.pause();
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    waveRef.current?.showPlayhead(null);
    setPlayState('none');
  };

  const startLoop = async (keepPhase = false) => {
    const g = ensureGraph();
    if (!keepPhase) waveRef.current?.pause();
    const full = await getFullBuffer();
    if (!full) return;
    const { start, end } = selRef.current;
    const buf = buildLoopBuffer(g.ctx, full, start, end, crossfadeRef.current);
    const prev = keepPhase ? g.bufferPosition() : null;
    mapRef.current = (p) => start + p;
    g.playBuffer(buf, { loop: true, offset: prev != null ? prev % buf.duration : 0 });
    setPlayState('loop');
    startTick();
  };

  const startCutPreview = async () => {
    const g = ensureGraph();
    waveRef.current?.pause();
    const full = await getFullBuffer();
    if (!full) return;
    const { start, end } = selRef.current;
    const p = buildCutPreview(g.ctx, full, start, end, CUT_PREVIEW_CONTEXT, CUT_JOIN_SECONDS);
    mapRef.current = p.toSource;
    g.playBuffer(p.buffer, { loop: false, onEnded: stopAll });
    setPlayState('cut');
    startTick();
  };

  const togglePlay = () => {
    if (!ready) return;
    if (playStateRef.current !== 'none') return stopAll();
    if (mode === 'keep' && loopOn) void startLoop();
    else waveRef.current?.playPause(mode === 'keep');
  };

  const playSelection = () => {
    if (!ready) return;
    if (playStateRef.current !== 'none') stopAll();
    if (mode === 'delete') void startCutPreview();
    else if (loopOn) void startLoop();
    else waveRef.current?.playSelection();
  };

  const toggleLoop = () => {
    if (mode !== 'keep') return;
    const next = !loopOn;
    setLoopOn(next);
    if (!next && playStateRef.current === 'loop') stopAll();
    if (next && playStateRef.current === 'media') void startLoop();
  };

  // While looping, follow selection / crossfade edits (debounced) without losing the beat.
  useEffect(() => {
    if (playStateRef.current !== 'loop') return;
    const id = setTimeout(() => void startLoop(true), 40);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.start, selection.end, crossfadeSec]);

  useEffect(() => {
    if (playStateRef.current === 'loop' || playStateRef.current === 'cut') stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (hidden && playStateRef.current !== 'none') stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  // ---------- file loading ----------
  const openFile = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    stopAll();
    fullRef.current = null;
    setFile(f);
    setFileUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
    setDuration(0);
    setLoadError(null);
    setSelection({ start: 0, end: 0 });
    setCurrentTime(0);
    setZoomFactor(1);
    setMode('keep');
    setNotice(null);
    setTags({});
    setOutName(`${baseName(f.name)}-edited`);
    setExportState({ status: 'idle' });
    setResult((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return null;
    });
    // Reads tags (and warms up the FFmpeg engine so Export is quick).
    readSourceInfo(f)
      .then((info) => {
        if (fileRef.current === f) setTags(info.tags);
      })
      .catch(() => {});
  };

  // ---------- selection ----------
  const normalizeSelection = useCallback((next: Selection, changed: Edge | 'both'): Selection => {
    const max = durationRef.current || next.end;
    let start = round6(clamp(next.start, 0, max));
    let end = round6(clamp(next.end, 0, max));
    if (end - start < MIN_SELECTION) {
      if (changed === 'start') start = Math.max(0, end - MIN_SELECTION);
      else end = Math.min(max, start + MIN_SELECTION);
      if (end - start < MIN_SELECTION) start = Math.max(0, end - MIN_SELECTION);
    }
    return { start, end };
  }, []);

  const updateSelection = useCallback(
    (next: Selection, changed: Edge | 'both') => setSelection(normalizeSelection(next, changed)),
    [normalizeSelection],
  );

  // Ref mirrors state so rapid key repeats (several per frame) see the latest edge.
  const activeEdgeRef = useRef(activeEdge);
  const pickEdge = (edge: Edge) => {
    activeEdgeRef.current = edge;
    setActiveEdge(edge);
  };

  const nudge = (edge: Edge, delta: number) => {
    pickEdge(edge);
    // Functional update: repeated nudges within one frame all accumulate.
    setSelection((prev) =>
      edge === 'start'
        ? normalizeSelection({ start: prev.start + delta, end: prev.end }, 'start')
        : normalizeSelection({ start: prev.start, end: prev.end + delta }, 'end'),
    );
  };

  const zoomToSelection = () => {
    const f = waveRef.current?.zoomToSelection();
    if (f) setZoomFactor(f);
  };

  const trimSilence = async () => {
    const full = await getFullBuffer();
    if (!full) return;
    const b = detectSoundBounds(full, silenceDb);
    if (!b) {
      setNotice(`Everything is quieter than ${silenceDb} dB. Try a lower threshold.`);
      return;
    }
    setMode('keep');
    updateSelection(b, 'both');
    const removed = durationRef.current - (b.end - b.start);
    setNotice(
      removed > 0.02
        ? `Selected ${formatTime(b.start, 3)} – ${formatTime(b.end, 3)}, leaving out ${removed.toFixed(2)} s of silence.`
        : 'No silence found at the start or end.',
    );
  };

  // ---------- keyboard ----------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (hidden || !ready) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
    if (e.altKey) return;

    // Match both the character and the physical key, so shortcuts also work on non-US layouts.
    const is = (key: string, code: string) => e.key.toLowerCase() === key || e.code === code;

    if (is(' ', 'Space')) {
      if (tag === 'BUTTON') return; // let the focused button handle it
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = nudgeStep(e);
      nudge(activeEdgeRef.current, e.key === 'ArrowRight' ? step : -step);
    } else if (e.ctrlKey || e.metaKey) {
      return;
    } else if (is('[', 'BracketLeft')) {
      pickEdge('start');
    } else if (is(']', 'BracketRight')) {
      pickEdge('end');
    } else if (is('l', 'KeyL')) {
      toggleLoop();
    } else if (is('z', 'KeyZ')) {
      zoomToSelection();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ---------- export ----------
  const job: Job = {
    process: s.process,
    edit:
      mode === 'keep'
        ? { mode: 'keep', start: selection.start, end: selection.end, crossfade: crossfadeSec }
        : { mode: 'delete', start: selection.start, end: selection.end, duration },
    tags: { mode: 'replace', tags },
  };
  const outLen = ready ? outputDuration(job, duration) : 0;
  const nothingLeft = ready && outLen < 0.01;
  const ext = FORMATS[s.format].ext;
  const finalName = `${sanitizeFileName(outName) || 'audio'}.${ext}`;

  const busy = exportState.status === 'working';
  const handleExport = async () => {
    if (!file || !ready || busy || nothingLeft) return;
    stopAll();
    setExportState({ status: 'working', stage: 'engine', progress: null });
    try {
      const { blob } = await exportAudio(file, job, (p) =>
        setExportState({ status: 'working', stage: p.stage, progress: p.progress }),
      );
      const url = URL.createObjectURL(blob);
      setResult((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { url, fileName: finalName, size: blob.size, duration: outLen };
      });
      setExportState({ status: 'idle' });
    } catch (err) {
      console.error(err);
      setExportState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const sizeChange = result && file ? Math.round((1 - result.size / file.size) * 100) : 0;
  const playing = playState !== 'none';
  const outSize = ready ? estimateSize(s.process, outLen, sourceChannels) : 0;

  if (!file || !fileUrl) {
    return (
      <div hidden={hidden} className="empty">
        <div className="empty-copy">
          <h2 className="hero-title">Edit audio, privately.</h2>
          <p className="hero-sub">
            Trim, loop, adjust volume and compress, right in your browser. Your files never leave this computer.
          </p>
        </div>
        <DropZone onFiles={openFile} />
      </div>
    );
  }

  const channelLabel =
    sourceChannels === 1 ? 'Mono' : sourceChannels === 2 ? 'Stereo' : `${sourceChannels} channels`;

  const trimTab = {
    id: 'trim',
    label: 'Trim',
    dot: mode === 'keep' && crossfadeOn,
    hint: 'Clean up the edges and smooth the loop point.',
    content: (
      <div className="tab-grid">
        <div className="field">
          <div className="field-row">
            <span className="label">Auto-trim silence</span>
          </div>
          <div className="inline-row">
            <select aria-label="Silence threshold" value={silenceDb} onChange={(e) => setSilenceDb(Number(e.target.value))}>
              {SILENCE_LEVELS.map((db) => (
                <option key={db} value={db}>
                  Quieter than {db} dB
                </option>
              ))}
            </select>
            <button type="button" className="btn" disabled={!ready || preparing} onClick={() => void trimSilence()}>
              Trim
            </button>
          </div>
          {notice && <p className="notice">{notice}</p>}
        </div>

        <div className={`field ${mode === 'delete' ? 'is-disabled' : ''}`}>
          <label className="check">
            <input
              type="checkbox"
              checked={crossfadeOn}
              disabled={mode === 'delete'}
              onChange={(e) => setCrossfadeOn(e.target.checked)}
            />
            <span>Crossfade loop seam</span>
          </label>
          <Slider
            label="Crossfade length"
            value={Math.min(crossfadeMs, maxCrossfadeMs)}
            min={5}
            max={maxCrossfadeMs}
            step={5}
            format={(v) => `${v} ms`}
            onChange={setCrossfadeMs}
            disabled={!crossfadeOn || mode === 'delete'}
          />
          <p className="hint">
            {mode === 'delete'
              ? 'Not used when deleting. The cut gets a 10 ms join fade so it doesn’t click.'
              : 'Blends the end into the start so the loop repeats without a click. The export gets that much shorter.'}
          </p>
        </div>
      </div>
    ),
  };

  const tagsSet = TAG_KEYS.filter((k) => tags[k]).length;

  return (
    <div hidden={hidden} className="workspace">
      <div className="main-col">
        <section className="panel stage">
          <header className="stage-head">
            <div className="file-chip">
              <span className="file-icon">
                <Icon name="file" size={16} />
              </span>
              <div className="file-text">
                <strong className="file-name" title={file.name}>
                  {file.name}
                </strong>
                <span className="file-meta">
                  {formatBytes(file.size)}
                  {ready && ` · ${formatTime(duration)} · ${channelLabel}`}
                </span>
              </div>
            </div>
            <div className="stage-actions">
              <div className="popover-anchor" ref={keysRef}>
                <button
                  type="button"
                  className={`btn btn-ghost btn-square ${showKeys ? 'is-on' : ''}`}
                  aria-label="Keyboard shortcuts"
                  aria-expanded={showKeys}
                  title="Keyboard shortcuts"
                  onClick={() => setShowKeys((v) => !v)}
                >
                  <Icon name="keyboard" />
                </button>
                {showKeys && (
                  <div className="popover" role="dialog" aria-label="Keyboard shortcuts">
                    <p className="popover-title">Shortcuts</p>
                    <dl className="keys">
                      <dt><kbd>Space</kbd></dt>
                      <dd>Play / stop</dd>
                      <dt><kbd>L</kbd></dt>
                      <dd>Loop selection</dd>
                      <dt><kbd>[</kbd> <kbd>]</kbd></dt>
                      <dd>Pick start / end edge</dd>
                      <dt><kbd>←</kbd> <kbd>→</kbd></dt>
                      <dd>Nudge edge 10 ms</dd>
                      <dt><kbd>Shift</kbd> / <kbd>Ctrl</kbd></dt>
                      <dd>…by 100 ms / 1 ms</dd>
                      <dt><kbd>Z</kbd></dt>
                      <dd>Zoom to selection</dd>
                    </dl>
                    <p className="hint">Drag the edges to trim, or drag across the waveform for a new selection.</p>
                  </div>
                )}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => pickerRef.current?.click()}>
                <Icon name="replace" size={15} />
                Replace
              </button>
              <input
                ref={pickerRef}
                type="file"
                accept={AUDIO_ACCEPT}
                hidden
                onChange={(e) => {
                  openFile(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </div>
          </header>

          {loadError ? (
            <p className="error-box">{loadError}</p>
          ) : (
            <div className={`wave-wrap ${ready ? '' : 'is-loading'}`}>
              {!ready && <div className="wave-loading">Drawing waveform…</div>}
              <Waveform
                ref={waveRef}
                url={fileUrl}
                media={media}
                selection={selection}
                zoomFactor={zoomFactor}
                activeEdge={activeEdge}
                tone={mode}
                onSelectionChange={(sel, side) => {
                  if (side) pickEdge(side);
                  updateSelection(sel, side ?? 'both');
                }}
                onReady={(d, ch) => {
                  setDuration(d);
                  setSourceChannels(ch);
                  setSelection({ start: 0, end: d });
                }}
                onError={setLoadError}
                onTime={(t) => {
                  if (playStateRef.current === 'media' || playStateRef.current === 'none') setCurrentTime(t);
                }}
                onPlayingChange={(p) => {
                  if (p) setPlayState('media');
                  else setPlayState((ps) => (ps === 'media' ? 'none' : ps));
                }}
                onBeforePlay={ensureGraph}
              />
            </div>
          )}

          <div className="transport">
            <div className="transport-left">
              <button
                type="button"
                className="btn btn-primary btn-play"
                disabled={!ready}
                onClick={togglePlay}
                aria-label={playing ? 'Stop' : 'Play'}
                title="Play / stop (Space)"
              >
                <Icon name={playing ? 'pause' : 'play'} size={20} />
              </button>
              <div className="clock" aria-live="off">
                <span>{formatTime(currentTime)}</span>
                <span className="clock-total">/ {formatTime(duration)}</span>
              </div>
              {preparing && <span className="spinner" aria-label="Preparing audio" />}
            </div>

            <div className="transport-right">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!ready}
                onClick={playSelection}
                title={mode === 'delete' ? 'Hear the audio around the cut' : 'Play just the selection'}
              >
                <Icon name="playRange" size={17} />
                {mode === 'delete' ? 'Preview cut' : 'Play selection'}
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-toggle ${loopOn && mode === 'keep' ? 'is-on' : ''}`}
                aria-pressed={loopOn && mode === 'keep'}
                disabled={!ready || mode !== 'keep'}
                onClick={toggleLoop}
                title={mode === 'keep' ? 'Loop the selection without gaps (L)' : 'Looping is only for kept selections'}
              >
                <Icon name="loop" size={17} />
                Loop
              </button>
              <span className="divider" aria-hidden />
              <div className="zoom" role="group" aria-label="Zoom">
                <button
                  type="button"
                  className="btn btn-ghost btn-square"
                  aria-label="Zoom out"
                  title="Zoom out"
                  disabled={!ready || zoomFactor <= 1}
                  onClick={() => setZoomFactor((z) => Math.max(1, z / 2))}
                >
                  <Icon name="zoomOut" size={17} />
                </button>
                <span className="zoom-readout">{zoomFactor < 10 ? zoomFactor.toFixed(1) : Math.round(zoomFactor)}×</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-square"
                  aria-label="Zoom in"
                  title="Zoom in"
                  disabled={!ready || zoomFactor >= MAX_ZOOM}
                  onClick={() => setZoomFactor((z) => Math.min(MAX_ZOOM, z * 2))}
                >
                  <Icon name="zoomIn" size={17} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-square"
                  aria-label="Zoom to selection"
                  title="Zoom to selection (Z)"
                  disabled={!ready}
                  onClick={zoomToSelection}
                >
                  <Icon name="focus" size={17} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-square"
                  aria-label="Fit whole file"
                  title="Fit whole file"
                  disabled={!ready || zoomFactor <= 1}
                  onClick={() => setZoomFactor(1)}
                >
                  <Icon name="fit" size={17} />
                </button>
              </div>
            </div>
          </div>

          <div className="selection-bar">
            <Segmented<Mode>
              className="is-inline"
              ariaLabel="What to do with the selection"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'keep', label: 'Keep' },
                { value: 'delete', label: 'Delete' },
              ]}
            />
            <div className="selection-fields">
              <TimeField
                label="Start"
                value={selection.start}
                active={activeEdge === 'start'}
                onFocus={() => pickEdge('start')}
                onNudge={(d) => nudge('start', d)}
                onCommit={(v) => updateSelection({ start: v, end: selection.end }, 'start')}
              />
              <TimeField
                label="End"
                value={selection.end}
                active={activeEdge === 'end'}
                onFocus={() => pickEdge('end')}
                onNudge={(d) => nudge('end', d)}
                onCommit={(v) => updateSelection({ start: selection.start, end: v }, 'end')}
              />
              <span className="readout">
                <span className="readout-label">Length</span>
                {formatTime(selLength, 3)}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!ready || (selection.start === 0 && selection.end === duration)}
                onClick={() => updateSelection({ start: 0, end: duration }, 'both')}
              >
                Select all
              </button>
            </div>
          </div>
        </section>

        <TabbedPanel label="Adjust" tabs={[trimTab, ...processingTabs(s)]} />
      </div>

      <aside className="side-col">
        <section className="panel export">
          <h2 className="panel-title">Export</h2>

          <TextField label="File name" value={outName} onChange={setOutName} suffix={`.${ext}`} placeholder="audio" />

          <dl className="summary">
            <div>
              <dt>Length</dt>
              <dd>{ready ? formatTime(outLen, 2) : '—'}</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>{outputSummary(s)}</dd>
            </div>
            <div>
              <dt>Est. size</dt>
              <dd>{ready ? `≈ ${formatBytes(outSize)}` : '—'}</dd>
            </div>
          </dl>

          <details className="disclosure">
            <summary>
              <Icon name="chevron" size={14} />
              Tags
              <span className="summary-count">{tagsSet ? `${tagsSet} set` : 'none'}</span>
            </summary>
            <p className="hint">Read from the original file. Edit or clear before exporting.</p>
            {TAG_KEYS.map((k) => (
              <TextField
                key={k}
                label={TAG_LABELS[k]}
                value={tags[k] ?? ''}
                onChange={(v) => setTags((t) => ({ ...t, [k]: v }))}
              />
            ))}
          </details>

          {nothingLeft && <p className="notice notice-warn">Nothing would be left. Make the selection smaller.</p>}

          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            disabled={!ready || busy || nothingLeft}
            onClick={handleExport}
          >
            {busy ? (
              'Exporting…'
            ) : (
              <>
                <Icon name="download" size={17} />
                Export {mode === 'delete' ? 'with cut' : 'audio'}
              </>
            )}
          </button>

          {exportState.status === 'working' && (
            <div className="progress-block" role="status">
              <div className="progress-label">
                <span>{exportState.stage === 'engine' ? 'Loading audio engine…' : 'Processing…'}</span>
                {exportState.progress !== null && <span>{Math.round(exportState.progress * 100)}%</span>}
              </div>
              <div className={`progress ${exportState.progress === null ? 'is-indeterminate' : ''}`}>
                <div className="progress-bar" style={{ width: `${(exportState.progress ?? 0) * 100}%` }} />
              </div>
            </div>
          )}

          {exportState.status === 'error' && <pre className="error-box">{exportState.message}</pre>}

          {result && exportState.status !== 'working' && (
            <div className="result">
              <div className="result-head">
                <span className="result-check">
                  <Icon name="check" size={14} />
                </span>
                <span className="result-sizes">
                  {formatBytes(file.size)} <span className="muted">→</span> <strong>{formatBytes(result.size)}</strong>
                </span>
                {sizeChange !== 0 && (
                  <span className={`badge ${sizeChange > 0 ? 'badge-good' : ''}`}>
                    {sizeChange > 0 ? `−${sizeChange}%` : `+${-sizeChange}%`}
                  </span>
                )}
              </div>
              <audio className="result-audio" controls src={result.url} />
              <a className="btn btn-block" href={result.url} download={result.fileName} title={result.fileName}>
                <Icon name="download" size={16} />
                Download
              </a>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
