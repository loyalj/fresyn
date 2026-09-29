# Fresyn

A browser-based modular synth lab for designing procedural game SFX, in the
shape of a hardware rack. It runs at **https://fresyn.dblpl.us**.

**New here? Read [MANUAL.md](MANUAL.md)** -- what every module does, and
twenty-two tutorials that build a laser, a footstep, computer chatter, wind,
an explosion, a siren, a water drop, an engine, a power-up, a sync zap, a
ricochet, a machine gun, an alien transmission, an arpeggio, a sci-fi door, a
bell, a coin, rain, a fly, a struck pipe, a jet flyby and a charge-up.

What changed, and when, is in [CHANGELOG.md](CHANGELOG.md).

## Run it

Needs Node 20 or newer. The browser checks also need Chrome.

```
npm install
npm run dev          # http://localhost:5173
npm run build        # type-check, then a production build in dist/
npm run deploy       # check:fast, build, then publish dist/ to Cloudflare Pages
```

`deploy` runs the headless checks first and stops if any fail, so a broken
DSP change cannot reach the live site by accident. It publishes with
`wrangler`, which has to be logged in to the account that owns the `fresyn`
Pages project.

## The rack

The rack is yours to build: add and remove modules, reorder them, name a
patch and it autosaves, export and import patches as JSON. A row of the rack
holds one full-width panel or two half-width ones: the panels that need the
room -- the oscillator, the keyboard, the sequencer, the mixer, the scope, the
recorder and the like -- take a whole row, and the rest take half of one and
pair up with whatever half panel is next to them. F flips the rack to drag
cables on the back panel, and every edit recompiles and rewires the running
graph in place, so it keeps playing while you work.

Knobs are dragged up and down, nudged with the mouse wheel for fine work --
which leaves the page scrolling everywhere that is not a knob -- and reset by
double-clicking. Shift makes either gesture five times finer. Tab moves the
focus, and a focused knob, switch or jack takes the keys its kind of control
is expected to take.

Space holds the gate for the whole rack; a trigger button on a panel fires
just that module. F flips the rack, and Ctrl+Z / Ctrl+Shift+Z step through
history. On the back panel, drag between jacks to patch; drag out of a jack,
click a cable, or right-click a jack, to unplug. A unit is dragged up and down
the rack by the strip down its left edge, from either face; hovering one on
the back reveals the buttons that move it a row or pull it out. The bar across
the top is a panel of its own, bolted to the head of the rails: it stays put
while the rack scrolls under it, and it carries the menus -- Project, Edit,
Patch, Modules and View. A module chosen from the Modules menu arrives at the
top of the rack, where the menu that added it is, rather than off the bottom
of a rack that may be pages long.

The dock under the rack holds the music: a piano roll that plays whatever is
on the bench, tracks with a rack each, patterns placed on a playlist, and a
mix view. **Bounce song** and **Bounce stems** render the arrangement to WAV,
FLAC, OGG Vorbis or MP3 at the rate you choose, and **Export MIDI** writes the
notes.

The rack can be repainted. A *theme* is a family of colours and each one comes
in dark and light -- Standard, the original studio grey and amber; Fall Cafe in
oat milk, kraft paper and dried leaves, going to espresso and plum after
closing; Neon Vice, whose pink and blue tubes keep their jobs in both modes;
Mesa in sun-struck adobe, clay and sage; Terminal 80s, a green phosphor tube
that becomes electric orange on sepia with the lights on; Halloween, pumpkin
and witch purple, candy corn by day; True North, snow white between maple-red
rack ears; Deep Sea, bioluminescence in the abyss and a reef by day; Arcade, a
black cabinet and its side art; Blueprint, white lines on drafting blue or
pencil on graph paper; Winter Holiday, pine, cranberry and gold; Vaporwave,
aqua over a pink-to-purple sunset; and Tube Amp, Tolex, chicken-head knobs and
valve glow. The two are separate choices, so picking light does not drop you
back into the standard palette. The change cross-fades and is remembered.

## Checks

```
npm run check              # everything: the headless checks, then the browser ones
npm run check:fast         # the headless checks only; what deploy runs
npm run check:browser-all  # every browser suite, sharing one dev server
```

The aggregates run every suite even after one fails and finish with a table
of what passed and how long each took. Any one can be run on its own:

