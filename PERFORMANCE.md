# Performance

An audit of where Fresyn spends its time -- the audio thread, the main thread,
and getting the page up -- and what to do about each. Written 2026-09-30 from
four separate passes over the code, each with its own measurements. The
**Status** column in the plan at the bottom says what has been done since.

How the numbers were taken:

- **DSP** figures are Node 24 (the same V8 as Chrome) on a Ryzen 7 3700X, at
  48 kHz in 128-frame blocks. One block has a budget of **2.667 ms**. Chrome's
  audio thread runs the same JIT, so the ratios carry over; the absolute
  headroom there is similar or a little worse, since it also handles messages.
- **UI** figures are headless Chrome driving the production build through
  puppeteer, on a fast desktop. Compare them with each other; a mid-range
  laptop is roughly 4-6x slower.
- **Loading** figures are headless Chrome against a local server sending
  brotli with the same cache headers as `public/_headers`, unthrottled and
  with 4x CPU and "slow 4G" throttling. The live site serves the same hashes.

## Summary

| Area | State | Key number |
|---|---|---|
| Loading | Good | 164 KB brotli on the critical path in 3 requests; rack live at ~150 ms, ~1.9 s at 4x CPU + slow 4G |
| First sound | OK | ~300 ms from the first press, because the worklet is fetched and built then |
| UI interaction | Mixed | 70-110 components re-render per knob pointermove; dock resize costs ~21 ms of style per move on a big rack |
| Audio thread | **Over budget** | 8 tracks: 4.0 ms a block against 2.67 ms (0.7x realtime). Idle: 916 us a block |
| Offline bounce | Poor | A 64 s mix takes 81 s; its stems 7.6 minutes, all on the UI thread, and it stops in a background tab |

The loading path was already in good order. The UI was decent with some
expensive specifics. **The audio engine's structure was the real problem**:
cheaper maths alone was worth about 10%.

## Results

Steps 1 to 5 of the plan below are done; all twenty check suites pass. Measured
the same way as the audit, before and after.

**The audio engine** (`GraphEngine` is now block-based; see the README):

| Scenario | Before | After | |
|---|---|---|---|
| 4-track song | 1968 us a block, 1.35x realtime | 594 us, 4.49x | 3.3x |
| 8-track song | 3817 us, **0.70x** realtime | 1188 us, **2.24x** | 3.2x |
| 16-track song | 7155 us, 0.37x | 2191 us, 1.22x | 3.3x |
| 8 tracks idle | 982 us | 143 us | 6.9x |
| Worst single block, 8 tracks | 4.82 ms (over budget) | 1.68 ms | |
| One voice (strings / warmpad / epiano) | ~131 / 134 / 139 us | ~66 / 56 / 52 us | ~2.2x |
| All 112 instruments, 3 renders each | 81.8 s | 32.6 s | 2.5x |
| GC scavenges, 20 s of the busy 8-track song | 1841 | 959 | |
| `npm run check:fast` | 512 s | 193 s | |

The old engine and the new agree to the bit when the new one is stepped a
sample at a time (`GraphEngine.forceStepwise`), across every instrument as a
take, as a song track and on one voice; that is how each module's conversion
was proved. Running in blocks, voices, pads and resting effects change state
at the end of a block rather than on the exact sample, which leaves tails
under -80 dB a few samples longer: renders differ from the old engine by
under 7e-5, bar a handful of wind instruments whose reused voices start their
next note at a different oscillator phase -- the same sound, a different
waveform.

**The UI** (headless Chrome, production build, 60 pointer moves):

| Scenario | Before | After |
|---|---|---|
| Knob drag, stock rack: components rendered / script | 4138 / 73 ms | 710 / 54-60 ms |
| Knob drag, 45 units: components rendered / main-thread task | 6540 / 990-1050 ms | 710 / 720-785 ms |
| Dock resize, 40 moves, big rack: style / commits | 900-912 ms / 81 | 9-10 ms / 40 |
| Compositing layers, stock rack / 45 units | 37 / 200 | 7 / 11 |
| Cable hover, components rendered | 45 | 10 |

**Offline work** (a 6-track song, 20 s of audio, in Chrome):

| Scenario | Before: longest task / main thread blocked | After |
|---|---|---|
| Song, WAV | 534 ms / 17.5 s | no long tasks / 0 |
| Song, FLAC | 2044 ms / 19.7 s | no long tasks / 0 |
| Stems, WAV | 516 ms / 103.6 s | no long tasks / 0 |
| Stems, wall time | 5.8x the mix | 1.1x the mix, identical output |

