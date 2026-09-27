# Changelog

What changed, newest first. The README says what Fresyn is now; this is how
it got there. The older entries are the milestone notes that used to sit at
the top of the README, moved here as they were written.

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