```
# headless
npm run check:dsp          # compiler and graph engine
npm run check:patch        # rack editing and the save format
npm run check:render       # offline render, WAV and zip
npm run check:song         # the arrangement, scheduling, and SongPlayer
npm run check:manual       # every patch the manual teaches, rendered
npm run check:instruments  # every library instrument, built, played and in tune
npm run check:modules      # audits every module in the catalogue
npm run check:theme        # every palette: tokens, and contrast where it lands

# in a real browser
npm run check:browser      # the worklet, the meters, offline render, autosave
npm run check:cables       # drags cables on the back panel
npm run check:input        # the keys and the pointer the app claims
npm run check:rack         # rack editing, the library, persistence, files
npm run check:export       # render, audition and save takes
npm run check:roll         # the music dock: notes, tracks, playlist, bounce
npm run check:sampler      # a real WAV through the Sampler, and back out
npm run check:scope        # the scope, read back off the canvas
npm run check:tools        # search, bypass, copying, cable colours, shelves
```

The headless checks are TypeScript that imports the real DSP and patch code;
`scripts/run-ts.mjs` bundles each with esbuild into `node_modules/.cache` and
runs it. The browser suites share `scripts/harness.mjs`, which starts Vite in
the same process on a free port, so no second terminal is needed. Set
`DEV_URL` to point them at a server that is already running instead, and
`CHROME_PATH` if Chrome is not where the harness looks for it (the usual
install paths on Windows, macOS and Linux).

## Decisions

**All DSP lives inside a single AudioWorklet**, written by hand, rather than
being assembled from native Web Audio nodes. Native nodes cannot do hard sync,
PWM or a real ladder filter, and any feedback loop built from them costs 128
samples of delay -- which rules out a large share of what makes a modular worth
patching. One worklet containing the whole graph keeps everything
sample-accurate and makes feedback patches possible.

**The DSP is plain TypeScript over `Float32Array`**, with no allocation in the
render path. This is fast enough for the voice counts in scope, and keeping the
classes free of any Web Audio dependency leaves a Rust/WASM port available
later without a rewrite.

**Every module is audited as a catalogue, not one at a time.**
`check:modules` drives each module's knobs to both ends of their ranges, in
pairs and in seeded mixtures, with every input fed a steady full-scale signal
and then an audio-rate one, and holds the result to a ceiling that module
should actually respect rather than to a blanket "has it exploded" limit. It
also proves every knob reaches the DSP at all, which is the one failure
nothing else would catch: parameters are addressed by integer index on the
audio side and by order in `defs.ts` on the other, and a knob that has come
loose still compiles and still makes a sound.

**Pairs, because one knob hides another.** Driving every knob to its maximum
together is a single corner of the space, and it is a misleading one: on the
oscillator it also sets Env Amt to 1 and Attack to two seconds, so the
envelope holds the module silent and anything wrong underneath goes unseen.
Sweeping pairs against otherwise default settings is what exposed the
oscillator running past the sample rate.

**The oscillator clamps its frequency to Nyquist.** The phase wrap subtracts
one period, so a phase step larger than a whole cycle leaves the phase past
the end of its cycle and the remainder accumulates every sample after that --
a saw reaches 1e8 within a second. Pitch at 4 kHz with FM Amt at +4 and any
sustained modulator is enough to get there, and there is no waveform left to
represent above Nyquist anyway.

**The triangle comes from the phase, not from integrating the pulse.**
Integration is a legitimate way to build one, but it has to leak to stay
bounded, and a fixed leak is a fixed time constant: it erased the shape
entirely below about 20 Hz, which is most of an LFO's range. Worse, the pulse
it integrated carries DC whenever the width is not 0.5, and integrating that
produced an offset that grew with frequency -- 261 at 2 kHz. Reading the
tilted triangle straight off the phase is exactly +/-1 and exactly zero-mean
at every width and rate, and its two corners are rounded with polyBLAMP, the
slope-discontinuity counterpart of the polyBLEP that rounds a step. Measured
against an 8x oversampled reference the error fell from +12.8 dB -- larger
than the signal -- to -47 dB.

**A pulse's falling edge is corrected at `phase - pw`.** It had been read at
`phase + pw`, which is the same thing only for a square wave and wrong at
every other width, leaving the falling edge unsmoothed. Worth about 8 dB of
alias rejection at a width of 0.25, and invisible in any test that only ever
looked at a 50% pulse.