A bounce also finishes in a background tab now, where it used to stop.

**Memory and messages.** Where the page is cross-origin isolated -- it now is,
in production as well as in development -- a decoded sample is held once and
shared by the page, the worklet and the bounce worker, instead of copied to
each; each file is sent to the worklet once rather than the whole library on
every drop; and the meters and scopes are written into shared memory, so a
report is a clock and a slot number instead of two cloned 16 KB frames.

## The audio thread

### Measured

- An 8-track song (strings, epiano, synthbass, sawlead, warmpad, drumkit,
  guitar, brass; 3-note chords every 2 s; console on) ran at **0.7x
  realtime, 4.0 ms a block** -- 150% of the budget. 4 tracks: 1.3-1.4x. 16
  tracks: 0.4x. The worst single blocks were 6-14 ms.
- One pad holding 4-note chords: strings 896 us a block (34% of budget),
  glasspad 982 us, stringmachine 1108 us. Across ~100 instruments the mean was
  347 us.
- Voices cost about **100 us each a block**, linearly: strings takes 122 us
  with none sounding, 259 / 356 / 551 / 940 us with 1 / 2 / 4 / 8.
- **Silence was expensive**: 8 tracks with nothing playing, 916 us a block
  (34%). The console alone, 45 us.
- **The structure mattered far more than the maths.** A hand-fused,
  block-at-a-time copy of the default patch's voice -- the same arithmetic,
  two `tanh` a sample and all -- cost 7.6 us a voice a block against the
  engine's 44 us: **5.8x**. Swapping `tanh`, `exp`, `pow` and `tan` for cheap
  approximations gained only ~10%.
- About **170 MB of garbage per second of audio** for one strings rack, with a
  minor GC roughly every 80 ms of live playback.

Per module, ns per sample per instance (default knobs, fed a saw):

| Module | ns | Module | ns | Module | ns |
|---|---|---|---|---|---|
| mixer | 263 | osc | 151 | quant | 83 |
| reverb | 221 | delay | 134 | drive | 79 |
| ladder | 187 | gran | 122 | lfo | 75 |
| voice | 178 | res | 104 | comp | 67 |
| chorus | 175 | svf | 90 | keys / gate | 18 / 10 |

The cheapest modules show the floor that dispatch alone costs.

CPU profile of the 4-track song, by self time: `OscModule.process` 28%,
`GraphEngine` render/renderSpan/runPoly ~18%, Mixer 7%, LadderFilter + Ladder
7%, Reverb 5%, PolyBlepOsc 5%, VCA 4%, CvUtil 3%, Envelope 3%, GC 1.2%.

### Findings

1. **HIGH -- an interpreted, per-sample graph.** `renderSpan`
   (`src/dsp/GraphEngine.ts`) loops over samples and, inside that, calls
   `modules[m].process(slots)` for every module. With ~40 classes behind one
   call site V8 cannot inline it: 23 ns a call, against 2.45 ns for the same
   work as a loop over a block (9.5x). `runPoly` does the same per voice, and
   also copies broadcast inputs into each voice's slots and sums the outputs
   back, per sample, per poly module.
2. **HIGH -- boxing from helpers that are not inlined.** In the big
   `process()` bodies V8 runs out of inlining budget, so helpers such as
   `PolyBlepOsc`'s `naive`/`wrapPhase`, `DelayLine.read`, `OnePole.process`,
   `DcBlocker.process`, `LadderFilter.process` and `LiveLoudness.push` stay
   real calls, and every double through them becomes a heap number. Bytes
   allocated per sample per instance: delay 101, mixer 100, chorus 87, osc 85,
   ladder 84, reverb 69, voice 68, lfo 52 (the floor is 4).
3. **HIGH -- nothing sleeps.** Muted tracks render (on purpose, to keep
   clocks in phase), voice 0 never sleeps at Voices 1, and the desk's Space
   and Delay run with nothing sent to them. Every track's Mixer measures
   K-weighted loudness (four biquads) a sample, though only the watched
   track's is reported: ~270 us a block across 8 tracks on that alone.
4. **MED -- per-sample work for knobs that are not moving.** Osc runs 7
   smoother `set`/`next` pairs and 6 envelope writes a sample; Mixer
   recomputes 8 channel gains a sample; Kit, 16 pads' gains and 48 smoothers.
