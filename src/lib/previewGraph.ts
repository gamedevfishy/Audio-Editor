import type { CompressorSettings } from './ffmpeg';
import { dbToLinear } from './format';

const FADE = 0.005; // 5 ms ramps when starting/stopping buffers, to avoid clicks

interface BufferVoice {
  src: AudioBufferSourceNode;
  env: GainNode;
  startedAt: number;
  offset: number;
  duration: number;
  loop: boolean;
}

/**
 * Live preview of volume + compression.
 *   <audio> element ─┐
 *   buffer voice ────┴→ gain → [compressor → makeup] → out
 * The <audio> element handles normal playback; buffer voices handle gapless loops and cut previews.
 * This is an approximation; the exported file is rendered by FFmpeg.
 */
export class PreviewGraph {
  readonly ctx: AudioContext;
  private gain: GainNode;
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;
  private compEnabled = false;
  private voice: BufferVoice | null = null;

  constructor(media: HTMLMediaElement) {
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaElementSource(media);
    this.gain = this.ctx.createGain();
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.knee.value = 6;
    this.makeup = this.ctx.createGain();

    source.connect(this.gain);
    this.comp.connect(this.makeup);
    this.makeup.connect(this.ctx.destination);
    this.route();
  }

  async resume() {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Full-quality decode for loops, cut previews and silence detection. */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  setGainDb(db: number) {
    this.gain.gain.setTargetAtTime(dbToLinear(db), this.ctx.currentTime, 0.015);
  }

  setCompressor(c: CompressorSettings) {
    const t = this.ctx.currentTime;
    this.comp.threshold.setValueAtTime(c.thresholdDb, t);
    this.comp.ratio.setValueAtTime(c.ratio, t);
    this.comp.attack.setValueAtTime(c.attackMs / 1000, t);
    this.comp.release.setValueAtTime(c.releaseMs / 1000, t);
    this.makeup.gain.setTargetAtTime(dbToLinear(c.makeupDb), t, 0.015);
    if (c.enabled !== this.compEnabled) {
      this.compEnabled = c.enabled;
      this.route();
    }
  }

  private route() {
    this.gain.disconnect();
    this.gain.connect(this.compEnabled ? this.comp : this.ctx.destination);
  }

  /** Plays a buffer (optionally looped, gapless) from `offset` seconds. Replaces any current voice. */
  playBuffer(buffer: AudioBuffer, opts: { loop: boolean; offset?: number; onEnded?: () => void }) {
    this.stopBuffer();
    const t = this.ctx.currentTime + 0.01;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = opts.loop;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + FADE);
    src.connect(env);
    env.connect(this.gain);
    const offset = Math.min(Math.max(0, opts.offset ?? 0), Math.max(0, buffer.duration - 0.001));
    src.start(t, offset);
    const voice: BufferVoice = { src, env, startedAt: t, offset, duration: buffer.duration, loop: opts.loop };
    src.onended = () => {
      if (this.voice === voice) {
        this.voice = null;
        opts.onEnded?.();
      }
    };
    this.voice = voice;
  }

  /** Position inside the current buffer (seconds), or null if nothing is playing. */
  bufferPosition(): number | null {
    const v = this.voice;
    if (!v) return null;
    const elapsed = Math.max(0, this.ctx.currentTime - v.startedAt) + v.offset;
    return v.loop ? elapsed % v.duration : Math.min(elapsed, v.duration);
  }

  isBufferPlaying() {
    return this.voice !== null;
  }

  stopBuffer() {
    const v = this.voice;
    if (!v) return;
    this.voice = null;
    const t = this.ctx.currentTime;
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setValueAtTime(v.env.gain.value, t);
    v.env.gain.linearRampToValueAtTime(0, t + FADE);
    v.src.onended = null;
    try {
      v.src.stop(t + FADE + 0.002);
    } catch {
      /* already stopped */
    }
  }
}