**Anything that multiplies a signal is smoothed**, including the "amount"
knobs that scale a modulation before it is applied: Env Amt and FM Amt on the
oscillator, CV Amt on the filter and the VCA, Level on the noise source and
Depth on the LFO. These scale their input directly, so a raw jump in one is
a click for the same reason a raw jump in a level is.

**The LFO shares the oscillator's core**, so it also shares Width and a PWM
input. That is worth more on an LFO than on an oscillator: a pulse narrowed
to a sliver is a periodic trigger, which the rack otherwise had no way to
make, and because the core builds its triangle by integrating that pulse,
Width tilts a triangle from a down-ramp to an up-ramp as well.

**Parameters are defined once**, in `src/audio/params.ts`. The UI builds knobs
from that table and the worklet indexes its value array by the same order, so
the two cannot disagree about what a slot means.

**Initial state is passed through `processorOptions`, not `postMessage`.** A
message posted to an `AudioWorkletNode` before `startRendering()` is never
delivered to the processor, so a message-driven trigger renders silence
offline. Since deterministic offline rendering is the basis of the planned
export workflow, no part of it may depend on message timing.

**The graph advances one sample at a time, not one block at a time.** That
costs per-sample call overhead and buys the two things a rack cannot do
without: audio-rate modulation of any input, and feedback cables that cost a
single sample. Stepping a block at a time would make every cycle cost a whole
128-sample block, which is the native Web Audio limitation this engine exists
to avoid. Signals live in one flat slot array, so a back edge gets its
one-sample delay for free by reading a slot its producer has not written yet.

**Cycles are legal.** The compiler reports the cable it cut rather than
rejecting the patch. Which cable that is depends on where the traversal enters
the loop; any edge of a cycle is a valid cut, and the delay is one sample
either way.

**One cable per input, fan-out on outputs**, as on hardware. A second cable
into an occupied jack replaces the first. Summing is therefore something a
module does, which is what the mixer is for.

**Parameters are seeded before `prepare()`.** Modules read their parameters
once to initialise smoothers, so applying a loaded patch's values afterwards
makes every knob glide up from the default -- an audible swoop on patch load.

**A patch edit rewires the graph rather than rebuilding it.** `GraphEngine`
keeps the running instance of every module that survived the edit, so filter
states, envelope stages and LFO phases carry across. Rebuilding from scratch
on each edit would click and drop notes every time a cable moved. Rebuilding
with an unchanged patch is sample-identical to never having rebuilt at all,
which is what `check:dsp` asserts.

**All browser input is captured in one place**, in `src/input`. Listeners run
in the capture phase on `window`, ahead of anything focused, so a claimed key
never reaches a focused button as well as its binding. Keys are swallowed on
every keydown including auto-repeat: handling only the first press and
returning early on `e.repeat` is exactly what lets a held Space scroll the
page. Right-click belongs to the rack, and middle-click autoscroll, drag
selection and ctrl-wheel zoom are suppressed.

Deliberately *not* captured, so the page never becomes a trap: anything with
Ctrl, Meta or Alt held, and anything typed into an input, textarea or
contenteditable. A key held while the window loses focus is released, since
its keyup is never delivered and the gate would otherwise stick open.

**The envelope graph is drawn by running the envelope.** The curve comes from
the same class the audio thread runs, at whatever sample rate makes the shape
exactly as many samples wide as the graph is columns. Drawing it from straight
line segments would be easier and would quietly lie -- the stages are
exponential, and the picture would stop matching the sound the moment either
changed.

**One envelope implementation, two facades.** `Envelope` is DAHDSR; with
delay and hold at zero it is bit-identical to the four-stage version that came
before, which is what let the standalone Envelope module keep its behaviour
while the oscillator gained six stages.

**`Env Amt` defaults to zero.** An oscillator therefore still passes a plain
continuous tone, because every patch saved before it had an envelope expects
exactly that. Turning it up blends the envelope into the oscillator's own
level; the Env jack carries the shape regardless.

**The whole editable state is one document**, and undo is a history of it:
patch, knob positions and name together. Rapid edits to the same control fold
into one step, so a knob drag is one undo rather than sixty. Whether to fold
is decided outside the state updater, because StrictMode runs updaters twice
and a timestamp read inside one would give the two passes different answers.

