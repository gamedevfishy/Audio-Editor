import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
// Served locally by Vite — no CDN needed, works offline.
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export type OutputFormat = 'mp3' | 'm4a' | 'opus' | 'wav';

export interface FormatInfo {
  label: string;
  ext: string;
  mime: string;
  codec: string;
  /** kbps choices; empty for lossless */
  bitrates: number[];
  defaultBitrate: number;
  sampleRates: number[];
}

export const FORMATS: Record<OutputFormat, FormatInfo> = {
  mp3: {
    label: 'MP3',
    ext: 'mp3',
    mime: 'audio/mpeg',
    codec: 'libmp3lame',
    bitrates: [64, 96, 128, 160, 192, 256, 320],
    defaultBitrate: 128,
    sampleRates: [48000, 44100, 32000, 22050, 16000],
  },
  m4a: {
    label: 'M4A (AAC)',
    ext: 'm4a',
    mime: 'audio/mp4',
    codec: 'aac',
    bitrates: [64, 96, 128, 192, 256],
    defaultBitrate: 128,
    sampleRates: [48000, 44100, 32000, 22050, 16000],
  },
  opus: {
    label: 'Opus (smallest)',
    ext: 'opus',
    mime: 'audio/ogg',
    codec: 'libopus',
    bitrates: [24, 32, 48, 64, 96, 128, 160],
    defaultBitrate: 64,
    // Opus always runs at 48 kHz internally; resampling wouldn't shrink the file.
    sampleRates: [],
  },
  wav: {
    label: 'WAV (lossless)',
    ext: 'wav',
    mime: 'audio/wav',
    codec: 'pcm_s16le',
    bitrates: [],
    defaultBitrate: 0,
    sampleRates: [48000, 44100, 32000, 22050, 16000],
  },
};

// ---------------------------------------------------------------------------
// Job description
// ---------------------------------------------------------------------------

