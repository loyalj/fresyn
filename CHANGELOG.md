# Changelog

What changed, newest first. The README says what Fresyn is now; this is how
it got there. The older entries are the milestone notes that used to sit at
the top of the README, moved here as they were written.

## Tape, Clock Divider, Unison Oscillator and Low-Pass Gate

Four new modules:

- **Tape** (Effects): saturation, wow, flutter, a worn top end and hiss. One
  serves the whole chord, so every note drifts with the same wow.
- **Clock Divider** (Control): any clock in, /2, /3, /4 and /8, x2 and x4 out,
  and an Out whose Ratio steps from x4 to /32. Multiplications measure the
  gap between ticks; divisions count them.
- **Unison Oscillator** (Voice): up to seven copies of a wave, spaced evenly
  either side of the note so the stack stays in tune, spread across stereo by
  Width, each from its own phase. Detune has a CV input, Spread.
- **Low-Pass Gate** (Voice): a filter and a VCA opened together through a
  modelled vactrol that opens fast and closes slower the darker it gets.
  Strike pings it open from a trigger: the Buchla "bonk".

`check-dsp` holds each to what it says: the unison's copies found in the
spectrum where they should be, every divider output counted against its
clock, a strike ringing down and the filter opening with the level, tape that
is transparent at zero and wobbles, dulls, hisses and saturates on cue.
`check-modules` fuzzes all four.

**Library patches rebuilt on them.** Supersaw pad, Supersaw lead and Unison
saw bass are each one Unison Oscillator where they were four or five
Oscillators and a ladder of CV Utilities (the pad now seven saws, not four).
Vinyl pad, Rust pad and Tape strings pass through a Tape instead of an LFO
on their pitch, a Bitcrusher and a low-pass; Rust pad keeps its crusher. The
Lo-fi Kit's after-chain is one Tape on the kit summed to mono, rather than a
crusher and a filter a side -- two Tapes would wobble out of step. Songs that
already use these keep their old copies. They cost the same or less: Rust
pad 355 -> 169 us a block, Vinyl pad 354 -> 205, the Supersaw pad's seven
saws what its four did. The Unison Oscillator works out its copies' pitch
ratios and pans only when a knob or the Spread jack moves, not every sample.

## Four kits a hundred times cheaper, and `npm run bench`

A profile of the grown library found the 909, Industrial, Cinematic and
Glitch kits each costing up to 94% of the audio budget while doing nothing:
a pad's kick, starting its click from a Noise, could be sorted ahead of the
Trigger that fires the pad, and the engine then stepped the whole rack a
sample at a time. The compiler now orders every pad after what reaches its
Trig jack; idle, those kits cost 12-20 us a block rather than 1.6-1.9 ms, and
a song of the newest voices runs 2.8 times faster. A pad holding a Delay or
a Granular also waits only as long as it is set to hold sound for before it
sleeps, not the two seconds the line could.

`npm run bench` measures songs, every instrument and every module against
the audio budget; PERFORMANCE.md has the numbers. `check-song` checks that
every kit renders a block at a time, and that pads with a short and a long
echo sleep when they should.

## The Envelope Follower

A new module in **Modulation**: how loud whatever reaches it is, as a CV.
Out (0 to 1) and Inv follow the input's loudness at its own Attack and
Release, scaled by Gain, in peak or RMS mode; Gate is high while Out is over
Threshold (closing a little below it, so it does not chatter), and Trig fires
each time it opens. A kick ducking a pad, a drum loop opening a filter, a
snare striking an envelope -- sidechaining without a compressor, and one
sound playing another.

`check-dsp` holds it to its numbers: a sine read at its peak or its RMS, Gain
and the ceiling at 1, Attack and Release as time constants, and one Gate and
one Trig per burst. `check-modules` fuzzes it with every other module.

## Twenty-four new basses and twenty-four new leads

The Bass and Leads shelves go from ten each to thirty-four each.

- **Bass:** Moog, Juno sub, hoover, sequencer, octave, unison saw, 808, neuro,
  donk, fizz, garage, dub, fretless, slap, picked, tuba, synth-koto, rubber,
  distorted, bitcrushed and formant basses, pluck sub, drone bass and Liquid
  Reese.
- **Leads:** Mini, saw, brass, hollow square, arp and detuned leads; talkbox,
  robot voice, siren and bendy leads; ocarina, recorder, shakuhachi, bagpipe
  (with its drone on C), lead guitar and harmonica lead; Gameboy, SID, laser,
  chime, glass, trance pluck, dirty and formant leads.

Most are written with a new `synth` recipe in `instruments.ts`, which takes a
description -- oscillators, a shaper, a filter with its own envelope or LFO,
a mouth, the note's envelope and an effect -- and wires the rack. It centres
any detuned unison on the note, so a voice written as 1 and 1.004 still plays
in tune.

## Fourteen new strings, and every kit's drums on the shelf