**Knob values reach the engine through one path.** Every change -- a drag, an
undo, a patch load -- goes through `setValues`, which sends only what actually
differs. A drag then costs one scan of a few dozen numbers per frame, and
undo needs no special case to be heard.

**Bindings may claim modifier combinations, but only explicitly.** Ctrl+Z is
intercepted because a binding asks for it; every other modifier combination
still belongs to the browser, and anything typed into a field belongs to the
field -- including Ctrl+Z, so undo in the patch-name box undoes text.

**Randomness is seeded, never `Math.random`.** Reproducible renders are what
the export workflow is built on: a variation batch is one patch under a series
of derived seeds, and a bug is only worth reporting if the sound can be made
again. Each module gets its own stream, derived from the patch seed and its
id, so adding one LFO does not reshuffle what every other module hears.

**Renders run the engine directly, not an `OfflineAudioContext`.** The result
is then exactly what the rack plays, and it avoids the message-delivery
problem that makes an offline context render silence. Jitter between takes is
applied in normalised knob space rather than to raw values, so a tenth of the
travel means the same musical amount at the bottom of a cutoff sweep as at the
top; switches are left alone, since a footstep that randomly becomes a sine
wave is not a variation of the same sound.

**A patch is self-contained on the way out.** Knob positions live separately
while editing, keyed `moduleId.paramId`, and are baked into their modules when
saved. Loading is deliberately defensive: files get hand-edited and outlive
the module list they were written against, so an unknown module type, a
duplicate id, a cable to nothing or an out-of-range value is dropped or
clamped with a warning rather than allowed to throw.

**Generated ids come from a slug, not the type**, so a ladder filter is
`lpf1` rather than `ladder1` and the stock rack's hand-written ids match what
the generator would produce. `check:patch` asserts they have not drifted.

**The manual's tutorials are a test.** `check:manual` builds each one from
the same rack the manual tells the reader to build, wires it with the same
`connect` the rack UI calls, renders
it, and checks it does what the text claims -- that the laser's pitch falls,
that the footstep's filter closes, that the explosion's two layers both
sound. A tutorial that quietly stopped working would be worse than no
tutorial, because the reader would assume they mis-clicked.

**There is no multiple module, and there never will be.** Outputs already fan
out to as many cables as you like, so a mult would be a module that does
nothing. What the rack was actually missing is the other half of that job:
the VCA is unipolar and clamps at zero, so nothing could invert a modulation
source or centre a bipolar one anywhere but zero. That is what the CV
utility is for, and why its gain is bipolar.

**Utility inputs are normalled rather than required.** With nothing patched,
the sample and hold samples its own noise on its own clock, and a CV channel
puts out its offset alone. Both fall out of the wiring for free -- an
unpatched input reads slot 0, which is ground and never written, so a module
can tell the difference and substitute something useful. A module that does
something the moment it is bolted in is worth more than one that waits.

**One display report carries everything the panels draw.** The audio thread
posts to the main thread thirty times a second; scope captures and mixer
levels both ride that message rather than opening channels of their own, and
each is left out entirely when the patch contains nothing that publishes it.
Posting structured-clones the frame, which is what lets a module hand back the
same buffer every time instead of allocating one per report on the audio
thread. The engine collects both through interfaces -- `Capturing` and
`Metering` -- so it never has to know what a scope or a mixer is.

**The stock rack is four modules.** An oscillator, a filter, an LFO and a
mixer, with three cables. It used to be ten, which was a finished voice
handed to you before you knew what any of it did, and a lot to pick apart
before you could build something of your own. Four is the shape of the thing:
a source, something that shapes it, something to modulate with, and the way
out. The oscillator's own envelope covers what a separate envelope, gate and
VCA used to, which is what makes a rack this small a plucked note rather than
a drone -- and its Env jack opens the filter on the way past. There is no
recorder in it; add one when you want files.

That cost the tutorials the rack they were written against, so the manual now
opens its tutorial chapter by building one, and `check:manual` builds the same
one the same way. A shelf of tutorials sharing one setup is cheaper than
each of them repeating it.

