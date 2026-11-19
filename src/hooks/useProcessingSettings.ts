import { useMemo, useState } from 'react';
import { FORMATS, type CompressorSettings, type OutputFormat, type ProcessSettings } from '../lib/ffmpeg';

export type Preset = 'off' | 'gentle' | 'voice' | 'heavy' | 'custom';

export const PRESETS: Record<Exclude<Preset, 'off' | 'custom'>, Omit<CompressorSettings, 'enabled'>> = {
  gentle: { thresholdDb: -18, ratio: 2, attackMs: 20, releaseMs: 250, makeupDb: 2 },
  voice: { thresholdDb: -24, ratio: 4, attackMs: 5, releaseMs: 150, makeupDb: 6 },
  heavy: { thresholdDb: -32, ratio: 8, attackMs: 2, releaseMs: 100, makeupDb: 10 },
};

/** Volume, dynamics and output settings — shared by the editor and batch mode. */
export function useProcessingSettings() {
  const [gainDb, setGainDb] = useState(0);
  const [limiter, setLimiter] = useState(true);
  const [preset, setPreset] = useState<Preset>('off');
  const [comp, setComp] = useState<CompressorSettings>({ enabled: false, ...PRESETS.voice });
  const [format, setFormat] = useState<OutputFormat>('mp3');
  const [bitrate, setBitrate] = useState(FORMATS.mp3.defaultBitrate);
  const [channels, setChannels] = useState<0 | 1 | 2>(0);
  const [sampleRate, setSampleRate] = useState(0);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    if (p === 'off') setComp((c) => ({ ...c, enabled: false }));
    else if (p === 'custom') setComp((c) => ({ ...c, enabled: true }));
    else setComp({ enabled: true, ...PRESETS[p] });
  };

  const tweakComp = (patch: Partial<CompressorSettings>) => {
    setPreset('custom');
    setComp((c) => ({ ...c, ...patch, enabled: true }));
  };

  const chooseFormat = (f: OutputFormat) => {
    setFormat(f);
    setBitrate(FORMATS[f].defaultBitrate);
    if (sampleRate && !FORMATS[f].sampleRates.includes(sampleRate)) setSampleRate(0);
  };

  const process: ProcessSettings = useMemo(
    () => ({ gainDb, limiter, compressor: comp, format, bitrateKbps: bitrate, channels, sampleRate }),
    [gainDb, limiter, comp, format, bitrate, channels, sampleRate],
  );

  return {
    process,
    gainDb,
    setGainDb,
    limiter,
    setLimiter,
    preset,
    choosePreset,
    comp,
    tweakComp,
    format,
    chooseFormat,
    bitrate,
    setBitrate,
    channels,
    setChannels,
    sampleRate,
    setSampleRate,
  };
}

export type ProcessingState = ReturnType<typeof useProcessingSettings>;