5. **MED -- patch edits rebuild on the audio thread.** Every edit posts the
   whole `CompiledPatch` (including `paramIndex`, `warnings` and
   `feedbackCables`, which the worklet never reads): ~0.8 ms to clone and
   0.3-0.6 ms to rebuild a drum kit, inside one quantum. Every module in a
   poly chain is built 8 times even at Voices 1, and each Delay copy
   allocates its 2 s line (3 MB per poly Delay).
6. **MED -- transcendentals that could be cached.** `Envelope` calls `exp`
   per sample per stage; `expCv` calls `pow` even with nothing patched;
   Ladder and Svf call `tan` per sample; Voice takes `exp` of a constant per
   sample; Resonator, Formant and Compressor retune per sample. Worth ~10%
   in total.
7. **LOW -- reports.** The frame report (~30 Hz) builds fresh records and
   clones two 4096-float scope snapshots each time: ~33 KB of garbage a
   report, ~20 us.
8. **LOW** -- per-sample NaN guards (1-2 ns each); the Delay tail settles at
   5.6e-45, the smallest float32, and never reaches zero, so any silence test
   must use a threshold; `queue.shift()` and `splice` in the event queue.
9. **LOW** -- the worklet build lowered class fields to `defineProperty`
   helpers (449 of them) because Vite's default target predates ES2022.

## The main thread's audio work

- **HIGH -- offline work runs on the UI thread.** `renderSong`,
  `renderStems`, takes, FLAC, WAV and the lossy encoders all run on the main
  thread. The bounce yields every 0.5 s of *audio*, so at 0.8x realtime each
  slice freezes the UI for ~600 ms. 64 s of a 6-track song took 81 s.
- **HIGH -- long jobs stop in a background tab.** `nextFrame` yields with
  `requestAnimationFrame`, which hidden tabs never fire.
- **HIGH -- stems are O(N^2).** Each stem is a whole `renderSong` with the
  other tracks muted, and a muted track still renders: 6 stems took 5.7x the
  mix. Every stem's PCM is held until encoding starts.
- **HIGH -- `setSamples` re-sends the whole decoded library** by structured
  clone on every sample drop and every bench switch, and the worklet
  deserializes it between quanta: ~4 ms for 12 MB, an audible drop while
  playing. Each sample is held twice (main thread and worklet) plus a
  transient third copy per re-send.
- **MED -- knob to sound goes through a React commit.** The param is posted
  from an effect after render, commit and paint: 1-2 frames of lag.
- **MED -- the play anchor is in the past.** `advance()` anchors to the frame
  in the last report, which the worklet is already past, so the downbeat lands
  late and early notes bunch into one block.
- **MED -- the context never suspends**, rendering every track and posting 30
  reports a second forever once started.
- **MED -- FLAC is ~11x realtime** and synchronous: 16 s of frozen UI for a
  3-minute song.
- **LOW-MED** -- the playhead steps at the report rate and leads the audio by
  the output latency (150-250 ms on Bluetooth); `heardTick()` already knows
  better. Recording stamps notes with handling time, not event time.

Already right: knob edits send one small `param` message per changed key,
never whole patches; display data flows through subscriptions, not React
state; song scheduling runs off the worklet's own sample clock, so it survives
main-thread stalls up to ~215 ms and keeps going in background tabs.

## The UI

Measured, 60 pointer moves unless noted:

| Scenario | Commits | Components rendered | Main-thread task |
|---|---|---|---|
| Knob drag, stock rack (5 units, 858 nodes, 37 layers) | 61 | 4200-4500 | 210-260 ms |
| Knob drag, 45-unit rack (12k nodes, 201 layers) | 62 | 5610-6900 | 770-1130 ms |
| Same, knob pinned at max (nothing changing) | 62 | 2880 | 205 ms |
| Dock resize, 40 moves, big rack | 43-115 | 2170 | 1650-1920 ms (style 820-880 ms) |
| Cable drag | 65 | 422 | 128-158 ms |
| Big rack with the 3D flip flattened | -- | -- | layers 201 -> 11; roll hover 306 -> 116 ms |

1. **HIGH -- dock resize restyles the app.** The dock height is App state
   written into `--dock-h` on `.app` every pointermove: App and every unit's
   boundary re-render, and an inherited custom property changes on the root
   of 12k nodes. ~21 ms of style a move.
2. **HIGH/MED -- every face is a compositing layer, always.** `.unit-flip`
   keeps `transform-style: preserve-3d` and both faces keep
   `backface-visibility: hidden` at rest, not just while turning. 201 layers
   for 45 units, and GPU memory in proportion.
3. **MED -- every knob move re-renders App and every unit's boundary.** A
   fresh `onRemove` closure per render reaches the class `UnitBoundary`;
   `MenuBar` is rebuilt and re-rendered; `KnobHelpCard` is not memoized.