**The keyboard's pitch is in octaves, not hertz.** Every CV destination in
this rack is already scaled that way -- an oscillator's FM input and a
filter's CV input both take octaves -- so a keyboard that put out frequencies
would be the one module speaking a different language, and would need a
converter to be useful. In octaves it needs nothing: Pitch to FM with FM Amt
at +1.00 plays in tune, the bottom key puts out zero and therefore sounds the
oscillator's own Pitch knob, and the same jack drives a filter or an LFO
without changing its mind about what a number means.

**A played parameter is not a designed one.** The keyboard's note and octave
are parameters like any other -- they ride the same path a knob does, and a
saved patch remembers them -- but they carry `played`, which keeps them off
the generic knob row and, more importantly, out of a render batch's jitter. A
batch varies the patch; which key you are holding is not part of the patch,
and eight takes of a note that wandered a couple of semitones apiece would be
eight different notes rather than eight versions of one.

**The keys are the Trigger button.** Pressing one writes the note and opens
the module's gate through the same transport a Trigger's key uses, which is
why an offline render plays the keyboard too: it opens the gate without
touching the note, so what sounds is the key pressed last. It follows that
the panel needs no Trigger button of its own, and the oscillator's rule --
every triggerable module gets one -- is the one place this module is an
exception.

Its Gate input is what the split buys. A Trigger patched in plays whichever
key was clicked last, which makes the keyboard a pitch setting for whatever
fires it rather than an instrument that has to be played by hand -- click the
note, then fire it from a key, a Burst, or a Sequencer's gate. The note is a
parameter and the gate is an event, and only because those are separate can
one source choose the pitch while another decides when it sounds.

**Four sample and holds, not one.** A single channel was one knob on a whole
rack unit, and wanting a second stepped source meant a second panel. Channels
do not share a random stream, for the same reason modules do not: a shared one
is drawn from in whatever order the channels happen to fire, so retuning one
would quietly reshuffle the others. Channel 1 keeps the module's own stream,
so a patch written when this module had one channel still renders exactly the
sound it always did.

**A renamed port is a migration, not a new file format.** `serialize.ts`
carries a table of modules that have been renamed or rearranged, old name to
new, covering the type, its ports and its parameters. Nothing about the file
changed shape, so the version stays where it is and a patch saved yesterday
still opens with its cables landing where they should. Bumping the format
instead would have meant refusing to load it.

**The mixer drives the speakers; the recorder only listens.** There used to be
an output module, and a rack was silent without it -- a second thing to
remember after the mixer, doing nothing the mixer could not do, and one more
unit between a beginner and a sound. Now a stereo bus reaches the speakers
unless it feeds something that can carry the signal on, so an oscillator and a
mixer is a whole rack. Patch a mixer into another mixer and you hear it
through the second rather than twice; patch it into a recorder or a scope --
modules with no outputs at all -- and it stays a main mix, because a tap is
not a destination. The conditioning the output stage used to do moved onto the
mixer's bus with it, which is where the signal is balanced and therefore where
saturating instead of clipping belongs.

**The recorder normals to the speakers.** With nothing patched to it, a render
is what the room hears -- the same reason the L jack normals to R. Patch it
and you are deliberately recording something else: one channel, a sub-mix, a
signal before the master. Without the normal, a rack you could hear would
render silence, which is the kind of thing that reads as a broken build.

**Two module types are declared to the compiler, not named by it.** A def can
carry a `bus` (two outputs that form a main mix) or a `tap` (two inputs a
render is taken from). `compile` used to look for `type === 'out'`; now it
looks for those fields, which is the same discipline the engine follows with
`Capturing` and `Metering`. A second kind of mixer or a second kind of
recorder needs no compiler change.

**Levels are metered where they are mixed, not at the output.** The rack had
one master meter in the page header, which answered only "is anything coming
out". Peak tracking now lives in the mixer, which is the one module that knows
what each layer contributes, so eight channels and the bus are each readable
at a glance. The meters are post-fader and pre-pan: constant-power panning
keeps the two channel gains' magnitude at the fader value, so a bar reads the
same wherever the layer sits in the image, and it reads what the fader beside
it is setting.

**The scope draws to a canvas, never through React.** Four thousand floats
into state thirty times a second would re-render the whole rack at that rate
and make every knob in the room feel sticky. The component renders once and
the draw loop runs on refs, which is also why the engine arrives through a
context rather than as a prop on every unit.

