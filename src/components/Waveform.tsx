import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions';
import TimelinePlugin from 'wavesurfer.js/plugins/timeline';

export interface Selection {
  start: number;
  end: number;
}

export type Edge = 'start' | 'end';

export const MAX_ZOOM = 512;

export interface WaveformHandle {
  /** Play [start, end) once through the <audio> element. */
  playSelection(): void;
  /** Toggle play/pause from the cursor. With `stopAtSelectionEnd`, jumps into the selection if outside. */
  playPause(stopAtSelectionEnd: boolean): void;
  pause(): void;
  /** Draw the loop/cut-preview playhead (null hides it). */
  showPlayhead(t: number | null): void;
  /** Zoom so the selection fills the view, then scroll to it. Returns the zoom factor used. */
  zoomToSelection(): number;
}

interface Props {
  url: string;
  media: HTMLAudioElement;
  selection: Selection;
  /** 1 = whole file fits; 2 = twice as wide, … */
  zoomFactor: number;
  /** Highlighted region edge (keyboard nudges move it). */
  activeEdge: Edge;
  /** Region tint, e.g. red when the selection will be deleted. */
  tone: 'keep' | 'delete';
  onSelectionChange(sel: Selection, side?: Edge): void;
  onReady(duration: number, channels: number): void;
  onError(message: string): void;
  onTime(t: number): void;
  onPlayingChange(playing: boolean): void;
  /** Called right before playback starts (inside the user gesture). */
  onBeforePlay(): void;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeColors() {
  return {
    waveColor: cssVar('--wave'),
    progressColor: cssVar('--wave-progress'),
    cursorColor: cssVar('--text'),
    region: cssVar('--region'),
    regionDelete: cssVar('--region-delete'),
    playhead: cssVar('--accent'),
    muted: cssVar('--muted'),
  };
}

const Waveform = forwardRef<WaveformHandle, Props>(function Waveform(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionRef = useRef<Region | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);
  const stopAtRef = useRef<number | null>(null);
  const zoomPxRef = useRef(0);

  // Keep latest props in a ref so the WaveSurfer instance isn't rebuilt on every render.
  const propsRef = useRef(props);
  propsRef.current = props;

  const regionColor = () => {
    const c = themeColors();
    return propsRef.current.tone === 'delete' ? c.regionDelete : c.region;
  };

  useEffect(() => {
    const colors = themeColors();
    const regions = RegionsPlugin.create();
    const timeline = TimelinePlugin.create({
      container: timelineRef.current!,
      height: 18,
      style: { fontSize: '11px', color: colors.muted },
    });

    const ws = WaveSurfer.create({
      container: containerRef.current!,
      media: props.media,
      url: props.url,
      height: 156,
      waveColor: colors.waveColor,
      progressColor: colors.progressColor,
      cursorColor: colors.cursorColor,
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      dragToSeek: true,
      plugins: [regions, timeline],
    });
    wsRef.current = ws;
    readyRef.current = false;
    zoomPxRef.current = 0;

    // Playhead for buffer playback (loops / cut preview). Lives in the scrolling wrapper.
    const playhead = document.createElement('div');
    Object.assign(playhead.style, {
      position: 'absolute',
      top: '0',
      bottom: '0',
      width: '2px',
      marginLeft: '-1px',
      background: colors.playhead,
      zIndex: '10',
      pointerEvents: 'none',
      display: 'none',
    });
    ws.getWrapper().appendChild(playhead);
    playheadRef.current = playhead;

    const emitRegion = (r: Region, side?: Edge) => {
      propsRef.current.onSelectionChange({ start: r.start, end: r.end }, side);
    };

    regions.on('region-created', (r) => {
      for (const other of regions.getRegions()) if (other !== r) other.remove();
      regionRef.current = r;
      emitRegion(r);
    });
    regions.on('region-updated', (r, side) => emitRegion(r, side));

    let disableDragSelect: (() => void) | null = null;

    ws.on('decode', (duration) => {
      readyRef.current = true;
      propsRef.current.onReady(duration, ws.getDecodedData()?.numberOfChannels ?? 2);
      regions.addRegion({ start: 0, end: duration, color: regionColor(), drag: true, resize: true });
      disableDragSelect = regions.enableDragSelection({ color: regionColor() }, 6);
      applyZoom(propsRef.current.zoomFactor);
    });

    ws.on('timeupdate', (t) => {
      propsRef.current.onTime(t);
      const stopAt = stopAtRef.current;
      if (stopAt !== null && t >= stopAt) {
        stopAtRef.current = null;
        ws.pause();
        ws.setTime(stopAt);
      }
    });
    ws.on('play', () => propsRef.current.onPlayingChange(true));
    ws.on('pause', () => propsRef.current.onPlayingChange(false));
    ws.on('finish', () => propsRef.current.onPlayingChange(false));
    ws.on('error', (e) =>
      propsRef.current.onError(
        `This browser couldn't decode the file for the waveform (${String(e)}). Try MP3, WAV, M4A, OGG or FLAC.`,
      ),
    );

    // Follow light/dark switches.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      const c = themeColors();
      ws.setOptions({ waveColor: c.waveColor, progressColor: c.progressColor, cursorColor: c.cursorColor });
      for (const r of regions.getRegions()) r.setOptions({ color: regionColor() });
      playhead.style.background = c.playhead;
    };
    mq.addEventListener('change', onScheme);

    return () => {
      mq.removeEventListener('change', onScheme);
      disableDragSelect?.();
      regionRef.current = null;
      playheadRef.current = null;
      readyRef.current = false;
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.url, props.media]);

  function applyZoom(factor: number) {
    const ws = wsRef.current;
    if (!ws || !readyRef.current) return;
    const duration = ws.getDuration();
    const px = factor <= 1.001 || !duration ? 0 : (ws.getWidth() / duration) * factor;
    if (Math.abs(px - zoomPxRef.current) < 0.01) return;
    zoomPxRef.current = px;
    ws.zoom(px);
  }

  // Push selection edits made in the time fields / keyboard back onto the region.
  useEffect(() => {
    const r = regionRef.current;
    if (!r) return;
    const { start, end } = props.selection;
    if (Math.abs(r.start - start) > 0.0005 || Math.abs(r.end - end) > 0.0005) {
      r.setOptions({ start, end });
    }
  }, [props.selection]);

  useEffect(() => {
    applyZoom(props.zoomFactor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.zoomFactor]);

  useEffect(() => {
    regionRef.current?.setOptions({ color: regionColor() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tone]);

  useImperativeHandle(ref, () => ({
    playSelection() {
      const ws = wsRef.current;
      if (!ws || !readyRef.current) return;
      const { start, end } = propsRef.current.selection;
      propsRef.current.onBeforePlay();
      ws.setTime(start);
      stopAtRef.current = end;
      void ws.play();
    },
    playPause(stopAtSelectionEnd: boolean) {
      const ws = wsRef.current;
      if (!ws || !readyRef.current) return;
      if (ws.isPlaying()) {
        ws.pause();
        return;
      }
      if (stopAtSelectionEnd) {
        const { start, end } = propsRef.current.selection;
        const t = ws.getCurrentTime();
        if (t < start || t >= end - 0.01) ws.setTime(start);
        stopAtRef.current = end;
      } else {
        stopAtRef.current = null;
        if (ws.getCurrentTime() >= ws.getDuration() - 0.01) ws.setTime(0);
      }
      propsRef.current.onBeforePlay();
      void ws.play();
    },
    pause() {
      stopAtRef.current = null;
      wsRef.current?.pause();
    },
    showPlayhead(t) {
      const el = playheadRef.current;
      const ws = wsRef.current;
      if (!el || !ws) return;
      if (t === null) {
        el.style.display = 'none';
        return;
      }
      const d = ws.getDuration() || 1;
      el.style.display = 'block';
      el.style.left = `${(t / d) * 100}%`;
    },
    zoomToSelection() {
      const ws = wsRef.current;
      if (!ws || !readyRef.current) return 1;
      const { start, end } = propsRef.current.selection;
      const len = Math.max(0.001, end - start);
      const factor = Math.min(MAX_ZOOM, Math.max(1, ws.getDuration() / (len * 1.1)));
      applyZoom(factor);
      requestAnimationFrame(() => ws.setScrollTime(Math.max(0, start - len * 0.05)));
      return factor;
    },
  }));

  return (
    <div className={`waveform edge-${props.activeEdge} tone-${props.tone}`}>
      <div ref={containerRef} className="waveform-canvas" />
      <div ref={timelineRef} className="waveform-timeline" />
    </div>
  );
});

export default Waveform;
