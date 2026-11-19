import { Segmented, Select, Slider, type TabSpec } from './Controls';
import { FORMATS, type OutputFormat } from '../lib/ffmpeg';
import { formatDb } from '../lib/format';
import type { Preset, ProcessingState } from '../hooks/useProcessingSettings';

/** Volume, Dynamics and Output tabs — shared by the editor and batch mode. */
export function processingTabs(s: ProcessingState): TabSpec[] {
  const { comp } = s;
  return [
    {
      id: 'volume',
      label: 'Volume',
      dot: s.gainDb !== 0,
      hint: 'Make the audio louder or quieter.',
      aside: s.gainDb !== 0 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => s.setGainDb(0)}>
          Reset
        </button>
      ),
      content: (
        <div className="tab-grid">
          <Slider label="Gain" value={s.gainDb} min={-24} max={24} step={0.5} format={formatDb} onChange={s.setGainDb} />
          <label className="check">
            <input type="checkbox" checked={s.limiter} onChange={(e) => s.setLimiter(e.target.checked)} />
            <span>Prevent clipping when boosting</span>
          </label>
        </div>
      ),
    },
    {
      id: 'dynamics',
      label: 'Dynamics',
      dot: comp.enabled,
      hint: 'Evens out loud and quiet parts. Good for voice and podcasts.',
      content: (
        <>
          <Segmented<Preset>
            ariaLabel="Compression preset"
            value={s.preset}
            onChange={s.choosePreset}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'gentle', label: 'Gentle' },
              { value: 'voice', label: 'Voice' },
              { value: 'heavy', label: 'Heavy' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
          <div className="tab-grid">
            <Slider
              label="Threshold"
              value={comp.thresholdDb}
              min={-60}
              max={0}
              step={1}
              format={(v) => `${v} dB`}
              onChange={(v) => s.tweakComp({ thresholdDb: v })}
              disabled={!comp.enabled}
            />
            <Slider
              label="Ratio"
              value={comp.ratio}
              min={1}
              max={20}
              step={0.5}
              format={(v) => `${v}:1`}
              onChange={(v) => s.tweakComp({ ratio: v })}
              disabled={!comp.enabled}
            />
            <Slider
              label="Attack"
              value={comp.attackMs}
              min={1}
              max={200}
              step={1}
              format={(v) => `${v} ms`}
              onChange={(v) => s.tweakComp({ attackMs: v })}
              disabled={!comp.enabled}
            />
            <Slider
              label="Release"
              value={comp.releaseMs}
              min={20}
              max={1000}
              step={10}
              format={(v) => `${v} ms`}
              onChange={(v) => s.tweakComp({ releaseMs: v })}
              disabled={!comp.enabled}
            />
            <Slider
              label="Makeup gain"
              value={comp.makeupDb}
              min={0}
              max={24}
              step={0.5}
              format={formatDb}
              onChange={(v) => s.tweakComp({ makeupDb: v })}
              disabled={!comp.enabled}
            />
          </div>
        </>
      ),
    },
    {
      id: 'output',
      label: 'Output',
      hint: 'Lower quality and mono make smaller files.',
      content: (
        <div className="tab-grid">
          <Select<OutputFormat>
            label="Format"
            value={s.format}
            onChange={s.chooseFormat}
            options={(Object.keys(FORMATS) as OutputFormat[]).map((f) => ({ value: f, label: FORMATS[f].label }))}
          />
          {FORMATS[s.format].bitrates.length > 0 && (
            <Select<number>
              label="Quality"
              value={s.bitrate}
              onChange={s.setBitrate}
              options={FORMATS[s.format].bitrates.map((b) => ({ value: b, label: `${b} kbps` }))}
            />
          )}
          {FORMATS[s.format].sampleRates.length > 0 && (
            <Select<number>
              label="Sample rate"
              value={s.sampleRate}
              onChange={s.setSampleRate}
              options={[
                { value: 0, label: 'Keep original' },
                ...FORMATS[s.format].sampleRates.map((r) => ({
                  value: r,
                  label: `${(r / 1000).toFixed(r % 1000 ? 2 : 0)} kHz`,
                })),
              ]}
            />
          )}
          <Segmented<0 | 1 | 2>
            label="Channels"
            value={s.channels}
            onChange={s.setChannels}
            options={[
              { value: 0, label: 'Keep' },
              { value: 1, label: 'Mono' },
              { value: 2, label: 'Stereo' },
            ]}
          />
        </div>
      ),
    },
  ];
}

/** Short description of the output settings, e.g. "MP3 · 128 kbps · Mono". */
export function outputSummary(s: ProcessingState): string {
  const f = FORMATS[s.format];
  const parts = [f.label.replace(/\s*\(.*\)/, '')];
  if (f.bitrates.length) parts.push(`${s.bitrate} kbps`);
  if (s.channels === 1) parts.push('Mono');
  else if (s.channels === 2) parts.push('Stereo');
  if (s.sampleRate) parts.push(`${(s.sampleRate / 1000).toFixed(s.sampleRate % 1000 ? 2 : 0)} kHz`);
  return parts.join(' · ');
}