**The waveform is triggered on a rising zero crossing**, searched for in the
part of the capture that is not going to be drawn. Without it the trace slides
sideways at the difference between the signal's frequency and the frame rate,
which makes a steady tone look like a moving one. With it the trace is within
a pixel of still, and `check:scope` measures exactly that by finding the
waveform's first peak across six frames.

**A column of the waveform is drawn as a line, not a point.** Once the
timebase approaches the pixel rate, most columns hold a single sample, and a
line from a point to itself paints nothing at all with butt caps. That bug
draws a steady tone as a scatter of dots and a silent input as an empty
screen, and it is invisible until you read the pixels back.

**The ink ramp is defined against the panel, not the page.** Labels sit on
`--panel`, not on the darker background, so a grey chosen to look right on
the page is a good deal worse where the text actually is. `--ink-dim` is
about 7:1 there and `--ink-faint` about 5:1; the values these replaced were
4.4:1 and 2:1, which at the 8-9px a rack label is set in read as texture
rather than words.

**Editing controls live on the back panel only.** Building a rack is what you
do from behind it -- that is where the wiring is, and where moving or pulling
a unit has consequences you can see. The front is for playing, so nothing
there competes with the controls that make a sound. Dragging a unit by its
spine works from either side, and the arrows stay alongside the drag because
a drag is a pointer gesture and nothing else: they are how a unit is moved
from the keyboard.

**A reorder drag moves the rack, not the patch.** The units shuffle under the
pointer while the drag is live, but the patch is edited once, on release.
Committing each crossing instead would recompile the graph a dozen times on
the way past and leave a dozen steps to undo afterwards, when what happened
was that a unit was moved once. What follows the pointer is a named,
translucent panel of the unit's own size rather than a copy of it: a plain
rectangle over a rack of panels reads as whichever panel is behind it, and
the knobs showing through look like they belong to the thing being carried.

**The drag chases the pointer instead of stepping with it.** A unit moves one
place at a time, and only once the pointer is past the middle of the
neighbour it would displace -- half a unit of travel is what stops a rack of
tall and short units flickering as they trade places. Because a flick can
cross several units between two pointer events, each step is re-run after the
browser has laid the new order out, until the rack has caught up with where
the pointer already is. Measuring before that repaint would be reading where
a unit used to be, which is how a drag jumps two places or swaps back and
forth against its own stale position.

**The recorder is knobs, not fields.** Its settings sit on a module panel, so
they are worked the way every other control in the rack is. Two of them count
whole things, which the knob handles as a detent rather than the caller
rounding after the fact: a value that comes back different from the one the
knob sent makes the wheel drop its position, and a knob that keeps being
handed back a rounded number never creeps far enough to reach its next notch.
Seed came down from a 32-bit field to a dial of 128, because its job is to be
a number you can note down and return to, and a knob spanning two billion
values cannot be brought back to one of them.

**Cables are hit-tested in code, not with SVG hit areas.** The cable layer
paints above the panels and takes no pointer events at all. An invisible
stroke wide enough to grab reliably also covers any jack the cable crosses,
which would make that jack unusable -- a pointer down on it would unplug an
unrelated cable instead of starting a patch. Distance is measured to the
segments between curve samples rather than to the samples themselves, because
uniform steps in t are far apart in pixels on a long cable.

**A theme and a mode are two axes, not one list of four.** They are
independent choices -- which palette, and whether the lights are on -- and a
single list makes you re-find your theme every time you want light. Both are
attributes on `<html>`, so each combination is one selector and no rule in the
sheet has to know which is on. Every combination declares the whole palette
rather than patching the one above it: these themes differ in hue, not only in
lightness, and a partial override is how a green rack ends up with one grey
knob. Tokens are named for the part -- `--spine-top`, `--knob-cap` -- so a
theme that makes the rack ears sage does not leave a variable called
`--grey-dark` lying about it. Both failures a palette can have are silent --
a token left out keeps the previous theme's colour, and a pair that does not
contrast is still the right size and still unreadable -- so `check:theme`
audits every palette for a complete token set and for the ratios on the pairs
that end up on top of each other. It found a 4.3:1 label on the remove button
that had been in the original theme all along.

