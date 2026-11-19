/**
 * Small PCM helpers for preview playback and analysis. They mirror what the FFmpeg export does
 * (same crossfade curves), so what you hear while looping is what gets exported.
 */

function makeBuffer(ctx: BaseAudioContext, channels: number, frames: number, sampleRate: number) {
  return ctx.createBuffer(channels, Math.max(1, frames), sampleRate);
}

/**
 * A seamless loop of [start, end): the last `crossfade` seconds are blended into the first ones
 * with equal-power curves (FFmpeg `acrossfade c1=qsin c2=qsin`). Output is `crossfade` shorter.
 */
export function buildLoopBuffer(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  start: number,
  end: number,
  crossfade: number,
): AudioBuffer {
  const sr = src.sampleRate;
  const s = Math.max(0, Math.round(start * sr));
  const e = Math.min(src.length, Math.round(end * sr));
  const len = Math.max(1, e - s);
  const x = Math.min(Math.round(crossfade * sr), Math.floor(len * 0.45));
  const outLen = len - x;
  const out = makeBuffer(ctx, src.numberOfChannels, outLen, sr);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const inp = src.getChannelData(c);
    const o = out.getChannelData(c);
    o.set(inp.subarray(s, s + outLen));
    for (let i = 0; i < x; i++) {
      const t = (i + 0.5) / x;
      const fadeIn = Math.sin((t * Math.PI) / 2);
      const fadeOut = Math.cos((t * Math.PI) / 2);
      o[i] = inp[s + i] * fadeIn + inp[s + len - x + i] * fadeOut;
    }
  }
  return out;
}

export interface CutPreview {
  buffer: AudioBuffer;
  /** Buffer time → time in the original file (for drawing the playhead). */
  toSource(t: number): number;
}

/**
 * Plays `context` seconds before the cut, skips [start, end), then `context` seconds after —
 * joined with the same short linear crossfade the export uses.
 */
export function buildCutPreview(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  start: number,
  end: number,
  context: number,
  joinSeconds: number,
): CutPreview {
  const sr = src.sampleRate;
  const a = Math.max(0, Math.round((start - context) * sr));
  const s = Math.round(start * sr);
  const e = Math.round(end * sr);
  const b = Math.min(src.length, Math.round((end + context) * sr));
  const pre = s - a;
  const post = b - e;
  const j = Math.min(Math.round(joinSeconds * sr), Math.floor(pre / 2), Math.floor(post / 2));
  const outLen = pre + post - j;
  const out = makeBuffer(ctx, src.numberOfChannels, outLen, sr);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const inp = src.getChannelData(c);
    const o = out.getChannelData(c);
    o.set(inp.subarray(a, s - j), 0);
    for (let i = 0; i < j; i++) {
      const t = (i + 0.5) / j;
      o[pre - j + i] = inp[s - j + i] * (1 - t) + inp[e + i] * t;
    }
    o.set(inp.subarray(e + j, b), pre);
  }
  const preSec = (pre - j / 2) / sr;
  return {
    buffer: out,
    toSource: (t) => (t < preSec ? a / sr + t : end + (t - preSec)),
  };
}

/**
 * Finds where sound starts and stops (peak above `thresholdDb`, in 10 ms windows).
 * Mirrors FFmpeg `silenceremove … detection=peak` with 20 ms kept on each side.
 */
export function detectSoundBounds(
  src: AudioBuffer,
  thresholdDb: number,
  pad = 0.02,
): { start: number; end: number } | null {
  const sr = src.sampleRate;
  const win = Math.max(1, Math.round(sr * 0.01));
  const windows = Math.ceil(src.length / win);
  const thr = Math.pow(10, thresholdDb / 20);
  const chans = Array.from({ length: src.numberOfChannels }, (_, c) => src.getChannelData(c));

  const loud = (w: number) => {
    const from = w * win;
    const to = Math.min(src.length, from + win);
    for (const d of chans) for (let i = from; i < to; i++) if (Math.abs(d[i]) >= thr) return true;
    return false;
  };

  let first = -1;
  for (let w = 0; w < windows; w++) if (loud(w)) { first = w; break; }
  if (first < 0) return null;
  let last = first;
  for (let w = windows - 1; w > first; w--) if (loud(w)) { last = w; break; }

  return {
    start: Math.max(0, (first * win) / sr - pad),
    end: Math.min(src.duration, ((last + 1) * win) / sr + pad),
  };
}
