# Audio Editor

A browser-based audio editor for trimming, looping, changing volume, and compressing audio, for one file at a time or a whole batch. All processing happens locally with [ffmpeg.wasm](https://ffmpegwasm.netlify.app/), so files are never uploaded.

**Try it:** https://gamedevfishy.github.io/Audio-Editor/

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

## Editor

- **Trim:** drag the region edges on the waveform, drag across the waveform to start a new selection, or type exact Start/End times.
- **Keep or delete the selection:** *Keep* exports only the selection. *Delete* removes it and joins the rest with a 10 ms fade so the cut doesn't click. **Preview cut** plays 2 s before and 2 s after the cut.
- **Gapless loop (`L`):** plays the selection on repeat with no gap, through Web Audio. The loop keeps playing while you edit, so you can adjust the edges and hear the seam change.
- **Crossfade loop seam:** blends the last *n* ms into the start so the exported loop repeats without a click. The file gets *n* ms shorter. The preview matches the export sample for sample.
- **Nudge edges:** `[` and `]` choose the start or end edge. `←`/`→` move it 10 ms, with `Shift` 100 ms and `Ctrl` 1 ms. `↑`/`↓` inside a time field do the same.
- **Auto-trim silence:** selects the audible part, with the quiet threshold set from −70 to −30 dB.
- **Zoom:** a slider from 1× to 512×. **Zoom to selection (`Z`)** fits the selection to the view; **Fit** returns to the whole file.
- **Export:** the file name is editable (unsafe characters are removed). Title, artist, album, and comment are read from the source file and can be edited or cleared.

## Batch

- Drop in many files and apply the same Volume, Dynamics, and Output settings (shared with the editor) to each one.
- Optional extras: silence trim on both ends, a file-name suffix, and Artist/Album overrides. Each file otherwise keeps its own tags.
- Files are processed one at a time with per-file progress. Duplicate names get " (2)" added. A failed file doesn't stop the queue. **Stop after this file** ends the run early, and **Process all again** reruns everything with new settings.
- **Download all (.zip)** bundles the results (stored, not recompressed).

## Sound and output (both modes)

- **Volume:** ±24 dB, with an optional limiter so boosts don't clip.
- **Dynamics compression:** Gentle, Voice, and Heavy presets, or custom threshold, ratio, attack, release, and makeup gain.
- **Format:** MP3, M4A (AAC), Opus, or WAV, with a choice of bitrate, mono/stereo, and sample rate, plus a size estimate.

## Stack

| Part | Library |
|---|---|
| UI | React 18 + TypeScript + Vite |
| Waveform and selection | wavesurfer.js 7 (Regions and Timeline plugins) |
| Processing and encoding | @ffmpeg/ffmpeg 0.12 (single-threaded core, served locally) |
| Zip | fflate |

Code map:
- `src/lib/ffmpeg.ts`: probes files (duration, channels, tags), builds the `-filter_complex` graph (keep/crossfade/delete → silence trim → downmix → volume → compressor → limiter), encodes, and runs jobs one at a time.
- `src/lib/audioEdit.ts`: the loop buffer with crossfade, the cut preview, and silence detection. These mirror the FFmpeg graph.
- `src/lib/previewGraph.ts`: the Web Audio preview chain and the gapless buffer player.
- `src/components/Editor.tsx`, `Batch.tsx`: the two modes. `ProcessingPanels.tsx` holds the shared settings cards.

## Notes and workarounds

- **Rollup uses WebAssembly.** This machine's Windows Application Control policy blocks Rollup's native `.node` binary, so `package.json` overrides `rollup` with `@rollup/wasm-node`.
- **Opus stereo uses FFmpeg's built-in encoder.** `libopus` in ffmpeg.wasm 0.12 crashes on stereo input. Mono Opus still uses libopus.
- **Mono downmix is normalized** (`aresample=ochl=mono:rematrix_maxval=1`). Plain `-ac 1` came out about 3 dB louder in testing and can clip.
- **The engine restarts itself after a crash.** If the wasm engine crashes, it is reloaded and the job is retried once.
- **Memory:** looping, cut preview, and silence detection decode the whole file into memory once. Browser memory limits practical input size to a few hundred MB.

## License

This project is licensed under the **GNU General Public License v3.0 or later** (GPL-3.0-or-later). See [LICENSE](LICENSE).

### Third-party licenses

| Component | License |
|---|---|
| [@ffmpeg/core](https://github.com/ffmpegwasm/ffmpeg.wasm) (FFmpeg compiled to WebAssembly, bundled with the site) | GPL-2.0-or-later |
| [@ffmpeg/ffmpeg](https://github.com/ffmpegwasm/ffmpeg.wasm), [@ffmpeg/util](https://github.com/ffmpegwasm/ffmpeg.wasm) | MIT |
| [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) | BSD-3-Clause |
| [fflate](https://github.com/101arrowz/fflate) | MIT |
| [React](https://github.com/facebook/react) | MIT |

Source for the bundled FFmpeg core is available at https://github.com/ffmpegwasm/ffmpeg.wasm and https://ffmpeg.org.