**Repainting cross-fades with a view transition, not a CSS transition.** Most
of a panel is a gradient, and gradients do not interpolate, so a transition on
colour would fade the flat parts while the panels behind them snapped. A view
transition fades a picture of the old page into a picture of the new one and
does not care what any of it was painted with. The one thing that cannot
repaint itself is the scope: a canvas cannot read a CSS variable, so it pulls
its palette off its own element and is told, through context, when that
palette has been replaced.

## Layout

```
src/
  main.tsx App.tsx app.css
  theme.css            # every palette, as tokens on <html>
  patch/               # the patch as data; shared by UI and DSP
    defs.ts            # module catalogue: ports and knobs, declared once
    types.ts param.ts
    compile.ts         # patch -> execution plan, with cycle detection
    edit.ts            # add, remove, reorder, connect, disconnect
    serialize.ts       # the save format, and a defensive loader
    history.ts         # undo/redo, with coalescing, named steps, and jumps
    storage.ts         # autosave, and project and patch files
    fileAccess.ts      # files the app can write back to, like a desktop program
    archive.ts bundle.ts   # a patch or project and its audio, in one zip
    sampleRefs.ts      # which samples are still wanted, so the rest can go
    build.ts           # the building blocks every shipped rack is written with
    library.ts         # tutorial racks and templates to start from
    instruments.ts     # off-the-shelf voices for the roll
    myLibrary.ts       # the library's own shelves: saved and starred racks
    knobHelp.ts        # what each knob does, read out of the manual
    defaultPatch.ts
  song/                # the arrangement; as free of the browser as patch/
    types.ts           # tracks, patterns, notes, placements; 960 ticks a beat
    schedule.ts        # a window of the song, as ticks and then as samples
    transport.ts       # the lookahead cursor, and where the playhead is
    edit.ts            # add, remove, place; the invariants nothing else keeps
    noteEdit.ts        # edits to a group of notes, for the roll
    record.ts          # notes played in while the song runs
    range.ts           # insert, delete, clear, copy and paste bars
    midi.ts            # the arrangement as a Standard MIDI File
    normalize.ts       # the invariants a song holds however it arrived
    bind.ts            # what in a rack a track's notes are played on
    chord.ts scale.ts  # the roll's chord tool, and its scales
    runtime.ts         # SongPlayer: a project, played with no browser at all,
                       # and every knob in it a game can turn
    serialize.ts project.ts   # a defensive reader, and the project file
  dsp/                 # audio thread; no DOM, no allocation in process()
    worklet.ts         # AudioWorkletProcessor entry, registers 'fresyn-voice'
    protocol.ts        # the messages between the main thread and the worklet
    SongEngine.ts      # one graph per track, summed; the worklet is its shell
    Console.ts         # the song desk: strips, shared effects, the limiter
    GraphEngine.ts     # steps the compiled graph one sample at a time
    modules/           # one file per module type, plus the type registry
    PolyBlepOsc.ts LadderFilter.ts Envelope.ts DcBlocker.ts Smoothed.ts Rng.ts
    Biquad.ts DelayLine.ts Adaa.ts   # shared filter, delay and shaper parts
    Rail.ts            # how far a signal may go anywhere a patch can grow it
    Loudness.ts        # BS.1770 loudness, for the LUFS readout
    samples.ts         # audio a patch plays but does not contain
  audio/
    AudioEngine.ts     # main-thread handle; React never touches AudioContext
    Transport.ts       # plays a song, off the audio thread's own clock
    render.ts          # offline render, and variation batches
    renderSong.ts      # bounce the arrangement, and one file per track
    normalize.ts       # peak or loudness targets for what is written out
    SampleLibrary.ts sampleStore.ts   # dropped files, decoded and kept
    wav.ts zip.ts      # 16/24-bit PCM or 32-bit float, and a store-only zip writer
    flac.ts            # a FLAC encoder: fixed predictors, Rice coding, stereo modes
    encode.ts encoders.ts   # every export format; OGG and MP3 via wasm-media-encoders
    waveform.ts        # peak envelopes for drawing a take
  input/               # browser input capture and key bindings
    InputManager.ts useInput.ts keyLabel.ts
    liveNotes.ts midi.ts   # notes played by hand, and MIDI controllers
  ui/                  # Knob, Switch, Control, ModulePanel, RackUnit
    theme.ts           # the theme catalogue, and where the choice is kept
    ThemeContext.ts    # the current appearance, and the cross-fade
    palette.ts         # the hues a pattern or a track can be given
    Menu.tsx ModuleSearch.tsx LibraryDialog.tsx RackIndex.tsx
    OscFace.tsx LfoFace.tsx KeysFace.tsx SeqFace.tsx LadderFace.tsx
    SvfFace.tsx MacroFace.tsx SamplerFace.tsx   # hand-laid-out panels
    EnvelopeGraph.tsx envelopeShape.ts WaveGraph.tsx waveShape.ts
    ResponseGraph.tsx        # a filter's curve, drawn from its own maths
    Jack.tsx BackPanel.tsx   # the reverse of a unit
    ScopeFace.tsx            # the scope's screen and its draw loop
    scopeDraw.ts fft.ts      # canvas drawing, and the transform behind it
    EngineContext.ts SampleContext.ts
    MixerFace.tsx MixView.tsx meter.ts   # the rack mixer, the song desk, meters
    UnitSpine.tsx            # the rack ear, and the drag handle
    useRackDrag.ts rackLayout.ts   # dragging a unit, and how a row is shared
    Cables.tsx               # the cable layer, purely visual
    cableGeometry.ts         # curve maths and pointer hit-testing
    SongDock.tsx             # the music drawer: transport, tracks, views
    PianoRoll.tsx rollDraw.ts  # the roll, and its canvas drawing
    useNoteRecording.ts      # the roll's Rec button
    HistoryPanel.tsx         # the undo history as a list to jump through
    BounceDialog.tsx         # format, rate and depth for a bounce
    Playlist.tsx TrackList.tsx # the arrangement grid, and the track strip
    ExportPanel.tsx TakeList.tsx   # the recorder's render and audition
    TriggerButton.tsx PresetButton.tsx ConfirmButton.tsx KnobHelp.tsx
    ErrorBoundary.tsx        # a panel that throws, contained
scripts/               # verification
  run-checks.mjs       # the aggregates: fast, browser, all
  run-ts.mjs           # bundles a check-*.ts with esbuild, then runs it
  harness.mjs          # what every browser suite shares: server, Chrome, waits
  check-*.ts           # the headless checks
  check-*.mjs          # the browser suites, and check-theme (headless)
MANUAL.md              # the user manual, and the patches check:manual renders
CHANGELOG.md           # what changed, newest first

Modules: gate, osc, sampler, voice, keys, noise, dust, lfo, adsr, sh, drunk,
clock, burst, seq, macro, slew, quant, cv, ladder, svf, formant, eq, drive,
fold, ring, crush, comp, gran, delay, chorus, reverb, res, vca, mixer (8:2),
scope, rec.
```