4. **MED -- moves that change nothing still commit.** `setParam` always
   spreads new `values`.
5. **MED -- inside a unit every control and back-panel jack re-renders**
   (inline `onChange` closures; `Control`, `Knob`, `BackPanel`, `Jack`
   unmemoized).
6. **MED -- every patch edit is two commits.** `measure()` reads every jack
   and sets a new geometry object even when the rack faces front and nothing
   moved.
7. **MED -- the song dock rebuilds the roll's note arrays each render**, so
   the roll does a full redraw and an O(n) compare.
8. **MED -- the roll repaints everything on every dirty frame** (and during
   playback every frame): rows, grid, ruler text, every note, with no
   horizontal culling.
9. **LOW-MED** -- playlist clips are DOM + SVG with no virtualization; roll
   scrolling goes through React state per wheel event; each scope runs its
   own rAF forever and draws even when hidden or offscreen; cable hover
   toggles a class on the whole rack; a non-passive `wheel` listener on
   `window` makes scrolling wait on the main thread.

Already right: undo history is structurally shared (no cloning), capped and
coalesced; context values are stable; cable drag re-renders only the loose
cable; meters share one loop and write the DOM directly; roll drags go through
refs with no commits.

## Loading and storage

| Chunk | When | Raw | gzip | brotli |
|---|---|---|---|---|
| index js | critical | 312,320 | 102,953 | 87,275 |
| react js | critical (modulepreload) | 223,094 | 69,034 | 59,564 |
| index css | critical | 112,921 | 21,830 | 17,003 |
| **critical total** | | **648,335** | **193,817** | **163,842** |
| PianoRoll / Playlist | after mount | 70,874 | 24,823 | 22,516 |
| worklet | first sound | 76,588 | 23,483 | 20,698 |
| instruments / LibraryDialog | library opened | 105,204 | 24,826 | 21,215 |
| render / renderSong / encoders | take or bounce | 82,616 | 27,190 | 24,520 |
| ogg / mp3 wasm | that bounce only | 583,588 | 228,885 | 185,475 |

| Scenario | Rack live | Long tasks |
|---|---|---|
| Cold, unthrottled | 151 ms | 79 ms |
| Cold, 4x CPU | 562 ms | 68 + 371 ms |
| Cold, 4x CPU + slow 4G | 1876 ms | 65 + 369 ms |
| Warm HTTP cache, 4x + slow 4G | 403 ms | 107 ms |
| 2.2 MB autosaved project, 4x CPU | 727-754 ms | 517-537 ms |

1. **HIGH (felt)** -- first sound waits for `new AudioContext`, the worklet's
   fetch and compile, and the node's construction, all after the press.
2. **MED** -- no service worker, so every visit pays a round trip before any
   bytes, and there is no offline start.
3. **MED** -- autosave stringifies the whole project and writes it with a
   synchronous `setItem`: ~40 ms at 4x CPU for 2.2 MB, and it runs once on
   every boot for an unchanged project. localStorage caps a project at
   roughly 70k notes.
4. **MED** -- the sample prune at boot opens a cursor over every stored
   sample, reading the bytes to find ids and dates, in a readwrite
   transaction that every later sample read queues behind. Hydration is
   serial: one read and one decode at a time.
5. **LOW-MED** -- the build target is Vite's default (class fields lowered,
   ~6 KB a chunk); ~57 KB minified of dialogs and dock views sits in the
   main chunk; both faces of every unit render at mount.

Already right: `instruments`, `library`, the roll, the playlist, render,
encoders and wasm are lazy; no fonts; no AudioContext at boot; assets are
immutable and brotli'd (wasm too); the critical three download in parallel.

## Correctness bugs found on the way

All four are fixed.

1. **Samples only hydrated for the benched track**: after a reload, a
   Sampler or kit pad on any other track had no audio -- in the song and in a
   bounce -- until that track was opened.
2. **The scope's B trace inside a Drum Kit pad** was looked up by module id
   while the A trace uses the engine id, so it never showed.
3. **Long jobs halted in background tabs** (see above).
4. **Firefox asked for storage permission on load**, from `askToPersist()`.

## The plan

Tiers run from an hour's hygiene to rewrites. Steps 1-5 are the order chosen;
the rest is recorded for later.

| Step | Work | Status |
|---|---|---|
| 1 | Tier 0 hygiene and the four bugs | done |
| 2 | Sleep states, lazy voices, settled smoothers, hot-helper inlining | done, in part -- see below |
| 3 | Dock resize, flip layers, the React memoization pass | done |
| 4 | Block-based engine | done |
| 5 | Offline work in a Worker; SharedArrayBuffer samples and telemetry | done |