The Strings & pads shelf gains solo strings -- **violin**, **viola**,
**contrabass**, **fiddle** and **erhu** (sliding up into each note) -- and
sections: **low**, **high**, **tremolo**, **staccato**, **swell**, **octave**
and **tape** strings (a Mellotron's, running out after eight seconds), **sul
ponticello** and **string harmonics**. The solo ones share a `bowed` recipe
with the cello's body and a vibrato that arrives as the note is held; the
sections share a `section` recipe with the String ensemble's chorus.

**The kits' own drums, all 117, are on the Drums shelf**, each under its
kit's name, so new kits can be made from any of them. The library heads each kit's
group, and a pad's **Load…** list groups them the same way. Library entries
take an optional `group` for it. The quietest few were given a gain stage to
stand on their own, and the 808's two kicks are now **808 long kick** and
**808 short kick**, so neither is mistaken for the shelf's own 808 kick.

`check-instruments` checks each of those drums the way it checks any drum,
and plays a held sound by holding it. A kit is still checked as a kit:
every pad heard through it, the hats choking, and its hall or drive dying
away. No two library entries may share a name.

## Twenty-four new pads

The Strings & pads shelf goes from seven pads to thirty-one:

- **Classic synth:** OB brass pad, Juno pad, PWM strings pad, Hollow pad,
  Sync pad (a hard-sync sweep that climbs as it is held), Supersaw pad.
- **Airy and glassy:** Air pad (noise ringing a resonator), Bell pad, Crystal
  pad, Frozen pad (a granulator holding the chord still).
- **Dark and cinematic:** Dark matter (a wavefolded sine), Tension pad (a
  semitone rub and noise that build for six seconds), Underwater pad,
  Cathedral pad, Rust pad.
- **Moving:** Pulsing pad, Breathing pad, Wandering pad (a random walk in
  tune), Phaser pad, Echo pad.
- **Voices and textures:** Ooh choir, Whisper pad, Vinyl pad, Granular cloud.

Every one passes the shelf's checks: in tune across the roll, room for a
chord, quiet after the last note. `SHELF=strings npm run check:instruments`
checks one shelf on its own, in a fraction of the time.

## Eight drum kits

The Drums shelf gains **808**, **909**, **Lo-fi**, **Chiptune**, **World**,
**Industrial**, **Cinematic** and **Glitch** kits: sixteen pads each, built
for the kit rather than borrowed, on General MIDI's notes, with choked hats
and the kit's own sound after it (glue, tape, drive or a hall). Rolls,
swells, risers, a grinder and vinyl crackle play for as long as their note
is held.

They are made in `patch/kits.ts` from a handful of drum recipes (kick,
snare, hat, clap, shaped noise, metal, a struck resonator, a chip blip).
`check-instruments` now plays every pad of every kit on its own note: it has
to sound, answer to velocity, fall silent, and the closed hat has to choke the
open one.

**Fixed: a pad or a voice that sounds late is no longer cut off before it
does.** A Drum Kit pad, or a released voice, was put to sleep after 50 ms of
silence, and a granulator reading behind what it records, or a delay between
echoes, can be silent that long with sound still to come. Each now waits as
long as anything in it can hold sound for later, as a resting effect already
did. `check-song` holds a pad that sounds a third of a second late to it.

## Getting around: the counter, a loop on the ruler, and Ctrl+K for everything

From a review of the app's screens:

- **A position counter** beside Play, as bar.beat.sixteenth and time. Click it
  and type a bar, a bar and beat, or a time to play from there. **■ Stop**,
  pressed again, goes back to the start, and **⏮** goes there too.
- **The dock takes a share of the window**, four tenths until it is dragged,
  and each view keeps its own size.
- **The roll's toolbar is one row.** Key, Snap to key and the chord are
  behind **Write**, Humanize is on Tools, and the hints are behind **?**, so
  the roll gets the room.
- **Several automation lanes open at once**, stacked, each with its own
  height, Hide and Remove lane.
- **A loop on the playlist's ruler**: pick bars and press **Loop**. Drag its
  ends and clear it with ×. It is the song's own `loop`, which the game
  runtime already played.
- **A clip's menu** on its ▾: rename, colour, make unique, and **Mute clip**,
  a new field on a clip that silences its notes and automation.
- **Ctrl+K is a command palette**: every menu command, track, pattern and
  section, and every module, by typing.
- **Hear a library sound before loading it**: ▶ or Space plays a phrase on a
  track of its own that is taken away afterwards.
- **Listen at a jack**: Alt and a press on any jack hears what it carries,
  made safe for ears, until you let go.
- **Cables are cut away over jack names**, and **View → Cables** fades them
  to Faded or Faint.
- **Controller badges**: a mapped control says which of the controller's it
  answers to, and DAW mode marks its eight tracks.

`check-ux` is a new browser suite that works every one of them; `check-song`
covers clip mute, positions and listening at a jack in the engine.

## DAW mode: Mackie Control surfaces

A controller in its "DAW mode" speaks Mackie Control Universal, where every
control already has a meaning, so Fresyn now understands it without any
learning. Tick **DAW mode (Mackie Control)** beside the controller in the
MIDI controllers panel. The eight strips are tracks 1–8, banked by « and ».
Faders are levels (picked up before they move anything), knobs are pans, M
and S mute and solo, Select puts the track on the bench, and R selects it
and arms ● Rec. Play, Stop and Record are the transport's, rewind and fast
forward move a bar, and the arrows step through tracks and patterns.

Fresyn now sends MIDI back as well. A surface's buttons light for mute,
solo, the selected track, playing, recording and the loop. Each fader is
told where its track's level is, so a surface without motors can show which
faders are out of place, and each knob's ring shows its pan. Learnt mappings
still come first.

Two things for every controller came with it. Pitch bend is read, so
Mackie-style faders can be learnt at their full fourteen bits. And an
endless knob learnt turning one way only, whose encoding could not be told,
puts itself right the first time it turns the other way. `mcu.ts` is pure
and checked in `check-song`; `check-midi` drives a pretend surface in DAW
mode and reads back what it is sent.

## Recording movements, and MIDI files in

**● Rec** now records controls as well as notes. Any knob, switch, fader,
pan or send moved while it records, by mouse or by a mapped MIDI
controller, is written into its lane in the roll's pattern at the moment it
moved. It is written over just the stretch it moved through, and thinned
from sixty values a second to the points that draw it. A control left still
for a moment goes back to its lane, so the next pass plays the take. While
Rec is armed, every edit with an undo key folds into the take, so a take of
notes and movements together is one Ctrl+Z.

**Project → Import MIDI...** reads a Standard MIDI File (format 0 or 1,
running status, any resolution), as a new project or as tracks added at the
playhead's bar. Each MIDI track's channel becomes a track and a pattern on
its own lane. Its sound is the library voice nearest its General MIDI
program, and channel 10 gets the Drum Kit. Tempo, meter and their changes
come in, markers become sections, and volume and pan rides become strip
lanes. `midiFile.ts` reads the bytes and `midiImport.ts` makes the song;
both are checked in `check-song`, including a round trip through Export
MIDI. `check-midi` imports a file both ways in the browser.

## Automation lanes

Knobs can move by themselves now. Any knob or switch in a rack, a strip's
level, pan, EQ and sends, and the master and returns can have an automation
lane in a pattern. Right-click it and choose **Automate in this pattern**, or
pick it from the roll's **Automation…** picker. The lane opens under the roll:
click to add points, drag them, right-click for **Linear**, **Hold** or
**Curve**, and drag a stretch's handle to bend it.

Lanes belong to patterns, as the notes do, so they repeat, trim and split
with their clips and travel with a moved section. Outside the clips that
automate it a knob is where its panel says, and where two clips overlap the
later-starting one has it. A lane keeps the knob's *position* along its
travel, so a cutoff sweep moves like a hand on the knob. Knobs are seen
turning as the song plays. A hand on one, or a MIDI controller's slider,
takes it from the automation until the song stops. The Song view draws each
clip's lanes over its notes.

`fill`, which live playback and `SongPlayer` share, emits the curves beside
the notes. Live play, bounces, stems and games therefore hear the same
automation, and the engine works out each knob's value from its curve once a
block. A game's `setParam` wins over the automation until the new
`releaseParam` hands the knob back; a game's `setTrackPan` wins too. The
model is checked in `check-song`, the sound in `check-runtime`, and the
editor, playback and taking over by hand in `check-automation`.

## Mapping a controller's knobs, sliders and buttons

A MIDI controller used to be a keyboard or nothing: its knobs were thrown
away. Now **Edit → MIDI learn** maps any of them onto the app's own controls.
Click a knob, fader, M/S, Play, Loop or ● Rec, then move a control on the
controller. What kind of control it is gets worked out from what it sends: a
knob or slider with ends, an endless knob (in any of the three encodings
makers use), or a button (as a control change or a note). No controller is
known by name, so any of them works. Sliders **pick up** the value before
moving it, so touching one never makes the sound jump.

Rack knobs follow the selected track, and the desk's controls belong to a
track by its place in the list, so one set of mappings works in every
project. They are kept with this machine's preferences, can be exported and
imported as a file, and can listen to one input or any. The **MIDI
controllers** panel lists them, lets each be changed or forgotten, and
monitors every message arriving and what it did. `midiMap.ts` is free of the
browser and checked in `check-song`; `check-midi` plays a pretend controller
through learn, pick-up, a button on Play and a pad on a track's mute.

## A runtime for games

`SongPlayer` can now be played *into* as well as listened to. `noteOn`,
`trigger` and `noteOff` play a track from the game, straight away or on a
frame `frameOf` names on the song's grid; `setTrackGain`, `setTrackPan` and
`setTrackMute` mix it; `setTempoScale` slows or speeds the whole song; and
`clock`, `key` and `levels()` read where the music is, what key it is in and
how loud each track is. A game's own notes are handed back to the engine
after a section change or a change of tempo drops the queue, so a held sound
is always let go of.

`npm run build:runtime` packages it for a browser: `RuntimeHost` runs several
projects side by side on one clock -- music, sound effects, jingles -- inside
an AudioWorklet, each with its own fade and low-pass muffle, and
`FresynRuntime` is the game's side, reporting each player's bar, beat and
levels sixty times a second. A sound effect synced to another player's grid
lands on its beat. The types a game needs moved to `song/game.ts`, which
imports nothing. `check-runtime` covers notes, the grid, held notes through a
rewind, tempo, the mix and the host. Arknoise is the first game on it.

## Scales and chords, progressions, and Euclidean rhythms

Three utilities for getting a song started. **Scales & chords** shows a key
on a keyboard and the circle of fifths, spelled as the key spells it, with
the chords on each degree and their numerals, as triads or sevenths; a chord
clicked plays through the rack on the bench, and **Set song's key** makes it
the song's key for the roll. **Progressions** sketches a progression — from
nine well-known ones or chord by chord — and writes it into the pattern on
the bench track, voiced close, smooth, spread or over a bass, in one of seven
rhythms, as one step of undo, lengthening the pattern when it has to. The
two share their key and progression, so a chord added in one appears in the
other. **Rhythm** writes Euclidean rhythms into a Drum Kit pattern, a lane
per pad, with rotation, accents, a chance for the unaccented hits, lanes of
any length and lanes fitted to the bar for polyrhythms, and six grooves to
start from.

Utilities now see the tracks — how each is played, how a real note becomes
one of its rows, a kit's pads — the pattern open in the roll, and can sound a
row through a track's rack; `editSong` takes a name for the History list.
`check-utilities` covers the chord theory, voicing, rhythms and Bjorklund's
algorithm; `check-utilities-ui` sets a key, writes a progression and a
rhythm, and reads them back from the saved song.

## A metronome, and notes and frequencies

Two more utilities. **Metronome** clicks at a tempo and time signature, with
the first beat accented, two, three or four clicks to the beat, three sounds,
a volume, a Tap button and lamps that light as each click is heard; Space
starts and stops it while its panel has the focus. Its clicks are scheduled
ahead on the audio clock, so they land on the sample whatever the page is
doing, and further ahead in a background tab; they play through the rack's
device but not the rack or the desk, so a bounce never has them in it.
**Notes & frequencies** converts a note, a MIDI number or a frequency to the
others, with the cents off the nearest note, the period, the octave around
it, a transposition as a Sampler's speed, and twelve harmonics, at a
reference A of the user's choosing; anything copies with a click, and it can
play the pitch.

`usePanelKey` is now how a utility takes a key from the rack while its panel
has the focus -- Tap tempo moved onto it -- and a utility can open the audio
device for a sound of its own. `check-utilities` covers the click count and
the pitch arithmetic; `check-utilities-ui` starts, stops and closes the
metronome, counting the clicks, and works the converter.

## Notes on the rack

**A note can be stuck to any unit**, for why a knob is where it is or what a
cable is for. Right-click a unit and choose **Add note here**, or pick one and
use **Edit → Add note to module**. A note is stuck to its unit rather than to
a spot on the rack, so it stays with it through reordering, resizing and the
compact rack, and on the face it was left on, front or back. Drag it by its
top strip, onto another unit to move it there; fold it to its first line;
give it one of five colours. **View → Show notes** hides them all.

Notes are part of the patch, so they go wherever a patch goes -- the project,
the autosave, patch files, the library, a Drum Kit's pads -- and are copied,
pasted and duplicated with their module and removed with it. Every change is
a step of undo, with a burst of typing folded into one; the History list
names them as rack notes.

Underneath, `Patch.notes` holds them, read and written by `patch/notes.ts`,
whose reader drops notes on missing modules and makes anything else in one
sensible. None of it reaches the audio thread: the rack's engine sync skips a
patch whose modules and cables have not changed, and `setTrackPatch` now
skips a recompile that comes out the same -- which also spares the audio
thread a rebuild for a cable's colour. `check-patch` covers the data, in
pads and projects too; `check-notes` drives the whole thing in a browser and
counts the rebuilds a note costs, which is none.

## Utilities, and a Timing calculator

**A Utilities menu**, for tools that sit beside the music rather than in it.
Each opens as a panel that floats over the app without taking anything away
-- the rack still plays and the song goes on -- is dragged by its title,
closes with Escape or its ×, and is where it was left after a reload. A
utility's code is fetched the first time it is opened, so the page carries
none of it until then.

**Timing** is the first. *Song length* turns a running time into bars and
beats at a tempo and time signature, and bars back into time, with a budget of
sections underneath that lays the song's parts end to end and says how far
they are from the length being aimed for. *Note lengths* lists every note from
a whole to a 1/64, straight, dotted and triplet, in milliseconds for a Delay,
hertz for an LFO, or samples; click one to copy it. Tempo counts quarter notes
in every time signature, as the song's does. It starts at the song's tempo and
keeps its own after that, so trying numbers never changes the song. *Tap
tempo* reads a tempo from taps on Space or on a pad, and sets the song to it
-- its opening tempo, or a tempo change from a bar -- as one step of undo.
Space is the panel's only while that tab is showing and the panel has the
focus: `data-claims-keys` is a new way for any element to keep keys from the
rack while the focus is inside it.

`check-utilities` holds the arithmetic to the song's own clock in five time
signatures, and tap tempo to a steady and an uneven hand; `check-utilities-ui`
opens the menu and works the panel end to end, tapping with Space and setting
the song from the start and from a bar.

## Three times the tracks, and nothing waits on a bounce

**The audio engine is about three times faster.** An eight-track song that
took 150% of the audio thread's time -- and so could not play without
dropping out -- takes 45% of it, and sixteen tracks now play in real time.
A song with nothing playing costs a seventh of what it did.

Underneath, `GraphEngine` runs every module over a block of 128 samples in
one call, where it used to call every module once a sample: forty kinds of
module behind one call site is a call the JIT cannot inline, and it was most
of what the rack cost. A cable is now two modules bound to the same block.
Only the modules a feedback cable spans are still stepped a sample at a time,
so a loop still costs one sample. Blocks lie on the transport's own frames,
and anything that changes state does it at the end of a block or at an event,
so a render is the same in any buffer size. Effects that only work on what
reaches them -- filters, reverbs, mixers, a delay once its line is empty --
rest while fed silence; voices are built only up to the Voices knob; the
Mixer measures loudness only while its panel is showing it; and the maths a
knob only changes when it moves is worked out when it moves.

**Bounces, stems and takes run in workers.** The page no longer freezes while
a song is written out, a bounce finishes with the tab in the background, and
stems cost about what the mix does rather than six times as much, sample for
sample the same.

**The rack is lighter to use.** A knob turn re-renders its own unit rather
than the whole rack; resizing the dock no longer restyles the page; units lie
flat at rest and are 3D only while they turn, so a big rack is a dozen
compositing layers rather than two hundred; and a knob reaches the audio from
the hand rather than after the render.

**Shared memory.** The site is now cross-origin isolated, so a decoded sample
is held once and shared with the audio thread and the bounce worker, each
file is sent to the audio thread once, and the meters and scopes are written
into memory the page reads rather than posted thirty times a second.

Also: samples load for every track after a reload, not only the one on the
bench; a scope's B trace shows inside a Drum Kit pad; Firefox no longer asks
about storage before anything has been stored; the page no longer rewrites
its autosave as it opens; the worklet's code is fetched while the page is
idle, ahead of the first note. `PERFORMANCE.md` has the audit, the plan and
the measurements.

## Editing a pad while the kit plays

**Edit pad**, beside the kit's pads, opens that pad's rack on the bench while
the song goes on playing the whole kit, so a snare can be tuned in the beat.
Every rack edit works inside a pad; the Modules menu leaves out a Drum Kit
and a Recorder there. A bar over the rack, and the index card beside it, say
which pad of which kit on which track you are in, with **Back to kit**. With a
pad open, loading a patch from the library or a file loads it into the pad,
and Download patch or Save to library saves the pad on its own. The History list names each edit
with its pad.

Underneath, a pad's live knob positions are kept in its track's values under
the pad's own ids -- the ids the running track already plays them by -- so a
knob turned in a pad is the same cheap message as any other, and the beat
never stops. `useDocument` hands the rack UI a pad as though it were a rack of
its own, and puts each edit back into the kit. Loading or moving a pad now
also updates where the roll's notes go straight away, which it did not
before.

`check-song` covers a pad's knobs through to what the track plays, top-level
edits keeping them, saving and the history's names; `check-kit` opens a pad,
turns a knob in it and comes back.

## The Drum Kit

**A new module, the Drum Kit: sixteen pads, each holding a whole rack from
the library.** A note plays the pad on that note, so one track plays a whole
kit, and the roll names its rows by pad. Pick a pad to load it from the
library (a copy, knobs and all), rename it, move it to another note, set its
level and pan, or put it in one of four choke groups so a closed hat cuts
off an open one. **Load the standard kit** fills all sixteen pads with the
shelf's drums on General MIDI's notes, and **Drum Kit** on the Drums shelf is
a rack with it already loaded and Space on the kick. Each pad has its own
output jack, and a Trig jack to play it from a Sequencer or a Trigger.

Underneath, a kit's pads are laid into the patch beside it when it is
compiled (`src/patch/kit.ts`), so the engine, voices, bounce and game player
play them as ordinary modules. A pad that has been let go of and gone quiet
sleeps until its next note, so an idle kit costs about 5% of a core and a
busy beat about a fifth, rather than most of one. Editing the rack inside a
pad is next.

`check-song` covers the library kit, compiling, the file format, note
routing, choke groups, sleeping pads, the Trig jacks and the history's names
for pad edits. `check-modules` and `check-instruments` take the kit in, and
a new browser suite, `check-kit`, drives the panel end to end.

## Roll zoom, every time signature, and ramps on the BPM lane

**The roll zooms and scrolls across.** A pattern too long to fit at about
48 pixels a bar opens at that width with a scroll bar along the bottom,
instead of being squeezed into the roll. **Alt + wheel** zooms across around
the pointer, the new **−**, **+** and **Fit** buttons do it without a wheel,
**Shift + wheel** and a trackpad's swipe scroll along, and the view turns
the page as the playhead reaches its edge. Short patterns still open fitted.

**Any time signature** from 1 to 32 beats of whole notes down to
thirty-seconds: 2/2, 3/2, 5/16, 7/16. The Time menu lists more of the common
ones, and the Time lane takes any. MIDI export writes them as they are.

**The BPM lane copes with ramps.** The tempo is drawn as a line across the
lane, changes too close to label become thin marks with only the ends of a
run labelled, and the right-click menu removes every change in a bar or on
the lane at once.

`check-roll` covers zooming and scrolling across, and a note drawn while
scrolled landing where it was drawn. `check-song` and `check-render` cover
the new meters, and `check-timing` covers them on the lane and a 64-step
ramp.

## Tempo and time signature changes

**A song can change tempo and time signature part way through.** The Song
view has two new lanes over the sections, **BPM** and **Time**. Click one to
put a change there and type its value, click a change to set it, drag it to
move it, and right-click to remove it. A tempo change is a step from its tick
on. A time signature change starts a new bar, and the ruler, the grid, snap,
bar picking and the arrow keys all count in the bars as they are. The roll
rules a pattern in the time signature it first sits in, and shows a change
inside it on its ruler. The dock's Tempo and Time fields are the values at
the start, with **+n** beside them when there are changes.

Changes go with their music: inserting, deleting, copying, duplicating and
pasting bars carry them, and so do moving, duplicating and deleting a
section with its music. **Export MIDI** writes every change on the conductor
track, which a MIDI import will need to read back.

Underneath, `src/song/timeline.ts` now does every tick-to-sample conversion
and bar lookup: the transport, the playhead, bounces, a game's section
changes and the playlist all use it. A song with one tempo is still worked
out on exactly the same samples as before. The changes are edited through
`src/song/timing.ts`, and every file and wholesale edit keeps them tidy.

`check-song` covers the tempo map (including every window size scheduling
the same samples as the whole song, and loops across a change), bars across
meter changes, editing, the file reader, and changes moving with range and
section edits. `check-render` covers the MIDI export of changes. A new
browser suite, `check-timing`, drives the lanes end to end.

## History list, recording, bar editing and more export formats

**Edit → History** (**Ctrl+H**) lists every step of undo by name --
"Add note", "Cutoff · lpf1", "Move section" -- and a click goes straight to
any of them, back or forward. The names are worked out by comparing the
document before and after each edit, so no edit has to remember to name
itself. The panel floats beside the rack, and Ctrl+Z and Ctrl+Y still work
while it is open.

**Quantize** has a ▾ menu: quantize starts, ends, starts and ends, or
lengths, at a strength from 25% to 100%. **● Rec** in the roll records notes
played on the Keyboard panel, the track's Trigger or a MIDI controller at the
playhead, with the audio device's latency taken out. **Quantize while
recording** quantizes each note as it lands. **Edit → MIDI input** turns on
Web MIDI: a controller key plays the row named for that note on the benched
track.

**Drag along the playlist's bar numbers** to pick any bars, whether or not a
section covers them. Then **Insert** empty bars, **Delete** the bars and close
the gap, **Clear** them, **Duplicate** them, or **Copy**, **Cut** and
**Paste** them, from buttons or keys. Clips across an edge are split there,
which you cannot hear, and sections grow, shrink or go with their bars.

**Bounce song** and **Bounce stems** now open a sheet for format, sample
rate and bit depth or quality: WAV (16, 24 or 32-bit float), FLAC (a new
encoder in `src/audio/flac.ts`), OGG Vorbis and MP3. OGG and MP3 use the
`wasm-media-encoders` package (libvorbis and LAME in WebAssembly), which
loads the first time one is chosen. **Export MIDI** writes the arrangement as
a type 1 Standard MIDI File, with notes as the pitches you hear.

`check-patch` covers named steps and jumps. `check-song` covers edit names,
quantize modes and strength, the recording arithmetic, MIDI parsing and
mapping, and every range edit. `check-render` round-trips FLAC through a
decoder that checks every CRC, and covers OGG, MP3 and MIDI files.
`check-rack` drives the History list. `check-roll` records from the
Keyboard panel, picks and edits bars on the ruler, and has Chrome decode a
bounce in every format; the FLAC decodes to exactly the WAV's samples.

## Sections slide, and can take their music with them

A section being dragged now follows the pointer. Dropped in empty time, it
slides there with its music and nothing else moves. Dropped over other
sections, it goes into the gap between them, as before. The right-click menu
has a second delete, **Delete section and its music**, which takes the bars
out and closes the song up. Plain remove still keeps the music. The Song
view no longer shows the track list: it's only needed by the roll, and the
Mix view has a strip per track.

## Folders, hiding, search and pins for tracks

**+ Folder** makes a folder. Drag a track onto its row to file it, or among
its tracks to join them. A folder is a group too: its mute and solo reach
every track in it, and its level multiplies theirs like a VCA fader. It
folds away with its arrow, and removing it keeps its tracks. Solo stays
exclusive across tracks and folders. The scheduler and the desk now share
one rule for who is heard, so live play, the bounce and the game player all
agree.

Every track has a **⋯** menu (also on right-click) with Pin to the top,
Hide, Move to folder and Remove. Hidden tracks still play. They leave the
track list, the Mix view and the roll's faint notes, and **Show n hidden**
lists them again. Pinned tracks sit above a line at the top, outside their
folder and outside any search. **Find a track** filters by track or folder
name. The Mix view names each strip's folder.

`check-song` covers folder mute, solo and level, filing, removal, hidden
tracks still playing, search and saving. `check-tools` files a track by
dragging it and drives folding, the folder's mute, search, hiding and
pinning.

A track dragged by its grip is now followed from the window rather than
with a pointer capture. Reordering moved the dragged row, which lost the
capture, so the drop landed wherever the pointer was when that happened.

## Sections you can arrange with

Sections have their own lengths now, so adding one no longer cuts the others
short, and the song can have stretches with no section. On the strip: click
empty space for a four-bar section, or drag across it for one exactly that
long. Click a section to loop it, double-click to rename it, drag an edge to
resize it and use its × to remove it. Right-click for colour, duplicate and
split. Clicking a bar number splits the section over it.

Dragging a section moves its music with it: the song opens up where it lands
and closes up where it left, and clips across its edges are split there
first. **Duplicate, with its music** repeats a section straight after itself.
Removing, resizing and splitting touch only the labels, so no music is ever
lost to them. Each section tints the lanes under it.

Games can play sections too. `SongPlayer.playSection(name, { when, loop })`
changes section now, on the next beat or bar, or at the end of the section
playing, on that exact sample. `releaseSection()` lets the song play on, and
`section` and `sections` say where it is. The player now knows which tick is
being heard rather than scheduled, and takes back the part of its lookahead a
change makes wrong.

The Pattern menu on the dock's bar now shows only in Roll view. Song view
has its own pattern list beside the lanes, which does the same job.

Old projects' markers are read as sections running to the next marker.
`check-song` covers moving, duplicating, removing and resizing, the file
reader, and the player's timing to the sample. `check-tools` drives the
strip.

## A roll scroll bar you can hold

The roll's scroll bar is wider, at 12 pixels, and it works like a scroll bar.
Drag the thumb and the rows follow it pixel for pixel; click the track and
the thumb jumps there, and you can keep dragging. The grid now stops short of
the bar, so a click there never draws a note. A mouse wheel notch moves
three rows and glides there over about a tenth of a second. It used to jump
by whatever the OS called a notch, which in a short dock was most of the
screen. A trackpad's small steps are still followed exactly. `check-roll`
drags the bar, clicks it and times a notch mid-glide.

## Clips on the playlist

The playlist is now a set of lanes, and a placement is a clip. Any pattern
goes in any lane, at any tick the snap allows: a bar, a beat, half or a
quarter of a beat, or anywhere with Alt or snap Off. The patterns are listed
beside the lanes, and a click paints the one that is picked. A clip moves by
its body and trims by its edges. It splits with Ctrl+click, copies with
Shift+drag, and is deleted with a right-click or a right-drag sweep. A clip
drawn longer than its pattern repeats it, and trimming the front moves the
clip's start into the pattern without moving the notes. Clips can be picked
with a box, nudged with the arrows and copied with Ctrl+D.

A placement now carries `lane`, `offset` and `length`, all optional. Leaving
`offset` and `length` out means the whole pattern played once, so untouched
clips still follow their pattern's length. The scheduler plays clips through
one function, so live play, the bounce, the stems and the game player all
hear the same cut. The project format is now 2. A version 1 file opens with a
lane per pattern, which is how it looked. `check-song` covers trim, stretch,
offset, split, lanes, copying and the migration. `check-tools` and
`check-roll` drive the new playlist with the mouse.

## Audio settings

**Edit → Audio settings...** chooses the output device (Chrome and Edge), the
buffer (Low, Balanced, Safe or a custom size in milliseconds) and the sample
rate, and shows the actual delay from a key to the speaker. The settings are
kept with the browser's preferences, not in the project. A new buffer or rate
closes the audio context and builds another from what the engine already
holds, the same way it recovers from a failure. A saved output that has gone
away falls back to the default instead of stopping the engine.
`check-audio` covers the dialog, the rebuilds and a reload.

## A new key plays its own note

Clicking a new key on the Keyboard panel played the key pressed before it,
and only a second click sounded right. The press sent its gate to the audio
thread at once, but the note went as a knob change that followed a re-render
later, so a Keyboard with voices took its pitch from the old note. A press
now carries its key and sends it ahead of the gate.

## Tools in the roll

A Tools menu beside Quantize and Humanize transforms the selected notes, or
every note on the track: Chop into grid steps, Strum up and down, Arpeggiate
up and down, Flam, Reverse and Randomize pitch. Each is one step of undo and
leaves what it made selected, so they chain. Randomize lands on the song's
key when there is one. The transforms are pure functions in the song layer,
checked note for note.

## Keys named by the notes they play

The roll's rows and the Keyboard panel's keys are named by the notes you
hear, not their place on the Keyboard. They are read off the rack: the Pitch
knob and Octave of whatever the Keyboard's Pitch reaches, directly or through
a Slew or a Quantizer, plus the Keyboard's own Octave. An oscillator at
262 Hz makes the bottom key C4; flip the Keyboard's Octave and every name
moves with it. A detuned stack counts as the note it is spread around, and a
patch tuned between notes keeps its cents rather than being rounded, so
`Bottom key A4 +50¢` is what a quarter-tone patch says. The song's key is now
in real notes too, and each track shades, snaps and builds its chords from
it through its own tuning. Every instrument in the library is checked to be
named by the note it measurably plays.

## The whole keyboard in the roll

The roll has 128 rows, the span of MIDI, where it had the Keyboard's 25: four
octaves under its bottom key and more than four above its top one. A bass line
and a lead can share a track, and a part is no longer cut off at the edge of
the panel it happens to be played on. Pitch still counts from the Keyboard's
bottom key, which already played any note it was given, so songs written
before this sound exactly as they did. The rows scroll, a track opens centred
on its own notes, and moving, transposing and chords stop at the new edges
rather than the Keyboard's.

## Swing

A Swing control on the roll's bar pushes every second step late: 50% is
straight, about 67% a triplet feel, 75% a hard shuffle, on eighths or
sixteenths. It belongs to the pattern and is applied as the pattern plays, so
the notes stay on the grid they were written to and the amount can be changed
while the loop runs. It is a warp of time across each pair of steps rather
than a nudge of the notes on the off-step, so humanized notes swing by their
share, note ends move with their starts, and the beat never moves. A game can
set it too, through `SongPlayer.setSwing`. A note whose end a swing change
carries behind the scheduler is let go of there rather than left droning.

The roll draws a swung pattern where it is heard, with the off-steps of the
grid standing late and clicks mapped back onto the written grid; View → Show
swing in the roll turns that off. Fixed along the way: editing a pattern in
the roll no longer copies in the notes of another pattern placed over the
same bars.

## Notices, words and small screens

Messages come in three kinds: news fades, a job's progress stays for the job,
and a failure stays until it is dismissed -- with every warning a file came
with, not only the first. Bounces and saves take turns instead of competing.
Files are downloaded, takes are rendered, songs are bounced, the normalize
control is Loudness, and the dock is the Music dock throughout. On a touch
screen the move, duplicate and remove buttons are visible and big enough to
mean, and the Music dock never takes more than 60% of the window.

## Tightening: a faster rack and one check command (502fe0c)

Turning a knob re-renders its own unit rather than the whole rack, the roll
and the meters stop drawing when nothing moves, and the first load is less
than a third of what it was: the knob help is extracted from the manual when
the app is built, and the library, the song dock and the bounce load when
they are first used. `App.tsx` is split into hooks, the DSP helpers are in one
file with the output proven sample-identical, `npm run check` runs every suite
on a harness that starts its own server, and the theme check is honestly
green.

## Hardening: the review fixes (5a4d100)

A long review's worth of fixes, most of them to things that went wrong
quietly.

The transport lets go of every note it started: the end of the song and the
seam of a loop both release whatever is still held, and the playhead stays
where it is when the loop is changed under it. A NaN or a runaway on one track
is dropped before it reaches the strip and the sends, and every feedback path
that could hold one -- Space, Delay, the multimode filter, the biquads,
Formant, Chorus, the DC blockers -- clears itself rather than staying dead for
the rest of the session. The master limiter is a 1.5 ms lookahead limiter
rather than a clipper, with the same latency on every routing so stems still
line up with the mix.

Knobs glide instead of clicking: Smoothed snaps to its target once it is close
and says when it has settled, so the EQs stop redesigning while their knobs
are still, and Delay, Space, Drive, the Wavefolder, the Bitcrusher, Ring Mod
and the Sampler all smooth their controls. Drive and the Wavefolder use
first-order antiderivative anti-aliasing, which takes most of the fizz out of
a hard fold.

Audio recovers from a start that failed or was paused by the browser. The
loaders are strict -- cables, ids and sample hashes are validated on the way
in -- and samples nothing refers to any more are pruned. Undo skips edits that
changed nothing and no longer merges separate dock actions into one step.
Takes belong to the track they were rendered from. A panel that throws is
caught by an error boundary instead of taking the rack with it, and a failed
autosave says so.

The keyboard reaches everything: Tab moves the focus, F flips the rack, and
knobs, switches and jacks all work from the keys. Deletes ask to confirm.

## Five modules, game param control, and a bigger library (df21fb5)

Five new modules. **Dust** fires random impulses at an average density, with
a Trig out per impulse. **Drunk** is a wandering random walk with step, smooth
and pull, optionally clocked. **Chorus** is a chorus, a flanger and a phaser
in one stereo module, with Center on a jack. The **Multimode Filter** is a
clean state-variable filter -- low, band, high, notch and peak -- plus comb
modes that ring at Cutoff, with a response graph on its panel. **Macro** is
one knob driving four CV lanes, each with its own From, To and Curve and a
window set by dragging handles on its graph.

A game can turn knobs while a song plays: `SongPlayer.setParam`, `getParam`
and `paramsOf`, clamped to each knob's range.

The library grew five tutorials (18-22: rain, a fly, a struck pipe, a jet
flyby and a charge-up, one per new module), new Sound FX and Ambience shelves,
and 44 more instruments across every shelf. Notices moved to a card in the
bottom right rather than a banner that pushed the rack down, and the flip
button moved onto the rack index.

## Milestones 6 to 15

Milestone 15: it comes out as audio. **Bounce song** renders the arrangement
to a 24-bit stereo WAV faster than realtime, and **Bounce stems** writes one
file per track instead -- which add back up to the mix exactly, because mute
and solo apply and a silenced track gets no file rather than a file of
silence. The bounce runs the same scheduler the transport does, so a note is
on the sample it was on while you were listening.

The one rule worth knowing: **a bounce is never shorter than the arrangement.**
A bar with notes only in its first half is still a bar, and a file trimmed
back to its last audible sample would no longer tile -- which for a loop is
the whole job. What is trimmed is whatever hangs past the end, faded so the
cut cannot click; a file that ends exactly on the arrangement gets no fade,
because that point is the seam.

Underneath both is `SongPlayer`, which plays a project with no AudioContext,
no worklet and no DOM anywhere -- the class a game would run, and the class
the bounce runs. Any block size gives the same samples, so the music in a game
is the music you wrote rather than a second implementation of it, and a
project file is a few kilobytes where the WAV is a few megabytes. Freeze is
not here: it was only ever a way round a CPU wall nobody has hit, and it needs
a song-position clock in the engine that the looping transport makes more
awkward than it looks.

Milestone 14: tracks, patterns and a playlist. A project now holds as many
racks as it needs, one per track, and the track you pick in the list is the
rack on the bench -- so a piece is built by designing a sound, writing a part
for it, and adding another track to do it again. Patterns hold the parts for
every track at once and are placed on a playlist bar by bar; the roll plays
the pattern you are writing and the playlist plays the arrangement, so there
is no mode to remember. Mute and solo work as they do on a desk, and the other
tracks' notes sit faintly behind yours in the roll so a bass line can be
written against a drum part rather than from memory.

Underneath, the audio thread runs one graph per track and sums them: racks
stay completely independent, a muted one keeps its clock and its delay tails
so unmuting is in phase, and only the rack on the bench spends anything on
scopes and meters. Saving is a project now -- the arrangement, every rack and
all of their audio in one file, which is also the file a game would load.
A rack on its own is still a patch, still a small readable file, and still
what you send somebody when you mean "here is a sound".

Milestone 13: the roll. A piano roll docks under the rack and plays whatever
is on the bench, so the panel you are editing stays in front of you while the
loop runs -- reach for the cutoff and you hear it on the next note instead of
after a trip through a second window. Draw notes with a drag, set how hard
they hit in the velocity lane, and pick the tempo, the length and the snap
from the bar along the bottom. A rack with a Keyboard in it plays pitches; a
rack without one plays its Trigger, which is the right way to write a rhythm
for a coin or a footstep. The Keyboard grew a **Vel** jack to carry the other
half of that, and its Octave switch now transposes a written pattern as well
as a played one.

Underneath it, the rack learned to be played by something other than a pair
of hands. Events are queued against exact samples rather than posted at the
next block boundary, so a note lands where it was written whatever the
browser is doing, and the offline renderer runs the same queue -- which is
what will make a bounced song sound like the one you approved. The arrangement
saves alongside the racks in a project file.

Milestone 12: the jacks that were missing. The LFO's Rate can be patched, so
a wobble can speed up or slow down -- an engine revving, a siren winding up --
which is the thing its panel could not do. Drive, the Wavefolder and the
Bitcrusher each take CV now: they were the only signal-path modules in the
rack with nothing but an In, and the manual had been telling readers to put a
VCA in front of the folder as a way around it. The Trigger takes a cable, so a
clock through it in `once` mode is a fixed length at the clock's rate. The
Envelope says when it has finished and offers its shape upside down, which is
a whole CV Utility saved every time something has to duck rather than swell.
And the Scope has a second input, drawn from the first one's trigger point so
the two line up.

Milestone 11: a pitch is a note. The oscillator says which note it is
sounding under its waveform window -- Octave included, since that is the note
you hear rather than the one the knob is set to -- and its Pitch knob snaps to
whole notes while Alt is held, steps a semitone a notch on Alt and the wheel,
and takes a note typed into its readout. Twelve
octaves on one knob cannot be tuned by eye: a fifth is seven semitones, which
is 55 Hz at the bottom of that knob and 3.6 kHz at the top.

The LFO gets the oscillator's waveform window too, sitting on top of its Shape
buttons and scaled by its Depth -- which matters more there than on a voice
you can hear, since the picture is the only account an LFO gives of itself. It
cost no room at all: a switch is shorter than a knob, so the space above one
was already empty.

Milestone 10: the oscillator stops needing help to do ordinary work. Its own
envelope now has three destinations rather than one -- level, pitch and width
-- so a laser is one module with nothing patched into it, and a PWM sweep
needs no LFO. It has a Level knob and a meter of its own, so stacking two of
them into a mixer is not a fight with the master fader. And its Pitch knob
runs from 2 Hz to 12 kHz with an Octave switch beside it, which is a rumble at
one end, a sparkle at the other, and a coarse-and-fine pair for tuning one
oscillator against another.

It also shows its work: beside the envelope graph there is now a window
holding two cycles of the wave, drawn by running the oscillator itself, so
Width is something you can see rather than a number to interpret. And it stops
working when nothing can be heard -- at a gain of exactly zero, which is a
one-shot voice between notes or a Level knob shut, it makes no samples at all.
Eight idle voices cost 508 ms of work per ten seconds of audio before that and
316 ms after.

Milestone 9: the oscillator learns the other kind of FM. Its FM jack has a
mode switch -- exponential, which moves the pitch in octaves and is what a
keyboard or a falling envelope wants, and linear, which moves it in multiples
of the Pitch knob and is what an audio-rate modulator wants. Linear FM leaves
the average pitch exactly where it was tuned, so a second oscillator patched
into it adds a fixed set of partials instead of a wobble: bells, chimes,
clangs and the two-note coin every platform game has, neither of which this
rack could make before. The frequency is free to pass through zero and run
backwards, because stopping at zero folds the pitch back up again at exactly
the index where the interesting part starts.

Hard sync got the same attention underneath. The restart is now timed between
samples and the step it leaves is corrected like any other discontinuity in
the core, which is 13 dB less aliasing on every waveform and 30 dB on a sine.

Milestone 8: utilities, and a way to see what you are doing. The CV utility
gives the rack something it never had -- an attenuverter, so a modulation
source can be inverted, scaled or offset before it reaches where it is going.
A sample and hold gives four channels, each with its own clock and noise
source, so a channel is a stepped random generator with nothing patched into
it at all, and a slew limiter turns those steps into glides, a gate into an
envelope, or a pitch into portamento. A
scope shows the signal at any jack, as a triggered waveform or a log spectrum.

Milestone 7: the oscillator has an envelope of its own -- a full DAHDSR with
a trigger button on its panel and a graph of its shape -- available both as
its own amplitude and on an Env jack for the rest of the rack. Modules with a
trigger get their own button; the spacebar still fires everything.

Milestone 6: render, listen, then save. A batch renders into a list you can
play back and look at, keeping the ones that worked, so designing a sound no
longer means a round trip through a file manager. Every edit is undoable.

Every random source is seeded, so a render is reproducible, and a batch is the
same patch under a series of known seeds -- eight footsteps that belong
together rather than eight unrelated sounds. Kept takes download as WAV, or as
a zip when there is more than one.

The recorder is a rack module rather than a strip under the rack, and it is a
tap rather than a stage: it takes whatever is patched to it, at the level it
arrives, and patching one in cannot change what the rack sounds like.