## Roadmap

1. ~~One voice, end to end.~~
2. ~~Patch graph: modules as data, topological sort, feedback cables.~~
3. ~~Rack UI: Tab to flip to the back panel, drag cables.~~
4. ~~Adding and removing modules; saving and loading patches.~~
5. ~~Module library: S&H, slew, CV utilities, scope; multi-mode filter,
   waveshaper (Drive, Wavefolder), bitcrusher, delay, comb, resonator bank,
   reverb (Space).~~
6. Game-audio workflow -- the reason this exists:
   - ~~seeded RNG, so renders are reproducible~~
   - ~~batch variation renders, WAV export, zip~~
   - ~~audition a take before saving it~~
   - per-parameter jitter ranges, rather than one spread for the whole rack
   - "mutate" with per-knob locks
7. Music:
   - ~~a piano roll, and a transport that lands notes on exact samples~~
   - ~~tracks, patterns and a playlist; one rack per track~~
   - ~~bounce the song, and one file per track~~
   - polyphony: a voice pool per track, then a shared master section so a
     reverb is not duplicated per voice
   - freeze a track to its stem, once there is a CPU wall worth measuring
8. ~~Stretch: bake a patch into a small standalone synth to ship in a game and
   generate sounds at runtime instead of streaming WAVs.~~ `SongPlayer` does
   this for a whole piece; what is left is packaging it as its own module.
9. Vocal synthesis, as separate modules the way a throat and mouth split it:
   - ~~Voice: a glottal pulse source with breath, jitter, growl and vibrato~~
   - ~~Formant: a five-band vowel filter with a continuous morph and a Size~~
   - a vocoder, for robot voices from recorded speech
   - a Talk module that speaks typed words, built on the two above