What step 2 left out, and why:

- **Whole-track sleep, and sleep for voice 0 at Voices 1.** Both would skip a
  rack that has no note playing -- but a rack can sound with no note at all,
  an LFO opening a VCA on a drone, and a sleeping one would miss it. Resting
  effects (a filter, reverb or mixer fed silence) got most of the idle saving
  without that risk: 8 idle tracks went from 982 to 143 us a block.
- **Hot-helper inlining** was done for the Ladder, the heaviest (its filter
  now runs over a block, `LadderFilter.run`). The oscillator core, the
  envelope and the delay line are still called a sample at a time; the
  remaining garbage is theirs, and the block engine has already halved it.

### Tier 0 -- hygiene

- `build.target: 'es2022'` for the page and the worker; no modulepreload
  polyfill.
- Prefetch the worklet at idle after mount.
- `setParam` returns the rack unchanged when the value is unchanged.
- Skip autosaves of an unchanged project, including the one on every boot.
- Yield long jobs on a wall-clock budget through a macrotask, not rAF.
- Post a knob's value to the engine from the handler, before the commit.
- Precompute the scope's Hann window; cache canvas sizes.
- `expCv` short-circuits with nothing patched; Envelope caches its stage
  coefficient; Voice hoists its constant `exp`.
- Loudness only while a panel is reading it.
- Drop the `/index.html` rule in `_headers` (Pages serves `/`).

### Tier 1 -- targeted

UI: dock resize through a ref; 3D only while turning; stable boundary props
and memoized menus; memoized controls, back panel and jacks; skip `measure()`
facing front and keep geometry that did not move; memoized dock note arrays;
roll playhead on an overlay with a cached static layer and culling; scopes on
the shared loop, honouring visibility; cursor set directly for cable hover;
the window `wheel` listener scoped.

Audio: stems render only their own tracks, encoded as they finish; samples
sent incrementally; track sleep, mono voice sleep, idle desk returns,
auto-suspend when silent and stopped; lazy voice copies; smoothers skipped
when settled; hot helpers inlined; play anchor ahead of the worklet;
`heardTick()` for the playhead; event timestamps for recording; cosmetic
patch fields ignored when deciding to recompile; a faster FLAC encoder.

Loading: prune by key cursor at idle, after hydration; parallel hydration;
lazy dialogs, dock views and knob help; back panels after the first flip;
compile other tracks' patches at `start()`.

### Tier 2 -- architectural

1. **Block-based engine** -- modules process 128-sample blocks; only the
   members of a feedback loop keep the per-sample path. Expected 2-5x.
2. **Offline work in Workers** -- bounce, stems, takes and encoding off the
   UI thread, stems in parallel.
3. **SharedArrayBuffer** -- COOP/COEP in production; decoded samples in SABs
   (immutable, one copy); then meters, scopes and the transport frame; then a
   param/MIDI ring.
4. Warm audio engine -- a suspended context, worklet and node built at idle,
   so a press only resumes. (Changes the "opened by a gesture" design.)
5. Service worker -- precached assets, HTML stale-while-revalidate, offline.
6. Autosave to IndexedDB, writing only dirty records.
7. Knob drags outside React, committed once a frame or on release.
8. Virtualized playlist clips.

### Tier 3 -- moonshots

1. **A generated render function per patch** -- JS source built on the main
   thread and evaluated in the worklet, with module state as locals and one
   monomorphic loop per voice. The fused-voice experiment measured 5.8x.
2. **WASM + SIMD across voices** -- the 8 voice copies are identical, so
   f32x4 fits; no GC. Plausibly 5-10x, at the cost of a ~5000-line rewrite.
3. **The song scheduler inside the worklet** -- immune to main-thread
   stalls.
4. **Tracks rendered ahead by Workers** into SAB rings: true multi-core
   playback for sequenced tracks (extra worklets share one audio thread).
5. **A prerendered static rack** hydrated on load: first paint on slow 4G
   from ~1.9 s to ~0.7 s.
6. **Preact/compat** -- ~48 KB brotli off the critical path.
7. **React Compiler** -- most of Tier 1's memoization for free.

Not worth doing: OffscreenCanvas in a worker (drawing is under 1 ms; the
waste is redundant redraws), virtualizing the rack (it fights cable
geometry), splitting the theme CSS (a few KB after brotli), turning
instruments into JSON (already lazy).
