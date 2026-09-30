# Changelog

What changed, newest first. The README says what Fresyn is now; this is how
it got there. The older entries are the milestone notes that used to sit at
the top of the README, moved here as they were written.

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