export interface CompressorSettings {
  enabled: boolean;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

/** Sound + encoding settings shared by the editor and batch mode. */
export interface ProcessSettings {
  gainDb: number;
  limiter: boolean;
  compressor: CompressorSettings;
  format: OutputFormat;
  bitrateKbps: number;
  /** 0 = keep original */
  channels: 0 | 1 | 2;
  /** 0 = keep original */
  sampleRate: number;
}

export type EditSpec =
  /** Keep [start, end). crossfade > 0 folds the tail into the head for a seamless loop. */
  | { mode: 'keep'; start: number; end: number; crossfade: number }
  /** Remove [start, end) and join the rest. */
  | { mode: 'delete'; start: number; end: number; duration: number };

export const TAG_KEYS = ['title', 'artist', 'album', 'comment'] as const;
export type TagKey = (typeof TAG_KEYS)[number];
export type Tags = Partial<Record<TagKey, string>>;

export type TagSpec =
  /** Write exactly these tags (empty ones are dropped). */
  | { mode: 'replace'; tags: Tags }
  /** Keep the source's tags, overriding any non-empty values given. */
  | { mode: 'keep'; overrides: Tags };

export interface Job {
  process: ProcessSettings;
  edit?: EditSpec;
  /** Trim leading/trailing audio quieter than this (dBFS). Null/undefined = off. */
  trimSilenceDb?: number | null;
  tags: TagSpec;
}

export interface SourceInfo {
  duration: number;
  channels: number;
  sampleRate: number;
  tags: Tags;
}

/** Join crossfade when deleting a section, so the cut doesn't click. */
export const CUT_JOIN_SECONDS = 0.01;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

/** Loads ffmpeg.wasm once (~30 MB) and reuses it. Safe to call repeatedly. */
export function getFFmpeg(): Promise<FFmpeg> {
  if (instance) return Promise.resolve(instance);
  if (!loading) {
    const ff = new FFmpeg();
    loading = ff
      .load({ coreURL, wasmURL })
      .then(() => {
        instance = ff;
        return ff;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

/** Throw away the current engine; the next getFFmpeg() loads a fresh one. */
function resetFFmpeg() {
  instance?.terminate();
  instance = null;
  loading = null;
}

/** FFmpeg ran but rejected the job (bad input/settings). Retrying won't help. */
export class FFmpegJobError extends Error {}

// One job at a time: the engine has a single virtual filesystem and log stream.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * Runs `fn` with the engine. ffmpeg.wasm can corrupt its own heap ("memory access out of bounds");
 * if that happens the engine is replaced and `fn` retried once.
 */
function withEngine<T>(fn: (ff: FFmpeg) => Promise<T>, onRestart?: () => void): Promise<T> {
  return exclusive(async () => {
    try {
      return await fn(await getFFmpeg());
    } catch (err) {
      if (err instanceof FFmpegJobError) throw err;
      console.warn('FFmpeg engine crashed, restarting it:', err);
      resetFFmpeg();
      onRestart?.();
      return await fn(await getFFmpeg());
    }
  });
}

let fileCounter = 0;
function fsName(prefix: string, ext: string) {
  return `${prefix}-${++fileCounter}.${ext}`;
}
function extOf(name: string) {
  return (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
}

// ---------------------------------------------------------------------------
// Probing (duration, channels, tags)
// ---------------------------------------------------------------------------

function channelsFromLayout(layout: string): number {
  const l = layout.trim();
  if (l === 'mono') return 1;
  if (l === 'stereo') return 2;
  const n = /^(\d+) channels/.exec(l);
  if (n) return Number(n[1]);
  const known: Record<string, number> = { '2.1': 3, '3.0': 3, quad: 4, '4.0': 4, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8 };
  return known[l.replace(/\(.*\)/, '')] ?? 2;
}

function parseFFMetadata(text: string): Tags {
  const tags: Tags = {};
  // Join escaped newlines, then split.
  const lines = text.replace(/\\\n/g, '\u0000').split('\n');
  for (const raw of lines) {
    if (raw.startsWith('[')) break; // only the global section
    if (!raw || raw.startsWith(';') || raw.startsWith('#')) continue;
    const m = /^((?:[^=\\]|\\.)*)=(.*)$/.exec(raw);
    if (!m) continue;
    const unescape = (s: string) => s.replace(/\\(.)/g, '$1').replace(/\u0000/g, '\n');
    const key = unescape(m[1]).toLowerCase();
    if ((TAG_KEYS as readonly string[]).includes(key)) tags[key as TagKey] = unescape(m[2]);
  }
  return tags;
}

async function probe(ff: FFmpeg, input: string): Promise<SourceInfo> {
  const logs: string[] = [];
  const onLog = ({ message }: { message: string }) => logs.push(message);
  const meta = fsName('meta', 'txt');
  ff.on('log', onLog);
  try {
    await ff.exec(['-hide_banner', '-i', input, '-f', 'ffmetadata', '-y', meta]);
  } finally {
    ff.off('log', onLog);
  }
  const all = logs.join('\n');
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(all);
  const a = /Audio:.*?(\d+) Hz, ([^,\n]+)/.exec(all);
  if (!a) throw new FFmpegJobError('No audio stream found in this file.');
  let tags: Tags = {};
  try {
    const data = await ff.readFile(meta, 'utf8');
    tags = parseFFMetadata(typeof data === 'string' ? data : new TextDecoder().decode(data));
    await ff.deleteFile(meta);
  } catch {
    /* no metadata */
  }
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    sampleRate: Number(a[1]),
    channels: channelsFromLayout(a[2]),
    tags,
  };
}

/** Reads duration, channel count and tags of a file. */
export function readSourceInfo(file: File): Promise<SourceInfo> {
  return withEngine(async (ff) => {
    const input = fsName('probe', extOf(file.name));
    await ff.writeFile(input, await fetchFile(file));
    try {
      return await probe(ff, input);
    } finally {
      await ff.deleteFile(input).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

const n = (v: number, digits = 3) => Number(v.toFixed(digits)).toString();

/** Downmix → volume → compressor → limiter. */
export function buildFilters(p: ProcessSettings): string[] {
  const filters: string[] = [];
  // Normalized downmix: plain `-ac 1` sums channels un-normalized for float codecs (~+3 dB, can clip).
  if (p.channels === 1) filters.push('aresample=ochl=mono:rematrix_maxval=1');
  if (p.gainDb !== 0) filters.push(`volume=${n(p.gainDb, 2)}dB`);
  const c = p.compressor;
  if (c.enabled) {
    filters.push(
      `acompressor=threshold=${n(c.thresholdDb, 1)}dB:ratio=${n(c.ratio, 2)}` +
        `:attack=${n(c.attackMs, 2)}:release=${n(c.releaseMs, 1)}:makeup=${n(Math.max(0, c.makeupDb), 2)}dB`,
    );
  }
  const boosts = p.gainDb > 0 || (c.enabled && c.makeupDb > 0);
  // Brick-wall limiter so boosts don't clip. level=0 disables auto-leveling.
  if (p.limiter && boosts) filters.push('alimiter=limit=0.97:level=0');
  return filters;
}

function silenceTrimFilter(db: number): string {
  const s = `silenceremove=start_periods=1:start_threshold=${n(db, 1)}dB:start_silence=0.02:detection=peak`;
  // Trim the start, reverse, trim the (old) end, reverse back.
  return `${s},areverse,${s},areverse`;
}

interface Plan {
  inputArgs: string[];
  graph: string;
  /** Expected output length, for progress. */
  outDuration: number;
}

function planGraph(job: Job, info: SourceInfo): Plan {
  const inputArgs: string[] = [];
  const parts: string[] = [];
  let src = '[0:a]';
  let outDuration = info.duration;
  const e = job.edit;

  if (e?.mode === 'keep') {
    const len = e.end - e.start;
    inputArgs.push('-ss', n(e.start), '-t', n(len));
    outDuration = len;
    const x = Math.min(e.crossfade, len * 0.45);
    if (x >= 0.001) {
      parts.push(
        `${src}asplit=3[h][b][t]`,
        `[h]atrim=end=${n(x)},asetpts=PTS-STARTPTS[hd]`,
        `[t]atrim=start=${n(len - x)},asetpts=PTS-STARTPTS[tl]`,
        `[b]atrim=start=${n(x)}:end=${n(len - x)},asetpts=PTS-STARTPTS[bd]`,
        `[tl][hd]acrossfade=d=${n(x)}:c1=qsin:c2=qsin[seam]`,
        `[seam][bd]concat=n=2:v=0:a=1[loop]`,
      );
      src = '[loop]';
      outDuration = len - x;
    }
  } else if (e?.mode === 'delete') {
    const before = e.start;
    const after = e.duration - e.end;
    outDuration = before + after;
    if (before < 0.001) {
      inputArgs.push('-ss', n(e.end));
    } else if (after < 0.001) {
      inputArgs.push('-t', n(e.start));
    } else {
      const j = Math.min(CUT_JOIN_SECONDS, before / 2, after / 2);
      parts.push(
        `${src}asplit=2[a][b]`,
        `[a]atrim=end=${n(e.start, 6)},asetpts=PTS-STARTPTS[p]`,
        `[b]atrim=start=${n(e.end, 6)},asetpts=PTS-STARTPTS[q]`,
        j >= 0.001
          ? `[p][q]acrossfade=d=${n(j, 4)}:c1=tri:c2=tri[cut]`
          : `[p][q]concat=n=2:v=0:a=1[cut]`,
      );
      src = '[cut]';
      if (j >= 0.001) outDuration -= j;
    }
  }

  const chain: string[] = [];
  if (job.trimSilenceDb != null) chain.push(silenceTrimFilter(job.trimSilenceDb));
  chain.push(...buildFilters(job.process));
  parts.push(`${src}${chain.length ? chain.join(',') : 'anull'}[out]`);

  return { inputArgs, graph: parts.join(';'), outDuration };
}

function tagArgs(spec: TagSpec): string[] {
  const args: string[] = [];
  const tags = spec.mode === 'replace' ? spec.tags : spec.overrides;
  args.push('-map_metadata', spec.mode === 'replace' ? '-1' : '0');
  for (const key of TAG_KEYS) {
    const v = tags[key]?.trim();
    if (v) args.push('-metadata', `${key}=${v}`);
  }
  return args;
}

function codecArgs(p: ProcessSettings, sourceChannels: number): string[] {
  const fmt = FORMATS[p.format];
  const args: string[] = [];
  const outChannels = p.channels || sourceChannels;
  if (p.format === 'opus' && outChannels !== 1) {
    // libopus in ffmpeg.wasm 0.12 crashes on stereo ("memory access out of bounds"),
    // so stereo goes through FFmpeg's built-in Opus encoder (stereo max, 48 kHz only).
    args.push('-c:a', 'opus', '-strict', '-2', '-ac', '2', '-ar', '48000');
  } else {
    args.push('-c:a', fmt.codec);
    if (p.channels === 2) args.push('-ac', '2');
    if (p.sampleRate) args.push('-ar', String(p.sampleRate));
  }
  if (fmt.bitrates.length) args.push('-b:a', `${p.bitrateKbps}k`);
  if (p.format === 'mp3') args.push('-id3v2_version', '3'); // ID3v2.3: best compatibility (Windows, car stereos)
  if (p.format === 'm4a') args.push('-movflags', '+faststart');
  return args;
}

export function buildArgs(input: string, output: string, job: Job, info: SourceInfo): string[] {
  const plan = planGraph(job, info);
  return [
    ...plan.inputArgs,
    '-i',
    input,
    '-filter_complex',
    plan.graph,
    '-map',
    '[out]',
    ...codecArgs(job.process, info.channels),
    ...tagArgs(job.tags),
    '-y',
    output,
  ];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportProgress {
  stage: 'engine' | 'processing';
  /** 0..1, or null when indeterminate */
  progress: number | null;
}

export interface ExportResult {
  blob: Blob;
  info: SourceInfo;
}

export function exportAudio(file: File, job: Job, onProgress: (p: ExportProgress) => void): Promise<ExportResult> {
  onProgress({ stage: 'engine', progress: null });
  return withEngine(
    (ff) => runExport(ff, file, job, onProgress),
    () => onProgress({ stage: 'engine', progress: null }),
  );
}

async function runExport(
  ff: FFmpeg,
  file: File,
  job: Job,
  onProgress: (p: ExportProgress) => void,
): Promise<ExportResult> {
  const input = fsName('input', extOf(file.name));
  const output = fsName('output', FORMATS[job.process.format].ext);

  const logs: string[] = [];
  let outDuration = 0;
  const onLog = ({ message }: { message: string }) => {
    logs.push(message);
    if (logs.length > 40) logs.shift();
    const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (m && outDuration > 0) {
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      onProgress({ stage: 'processing', progress: Math.min(1, t / outDuration) });
    }
  };

  try {
    onProgress({ stage: 'processing', progress: 0 });
    await ff.writeFile(input, await fetchFile(file));
    const info = await probe(ff, input);
    outDuration = planGraph(job, info).outDuration;

    ff.on('log', onLog);
    const code = await ff.exec(buildArgs(input, output, job, info));
    ff.off('log', onLog);
    if (code !== 0) {
      throw new FFmpegJobError(`FFmpeg failed (exit code ${code}).\n${logs.slice(-6).join('\n')}`);
    }
    const data = await ff.readFile(output);
    onProgress({ stage: 'processing', progress: 1 });
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    if (bytes.length === 0) throw new FFmpegJobError('The result is empty — was everything trimmed away?');
    return { blob: new Blob([bytes], { type: FORMATS[job.process.format].mime }), info };
  } finally {
    ff.off('log', onLog);
    await ff.deleteFile(input).catch(() => {});
    await ff.deleteFile(output).catch(() => {});
  }
}

/** Expected output length of a job, in seconds. */
export function outputDuration(job: Job, sourceDuration: number): number {
  return planGraph(job, { duration: sourceDuration, channels: 2, sampleRate: 44100, tags: {} }).outDuration;
}

/** Rough output size so the user can see the effect of quality settings before exporting. */
export function estimateSize(p: ProcessSettings, seconds: number, sourceChannels: number): number {
  const dur = Math.max(0, seconds);
  const fmt = FORMATS[p.format];
  if (fmt.bitrates.length) return (p.bitrateKbps * 1000 * dur) / 8;
  const rate = p.sampleRate || 44100;
  const ch = p.channels || sourceChannels;
  return rate * ch * 2 * dur + 44;
}

/** Strips characters Windows/macOS don't allow in file names. */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
}
