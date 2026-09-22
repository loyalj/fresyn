# Fresyn manual

A rack of sound-making modules you wire together with cables. This manual
assumes you have never used a modular synth. Nothing here is guesswork: every
patch in the tutorials is built and rendered by `npm run check:manual`, so if
a tutorial stops working, that test fails before you do.

---

## 1. The rack has two sides

The rack is a stack of **units**, one per module. Each unit has two faces:

- **The front** is knobs and switches. This is where you shape the sound.
- **The back** is jacks. This is where you decide what connects to what.

Press **Tab** to turn the rack around. The front is for tweaking, the back is
for wiring, and you will go back and forth constantly.

**A row holds one panel or two.** The modules that need the room -- the
Oscillator, the Keyboard, the Sample & Hold, the Sequencer, the Mixer, the
Scope and the Recorder -- take a full row. Everything else takes half of one, and two half
panels sitting next to each other in the rack share a row. They pair up in
patch order, so a half panel with a full-width one after it simply leaves the
rest of its row as blank rack space; move another half panel up next to it and
the gap closes.

**Drag a unit by the strip down its left edge** — the one with its name and
number on it — to move it up or down the rack. A copy of the panel follows
the pointer and the rack opens a gap where it will land; let go and it drops
in. This works on both faces, so you can reorder while looking at the wiring,
and the whole drag is a single undo.

**Turn the rack around to rebuild it.** On the back, hovering a unit reveals
three small buttons in its top-right corner: **▲** and **▼** move it one row,
and **×** removes it. The front has none of them, so nothing competes with the
controls that make a sound.

## 2. Make a sound right now

The rack you start with is already wired into a working synth voice.

1. Click anywhere on the page once (browsers will not let a page make sound
   until you interact with it).
2. Hold the **spacebar**.

You should hear a short plucked note. Space is what the rack's **Trigger**
module is bound to, and the Trigger's Gate jack is patched to the oscillator.
Hold the key and the gate opens; let go and it releases.

**One key does not fire the whole rack.** What a key plays is decided by
cables, like everything else here: a Trigger fires whatever its Gate jack is
patched to, and nothing more. Click the key cap under a Trigger's button to
bind it to a different key, or add a second Trigger on another key to play a
second sound. Two Triggers can share a key, and then both fire — which is how
you layer a body and a transient on one press.

Each module that can be triggered also has its own **TRIGGER** button on its
front panel, which fires just that one. Useful when you are working on one
layer of a sound and do not want to hear the rest.

### What you started with

Five modules and four cables:

- **gate1** — a **Trigger**, bound to **Space**. Its Gate jack is patched to
  the oscillator, which is the only reason a key makes a sound at all. It is
  the one module in the rack the keyboard reaches.
- **osc1** — an **Oscillator** making the sound. Its own envelope is turned
  up, which is what makes it a pluck instead of a drone.
- **lpf1** — a **Ladder Filter** taking the top off it. The oscillator's Env
  jack is patched to its CV, so the filter opens with the note and closes as
  it fades.
- **lfo1** — an **LFO**, patched to nothing. It is there because it is the
  first thing you will want, and where you send it is the first interesting
  decision.
- **mix1** — a **Mixer**, which is the way out to your speakers.

**The smallest rack that works is an Oscillator and a Mixer**, so you can
throw most of this away and still have a sound.

**There is no recorder.** The rack makes noise without one; add a **Recorder**
from **Modules → Output → Recorder** when you want files out of it, and its panel carries the
render controls.

### Or start from a finished rack

**Patch → Library...** opens a shelf of fifteen racks that already make a
sound — a laser, a footstep, wind, an explosion, gunfire, a sci-fi door.
Choosing one puts it on the bench with every cable patched and every knob set,
which is the fastest way to see what this rack can do before you have learned
where anything is.

They are **templates, not files**. Choosing one replaces what you are working
on with a copy of it; nothing is ever written back, and there is no way to
change what is on the shelf from inside the app. What you do to the copy is
yours, and **Patch → Export file...** is how you keep it.

It lands as one edit, so **Ctrl+Z** puts back whatever you had.

Each one is a tutorial from section 7, already built. Load it, take it apart,
and read the tutorial when you want to know why it works.

---

## 3. Controls

| Action | How |
| --- | --- |
| Play a Trigger | Hold the key on its cap — **Space** on the stock rack |
| Trigger one module | Hold its **TRIGGER** button |
| Turn the rack around | **Tab** |
| Undo | **Ctrl+Z** |
| Redo | **Ctrl+Shift+Z** or **Ctrl+Y** |
| Patch a cable | Drag from one jack to another (back panel) |
| Unplug a cable | Drag out of a jack and let go anywhere |
| Unplug a cable | Click the middle of the cable |
| Clear a jack | Right-click it |
| Add a module | **Modules** in the menu bar; it arrives at the top of the rack |
| Start from a finished rack | **Patch → Library...** |
| Render to WAV | **Render**, on the Recorder panel |
| Turn a knob | Drag it up and down |
| Turn a knob finely | Hold **Shift** while dragging |
| Nudge a knob | **Mouse wheel** over it |
| Step a knob exactly | **Shift + mouse wheel** |
| Type a knob's value | Click the number under it |
| Copy or paste a value | Right-click a knob |
| Reset a knob | Double-click it |
| Move a unit | Drag it by the strip on its left |
| Move a unit one row | Hover it on the back, use **▲ ▼** |
| Duplicate a unit | Hover it on the back, use **⧉** |
| Remove a unit | Hover it on the back, use **×** |
| Change the theme | The dropdown at the top |
| Switch dark and light | The sun/moon button beside it |

**Setting a knob to an exact number.** Dragging and the plain wheel are for
finding a value; **Shift + wheel** is for saying one. A notch moves the last
digit the readout is showing -- 1 Hz at 440 Hz, 10 Hz up at 8 kHz, a
millisecond under a second, 0.01 for everything else -- and it lands on a
multiple of that, so a knob which has to read exactly **1.00** gets there
rather than to 0.99. Clicking the number under a knob opens it for typing, in
the same units the readout prints: `1`, `250 ms`, `2.5 kHz`. Right-click a
knob to copy its value or paste one in; a paste is refused if it measures
something else, so a decay time cannot land in a cutoff.

The bar across the top is a panel of its own, bolted to the head of the rack:
it stays put while the rack scrolls under it, so the transport, the patch name
and **Tab** are always in reach.

The patch name at the top is just a text field. It saves automatically, and
it becomes the filename when you export sounds.

**Import** and **Export** load and save the whole rack as a `.json` file.
**New** starts over from the stock rack, and asks once before it does.

Beside them are the two appearance controls. The dropdown picks a **theme** and
the button next to it swings that theme between **dark and light**:

| Theme | Dark | Light |
| --- | --- | --- |
| **Standard** | the original studio grey and amber | the same rack under a bench lamp |
| **Fall Cafe** | espresso, plum and lamplight | oat milk, kraft paper, dried leaves |
| **Neon Vice** | purple and hot pink | pink and blue tubes in daylight |
| **Mesa** | red rock after sundown | sun-struck adobe, clay and sage |
| **Terminal 80s** | a green phosphor tube | electric orange on sepia |

Every theme has both modes, so the two choices never fight each other. The rack
cross-fades rather than cutting, and your choice is remembered.

## 4. What travels down a cable

Every cable carries a stream of numbers. What those numbers *mean* depends on
what you plug them into. There are three ways to think about them:

- **Audio** — the numbers wiggle thousands of times a second, roughly between
  −1 and +1. This is the sound itself.
- **CV** ("control voltage") — the numbers move slowly. A cable like this is
  not heard directly; it turns something else's knob for you. An envelope
  opening a filter is CV.
- **Gate** — the numbers are either 0 or 1. This says *when* something should
  happen: start a note now, stop it now.

There is no difference in the wiring. **Any output can go to any input.** The
only thing that changes is whether the result is useful, and part of learning
a modular is discovering which combinations are.

### Two rules worth knowing early

**One cable per input.** Plug a second cable into an occupied input and the
first one pops out, exactly like a real patch bay. This is convenient, not a
limitation: it means swapping a sound source is one drag rather than two.

**Outputs fan out.** One output can feed as many inputs as you want. Take an
envelope to a filter *and* a VCA *and* a pitch input at the same time. This
is why there is no "multiple" module — you never need one.

### Normalled inputs

Some inputs do something sensible when nothing is plugged into them:

- **Recorder — R** copies the L jack, so a mono patch needs one cable.
- **Recorder — L / Mono** with nothing patched records what you hear.
- **Sample & Hold — In 1 – 4** use that channel's built-in noise.
- **Sample & Hold — Trig 1 – 4** use that channel's built-in clock.
- **CV Utility — 1 / 2** read as zero, so the channel outputs its offset knob.

Plug something in and the normal steps aside.

---

## 5. The modules

Ranges are given as they read on the panel. "Default" is what a freshly added
module starts at.

### Trigger

A key, as a cable. This is the only module the keyboard plays: everything else
in the rack is fired from one down a cable, or by its own panel button.

Under the button is the **key cap**, which says which key opens this gate.
Click it and press the key you want; **Backspace** clears the binding and
**Escape** leaves it alone. A few keys are refused because the rack already
uses them — the cap says *In use* rather than silently doing nothing.

Add one Trigger per sound you want to play separately. Two on the same key is
allowed, and fires both.

**Mode** is what the gate does with a press.

| Mode | What a press does |
| --- | --- |
| **held** | The gate is open for exactly as long as you hold the key. |
| **once** | A fixed gate of **Length**, however briefly you touched the key. |
| **latch** | Tap on, tap again off. The button stays lit in between. |

**once is the one that saves takes.** A percussive sound wants the same gate
every time, and a finger that stayed down 400 ms when it meant 80 is the usual
way a render comes out wrong. Set Length and the shot is the same whether you
tapped it or leaned on it. Pressing again part way through starts it over,
which is what the Burst does with a run.

**latch is for the things you are not playing.** A wind bed, a drone, an
engine you want running while both hands are on other knobs. It is the only
mode a render ignores: a render has no second press, so a latched Trigger
holds for the render's Gate setting like any other.

You can still hold a **once** Trigger down — nothing stops you — but the gate
it puts out will not get any longer.

- **Outputs:** Gate
- **Knobs:** Mode, Length
- **Key:** set on the cap. A new Trigger arrives on **Space**.

| Control | Range | Default | What it does |
| --- | --- | --- | --- |
| Mode | held / once / latch | held | What a press does |
| Length | 2 ms – 2.00 s | 80 ms | How long a **once** gate lasts |

---

### Oscillator

The main sound source: a repeating waveform. It also contains a complete
envelope of its own, so a simple sound can be made from this module alone.

- **Inputs:** FM, PWM, Sync, Gate
- **Outputs:** Out (the sound), Env (its envelope as CV)

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Pitch | 20 Hz – 4.00 kHz | 110 Hz | How high it sounds |
| Wave | saw / pulse / tri / sine | saw | Its tone. Saw is bright and buzzy, sine is pure, pulse is hollow, tri is soft |
| Width | 0.02 – 0.98 | 0.50 | Shapes **pulse** and **tri**; saw and sine ignore it. Away from 0.50 a pulse gets thinner and nasal, and a triangle tilts into a ramp |
| FM Amt | −4.00 – +4.00 | 0.00 | How far the FM input moves the pitch, in octaves |
| Env Amt | 0.00 – 1.00 | 0.00 | How much its own envelope shapes its volume. **At 0 the envelope is not heard** |
| Delay | 0 ms – 2.00 s | 0 ms | Wait this long after the trigger before starting |
| Attack | 1 ms – 2.00 s | 2 ms | Time to rise to full |
| Hold | 0 ms – 2.00 s | 0 ms | Stay at full this long |
| Decay | 2 ms – 4.00 s | 350 ms | Time to fall to the Sustain level |
| Sustain | 0.00 – 1.00 | 0.00 | Level it rests at while the trigger is held |
| Release | 2 ms – 4.00 s | 150 ms | Time to fade out after you let go |

The graph on the panel is drawn by running the envelope itself, so it always
matches what you will hear.

**About FM Amt:** the pitch change is in octaves, so +1.00 means a signal of
1.0 raises the pitch by one octave. An envelope running 1 → 0 with FM Amt at
+3.00 therefore starts three octaves up and falls to the Pitch knob. That is
a laser.

**Env Amt is a blend, not a switch.** At 0.00 the oscillator drones. At 1.00
it is entirely the envelope's to shape. Halfway, it never fully goes quiet.

**The Env output works whatever Env Amt is set to.** You can use the
oscillator purely as an envelope generator if you like.

---

### Keyboard

Twenty-five keys and an octave switch. Click a key to play it; the key stays
lit, because it is the note the Pitch jack is putting out.

- **Inputs:** Gate (fires the note you clicked last)
- **Outputs:** Pitch (which note, in octaves), Gate (high while a key is held,
  or while the Gate input is)

| Control | Range | Default | What it does |
| --- | --- | --- | --- |
| The keys | 25, two octaves | bottom C | Which note, and the gate while held |
| Octave | −3 – +3 | 0 | Moves the whole keyboard by whole octaves |

**Pitch comes out in octaves, not in hertz.** That is the unit every
destination in this rack already takes, so the way to play an oscillator is:

- **key1 · Pitch → osc1 · FM**, with **osc1 · FM Amt** at **+1.00**.
- **key1 · Gate → env1 · Gate**, or straight to an oscillator's own Gate.

With FM Amt at +1.00 the keyboard plays in tune: the bottom key puts out
nothing at all, so it sounds the oscillator's **Pitch** knob, and every key
above it adds a semitone. Set the oscillator's Pitch to the note you want the
bottom key to be.

**A render plays it too**, opening the gate without touching the note, so
what sounds is whichever key you pressed last. That is how you render a batch
of one note: play it, then hit Render.

**Patch a Trigger into its Gate jack and your computer keyboard plays it**,
at whichever key you clicked last. That is the useful shape of this module:
the keys choose the note, the Trigger fires it. Click a C, then play C on
Space as many times as you like; click an E and Space plays an E.

Anything that puts out a gate works there, not just a Trigger — a **Burst**
gives you a run of one note, a **Sequencer**'s Gate gives you a rhythm on it,
and a **Clock** gives you a metronome.

**Nothing glides.** The keyboard steps from note to note, as a keyboard
should. Put a **Slew** between Pitch and FM if you want portamento.

**Try:** FM Amt at **+2.00** makes every key a whole tone, which is a scale
nobody has — useful for alien speech. Negative FM Amt plays the keyboard
upside down.

---

### Noise

Not a pitch, just hiss. Most real-world sound effects — footsteps, wind, fire,
impacts, surf — have far more noise in them than tone.

- **Outputs:** Out
- **Inputs:** none

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Color | white / pink | white | White is bright and harsh. Pink has more low end |
| Level | 0.00 – 1.00 | 1.00 | Volume |

**Reach for pink first.** Wind, rain, fire and surf all sit much closer to
pink than to white, and white through a filter never quite gets there.

---

### LFO

An oscillator too slow to hear, used as CV to make something wobble.

- **Inputs:** Sync (restarts the shape), PWM
- **Outputs:** Out (swings negative and positive), Uni (never goes negative)

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Rate | 0.02 Hz – 200 Hz | 4.00 Hz | How fast it wobbles |
| Shape | saw / pulse / tri / sine | sine | The shape of the wobble |
| Width | 0.02 – 0.98 | 0.50 | Shapes **pulse** and **tri**, exactly as the Oscillator's does |
| Depth | 0.00 – 1.00 | 1.00 | How far it swings |

**Out or Uni?** Use **Uni** for anything that should not go backwards — filter
cutoff, VCA level, pulse width. Use **Out** for anything that should swing
both ways around its knob setting, like vibrato.

**Width is how you get a trigger out of an LFO.** A pulse narrowed to 0.05
is a brief blip once per cycle rather than a square, which makes it a
repeating trigger — patch it to a Gate input to fire something on a steady
beat. Widen it back out and you have a rhythmic gate whose length you can
dial in.

**On the triangle, Width tilts rather than narrows.** Near 0.02 it is a
down-ramp, at 0.50 a symmetrical triangle, near 0.98 an up-ramp. A slow
down-ramp into a filter is a decay you never have to trigger.

**The PWM input sweeps that width for you**, scaled so an input of 1.0 moves
it by 0.45. A second, slower LFO into PWM is the classic shifting pulse; an
envelope into PWM makes a gate that grows or shrinks as a sound develops.

Turn Rate all the way up and it reaches audio range, which is a different
instrument entirely — patch it into an Oscillator's FM for metallic tones.

---

### Envelope

A shape that happens when you trigger it. On its own it is silent; it exists
to move something else.

- **Inputs:** Gate
- **Outputs:** Out

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Attack | 1 ms – 2.00 s | 2 ms | Time to rise to full |
| Decay | 2 ms – 4.00 s | 350 ms | Time to fall to Sustain |
| Sustain | 0.00 – 1.00 | 0.00 | Level held while the trigger is down |
| Release | 2 ms – 4.00 s | 150 ms | Time to fade after release |

**With Sustain at 0** the sound dies on its own whether or not you keep
holding — which is what you want for impacts, footsteps and gunshots. Raise
Sustain for anything that should ring on while held, like an engine.

---

### Sample & Hold

Looks at its input at regular moments and holds that value steady until the
next one. Its usefulness is out of all proportion to its size.

**Four independent channels on one panel.** Each has its own clock, its own
noise source and its own Rate, and knows nothing about the other three.

- **Inputs:** In 1 – 4 (each normals to its own noise), Trig 1 – 4 (each
  normals to its own clock)
- **Outputs:** Out 1 – 4 (the held value), Clk 1 – 4 (that channel's clock,
  as a gate)

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Rate 1 – 4 | 0.10 Hz – 50 Hz | 6.00 Hz | How often that channel takes a reading |

**With nothing patched at all**, a channel is a random-number generator
ticking at its Rate — the classic burbling "computer thinking" source. Patch
its Out to a pitch and you get random notes; to a filter and you get random
timbres.

**The Clk outputs are the rack's only steady clocks.** Use one to fire
envelopes, oscillators or anything else on a regular beat.

**Channels are worth using together.** Random pitch on channel 1 and random
filter cutoff on channel 2, at different Rates, sounds like two things
happening rather than one thing wobbling. Retuning one channel never disturbs
what the others are doing.

---

### Clock

A steady pulse, and the same pulse divided down beside it. This is what keeps
several parts of a patch related to each other instead of drifting apart.

- **Inputs:** Reset (a trigger, not a level — it restarts the count and lets
  go), CV
- **Outputs:** x1, /2, /3, /4, /8

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Rate | 0.10 Hz – 200 Hz | 4.00 Hz | The speed of the **x1** output; the rest follow from it |
| CV Amt | −5.00 – +5.00 | +0.00 | How far the CV input moves the rate, in octaves — so ±1 is double and half speed |
| Width | 0.02 – 0.98 | 0.50 | How long each pulse stays open, as a fraction of its own period |

Every output is a pulse train at its own rate, not a gate held open across
several ticks — so **/4** is a pulse every fourth tick, and Width narrows all
five together. Turn Width right down and you have five triggers; leave it at
0.50 and you have five square waves.

**Why divisions and not multiplications.** A sequencer on the beat, a burst
every fourth beat and a slow sweep underneath all want to stay in step. Doing
that with three separate Rate knobs means they drift apart the moment one of
them moves.

**CV Amt is where this gets interesting.** Patch an LFO into CV and the tempo
breathes. Patch an envelope in and it slows to a halt as the sound decays,
which is a music box winding down or a machine losing power.

---

### Burst

One trigger in, a run of triggers out. Press it once and get five.

- **Inputs:** Trig
- **Outputs:** Gate, Ramp, End
- **Trigger button:** yes

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Count | 1 – 16 | 4 | How many pulses the run is |
| Rate | 0.50 Hz – 200 Hz | 12 Hz | The spacing in the **middle** of the run |
| Curve | −1.00 – 1.00 | 0.00 | Positive spreads the run out as it goes, negative packs it together. At 0 the spacing is even |
| Jitter | 0.00 – 1.00 | 0.00 | Randomises the spacing, from this module's own seed |
| Width | 0.02 – 0.98 | 0.30 | How long each pulse stays open |

This is the module a rack of sound effects misses most. A footstep run, a
burst of gunfire, a ricochet, a rattle and a stutter are all the same shape:
several of one sound, spaced in a way that is not even.

**Curve is what stops it sounding like a machine.** Negative is a bouncing
object — the hits crowd together as it settles. Positive is a rattle coming to
rest. Rate stays put as you turn it, because the curve is measured about the
middle of the run rather than the start.

**The Ramp output is the other half of the idea.** It steps from 0 on the
first pulse to 1 on the last, so one cable makes every hit differ from the one
before it — patch it through a CV Utility into pitch for a bouncing ball, or
into a VCA for a rattle that dies away.

**End** fires once when the whole run is over, for chaining something after
it.

The Trig jack and the Trigger button both fire it; patching a cable in does
not take the button away.

---

### Sequencer

Eight steps of control voltage, each with a level of its own.

- **Inputs:** Clock, Reset
- **Outputs:** CV, Gate, Vel, Clk, End
- **Trigger button:** yes (it restarts the pattern)

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| CV 1–8 | −2.00 – +2.00 | a minor 7th arpeggio | What that step puts out, in octaves |
| Lvl 1–8 | 0.00 – 1.00 | 1.00 | How hard that step hits. **At 0 the step is a rest** |
| Rate | 0.10 Hz – 50 Hz | 4.00 Hz | Its own clock speed, used when nothing is patched to Clock |
| Steps | 1 – 8 | 8 | How long the pattern is before it loops |
| Gate | 0.05 – 0.95 | 0.50 | How long each step's gate stays open, as a fraction of the step |

**The level knob is what makes it a sequencer rather than a row of knobs.** A
step at zero is a rest, so the pattern has rhythm as well as pitch; anything
above zero is an accent, and it arrives on the **Vel** jack ready to drive a
VCA. The CV still moves during a rest, so a held note can change pitch under
one.

**Its clock is free-running and shared.** Like the Sample & Hold's, the
**Clk** output keeps ticking at Rate whether or not anything is patched to
Clock — so a sequencer is also the thing that keeps time for the rest of the
rack. Patch a Clock module in and that decides when it steps instead, and Rate
only governs the Clk jack.

**Two things restart it.** Its own button starts the pattern from step one,
and so does a rising edge at **Reset** — either one, whether or not the other
is in use, the same way the Burst's trigger works. The start of a render
restarts it too, so a rendered take always begins where the pattern begins.

**Reset is what lets something else start the pattern.** Patch a Trigger into
it and a key starts the sequence; patch a Burst's **End** into it and the
pattern restarts each time a run finishes; patch another sequencer's **End**
into it and two patterns of different lengths stay in step instead of drifting
apart.

Steps past the Steps knob are greyed on the panel rather than hidden. They
keep their values, so shortening a pattern and lengthening it again costs you
nothing.

**End** fires each time the pattern comes round, for chaining.

---

### Slew

Limits how fast its output can chase its input. Anything that changed
instantly now takes time to get there.

- **Inputs:** In
- **Outputs:** Out

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Rise | 1 ms – 4.00 s | 50 ms | Time to climb |
| Fall | 1 ms – 4.00 s | 50 ms | Time to drop |
| Shape | lin / exp | exp | **lin** is a straight ramp; **exp** eases in and slows as it arrives |

Three jobs in one module:

- On a **pitch**, it is portamento — notes slide instead of jumping.
- On a **Sample & Hold**, it turns the steps into glides, which is the
  difference between a burble and a melody.
- On a **gate**, it is an instant attack-and-release envelope, and the
  cheapest way to stop something clicking.

---

### CV Utility

Two channels that scale, flip and offset a control signal before it arrives,
plus their sum. Unglamorous, and it will change how much of the rack you can
actually use.

- **Inputs:** 1, 2
- **Outputs:** 1, 2, Sum (channel 1 + channel 2)

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Gain 1 / Gain 2 | −2.00 – 2.00 | 1.00 | Multiplies the input. **Negative turns the signal upside down** |
| Off 1 / Off 2 | −1.00 – 1.00 | 0.00 | Adds a fixed amount |

Each channel works out as `output = input × Gain + Off`.

**This is how you reverse a modulation.** Nothing else in the rack can. Set
Gain to −1.00 and Off to 1.00 and a signal running 0 → 1 comes out running
1 → 0, so a falling envelope becomes a rising one.

**With nothing plugged in**, a channel outputs its Off knob and nothing else —
a constant value you can dial in by hand. Handy for nudging a filter or
holding a VCA part-open.

**Use Sum to combine two modulations** — an envelope plus an LFO, say. The
Mixer is for audio and has pan controls on every channel, which is the wrong
shape for adding two control signals together.

---

### Ladder Filter

Keeps one part of the frequency range and removes the rest. The single most
useful thing you can do to a sound.

- **Inputs:** In, CV
- **Outputs:** Out

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Cutoff | 20 Hz – 18.00 kHz | 1.40 kHz | Where the filter turns over |
| Res | 0.00 – 1.00 | 0.35 | Emphasises the cutoff frequency. High settings whistle |
| Drive | 1.00x – 12.00x | 1.50x | Pushes the filter harder. Adds grit and warmth |
| CV Amt | −5.00 – +5.00 | +2.50 | How far the CV input moves the cutoff, in octaves |
| Mode | lp24 / lp12 / bp / hp | lp24 | Which part of the range it keeps |

**Mode** decides what Cutoff means.

| Mode | What it keeps |
| --- | --- |
| **lp24** | Everything below the cutoff. Four poles, so the removal is steep. |
| **lp12** | The same, two poles. A gentler slope that leaves some air on top. |
| **bp** | Only the band around the cutoff. Nasal, telephone, radio. |
| **hp** | Everything above the cutoff. |

**hp is how you take the weight out of something.** A layered impact usually
has two or three sources all carrying low end, and only one of them should;
put a highpass at 200–400 Hz on the others and the low layer has room. It is
the most-reached-for fix in a rack that is starting to sound muddy.

**bp is a character, not a correction.** Narrow it around 1–2 kHz and anything
sounds like it is coming through a speaker — a radio voice, a distant
tannoy, a machine heard through a wall.

The four modes come off the same four filter stages, so **Res** and **Drive**
mean the same thing in all of them, and the CV input sweeps all of them.

**A filter with an envelope on its CV is most of what "synthesised" sounds
like.** The tone opening and closing over the length of a note is what your
ear reads as a real object being struck, scraped or fired.

Turn **Res** up near 1.00 and the filter begins to sing at its own cutoff
frequency even with nothing going in.

---

### Drive

Push a signal into something that cannot pass all of it, and what comes out
has harmonics that were never in what went in.

- **Inputs:** In
- **Outputs:** Out

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Drive | 1.00x – 64.00x | 2.00x | How hard the signal is pushed into the curve |
| Curve | tanh / clip / fold / rect | tanh | The shape it runs into |
| Bias | −1.00 – 1.00 | 0.00 | Slides the signal off centre before shaping, so one half clips harder than the other |
| Level | 0.00 – 1.00 | 1.00 | Output trim |

The four curves are four ways of running out of room:

- **tanh** is a valve easing into its limit — the one that still sounds like
  the original, only louder and rounder.
- **clip** stops dead at the ceiling. That is a transistor, and it is harsher.
- **fold** turns back on itself instead of stopping, so the loudest part of a
  wave becomes the quietest. Glassy and electronic rather than dirty. The
  **Wavefolder** does this over and over; here it happens once.
- **rect** flips the bottom half of the wave up, which doubles the frequency
  and hollows the tone out.

**Bias is the knob worth knowing.** Clipping a centred wave adds only odd
harmonics, which sounds like clean distortion. Slide it off centre and the
even ones arrive too — and that is the growl of a worn engine, a large animal,
or a speaker being asked for more than it has. It is the difference between
"distorted" and "damaged".

The output is DC-blocked, because asymmetric clipping produces a DC offset by
definition. The harmonics that do the work are unaffected by taking it out.

---

### Wavefolder

Past the rails the signal turns back on itself, again and again, so a sine
that went in comes out with a dozen creases in it.

- **Inputs:** In
- **Outputs:** Out

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Fold | 1.00x – 16.00x | 2.00x | How far past the rails the signal is driven, and so how many times it folds |
| Sym | −1.00 – 1.00 | 0.00 | Slides the wave off centre within the fold pattern |

**This is the opposite of overdrive, not a stronger version of it.** Drive
takes the peaks *off* a wave, so past a point it stops changing much — a
flattened version of what you had. Folding replaces the peaks with new ones,
so the harder you push, the more is going on. Turn Fold up and harmonics keep
arriving instead of settling into a buzz.

It is how a single sine becomes a bell, a bright metallic drone, or a tone no
filter sweep can reach.

**There is no CV jack, and it does not need one.** Folding depends on how hard
the wave is driven into the rails, so a **VCA** in front of this module is
already a Fold modulator — and an envelope through that VCA is the sweep the
module exists for.

**Sym rearranges rather than intensifies.** Because folding repeats, sliding
the wave off centre lands it on different creases instead of distorting one
half harder the way **Bias** does on the Drive. Sweep it and the harmonics
reshuffle.

---

### Ring Mod

Two signals multiplied together, which sounds like neither of them.

- **Inputs:** In, Car
- **Outputs:** Out, Sine

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Freq | 1.00 Hz – 4.00 kHz | 220 Hz | The internal carrier's pitch |
| Mix | 0.00 – 1.00 | 1.00 | Dry at 0, ring modulated at 1 |

Ring modulation replaces every frequency in the input with two new ones — the
sum and the difference against the carrier — and those land wherever the
arithmetic puts them rather than in any harmonic series. Feed it 200 Hz with
the carrier at 700 Hz and you get 500 Hz and 900 Hz, and **no 200 Hz at all**.

That is why it is the one effect in the rack that reliably makes something
sound like it was never alive: the Dalek, the alien, the possessed telephone,
the bell that is not quite a bell.

**The carrier keeps running whether or not anything is patched**, and appears
on the **Sine** jack — the same arrangement the Sample & Hold's clocks use. So
it is also simply a spare sine when you want one, and two Ring Mods can share
a carrier.

**Patch something into Car and that takes over.** An LFO makes it a tremolo
rather than a ring modulator, because a carrier below hearing moves the
sidebands too little to separate from the original. Somewhere around 20–80 Hz
is where one turns into the other.

---

### Bitcrusher

Two kinds of damage in one panel, because they are the two halves of what
digital audio throws away and they are always wanted together.

- **Inputs:** In
- **Outputs:** Out

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Bits | 1 – 16 | 8 | How finely the level is measured |
| Rate | 100 Hz – 24.00 kHz | 8.00 kHz | How often it is measured at all |
| Mix | 0.00 – 1.00 | 1.00 | Dry at 0, crushed at 1 |

**Bits** is quantisation. Drop it and the quiet parts of a sound land on the
same few values, which is heard as grit that gets *worse* as the sound fades
— the opposite of analogue distortion, and the giveaway that something is
digital rather than dirty.

**Rate** is decimation. Drop it and everything above half the new rate folds
back down into the audible range as a metallic ringing unrelated to the
original pitch. This is the sound of a sample played back on hardware that
could not afford to store it properly: retro weapons, damaged electronics, a
radio voice arriving through something broken.

The two are worth setting separately. Bits alone is grit; Rate alone is a
tuned, bell-like ringing on top of a clean sound; together they are a sample
that has been through too much.

**Try:** an envelope into a VCA *after* this, with Rate around 1–2 kHz, is a
power-down. Bits at 1 or 2 with Mix at 1 is barely a sound any more, which is
exactly right for something breaking.

---

### Compressor

Turns the loud parts down, so the quiet parts can come up. This is how you
decide *how hard something hits* rather than leaving it to whatever the
envelope happened to do.

- **Inputs:** In, Key
- **Outputs:** Out, GR

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Thresh | −60.0 – +0.0 dB | −18.0 dB | The level it starts working at |
| Ratio | 1.00 – 20.00 | 4.00 | How hard. At 4, a sound 8 dB over comes out 2 dB over |
| Attack | 0 ms – 200 ms | 5 ms | How quickly it clamps down once the threshold is crossed |
| Release | 5 ms – 2.00 s | 150 ms | How quickly it lets go again |
| Makeup | +0.0 – +12.0 dB | +0.0 dB | Gain put back after the reduction |

**Attack is a tone control, not just a level one.** This is the knob that
matters on impacts. Short and the transient is caught and flattened, which
makes a hit sound soft and distant. Long and the initial click gets through at
full height before the body is pulled down — which is what your ear reads as
something hard striking something hard. If an impact sounds limp, lengthen the
attack before you touch anything else.

**Ratio at the top is a limiter.** Nothing meaningful gets past the threshold,
which is why there is no separate limiter module. Put one at the end of a
patch with Thresh near −3 dB to stop a render clipping.

**Key is the interesting jack.** Patch another signal into it and *that*
decides when the compressor ducks, while the signal at **In** is the one that
gets ducked. An engine that dips under every gunshot; room tone that gets out
of the way of a footstep; a bass layer that pumps in time with a clock. With
nothing patched it listens to its own input, which is ordinary compression.

**GR** is how hard it is working, as a control voltage — zero when it is doing
nothing, rising towards one as it clamps down. 6 dB of reduction arrives as
0.50. Patch it to a filter's CV for a sound that dulls as it is pushed, or to
a VCA to drive something else from this sound's dynamics.

**Try:** a **Noise** into **In**, a **Trigger** through an **Envelope** into
**Key**, Ratio at 20 and Release around 300 ms. The noise bed ducks hard on
every press and swells back — a wind bed breathing around a sound that is not
even in the same chain.

---

### Granular

Chops whatever arrives at it into short overlapping grains and plays them back
scattered in time, pitch and space.

**This is the module that makes a sound keep going.** Everything else in the
rack shapes an event — a trigger, an envelope, a decay. A granulator takes a
fraction of a second of material and makes as much of it as you want, never
quite repeating. Wind, rain, fire, crowds, engines and rubble are all this.

- **Inputs:** In, Pos, Pitch
- **Outputs:** L, R

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Size | 2 ms – 500 ms | 80 ms | How long each grain is |
| Density | 0.50 Hz – 200 Hz | 20 Hz | How many grains start per second |
| Pos | 5 ms – 2.00 s | 100 ms | How far back in the recording the grains are read from |
| Spray | 0.00 – 1.00 | 0.20 | Scatters Pos randomly, as a fraction of the whole buffer |
| Pitch | −2.00 – +2.00 | +0.00 | Grain playback speed, in octaves |
| Spread | 0.00 – 1.00 | 0.50 | How far across the stereo image the grains are thrown |
| Mix | 0.00 – 1.00 | 1.00 | Dry at 0, grains at 1 |

**It granulates its input, not a file.** It is always recording the last two
seconds of whatever reaches **In**, and the grains are read from somewhere
behind that — **Pos** is how far behind. So a **Noise** into it is wind, an
**Oscillator** is a shimmering drone, an impact is the debris that follows it,
and a **Delay** in front of it is a cloud of a cloud.

**Size and Density decide what it is.** Short grains packed close are a
texture with a pitch of their own; long grains spread apart are a landscape of
recognisable fragments. Everything else scatters: **Spray** in time, **Pitch**
in frequency, **Spread** across the image.

| For | Size | Density | Spray |
| --- | --- | --- | --- |
| Wind, rain, a crowd | 60 – 150 ms | 40 – 100 Hz | 0.60 – 1.00 |
| Fire, rubble, crackle | 5 – 20 ms | 20 – 60 Hz | 0.40 – 0.80 |
| A shimmering pad | 200 – 400 ms | 20 – 40 Hz | 0.05 – 0.20 |
| A stutter | 30 – 80 ms | 8 – 20 Hz | 0.00 |

**It takes a moment to fill.** The buffer starts empty, so a granulator that
has just been added — or one with **Pos** set further back than the sound has
been running — puts out silence until there is something there to read. That
is not a fault; it is the same reason a delay is quiet on its first pass.

**Each grain takes its settings when it starts and keeps them.** A control
voltage at **Pitch** therefore steps between grains rather than bending what is
already sounding, which is what you want — a cloud of different pitches rather
than one sliding one. Patch a **Sample & Hold** there and every grain comes out
at a different pitch. The **Pos** input works the same way, and reaches across
the whole two seconds.

**It is stereo**, so it takes two mixer channels panned hard apart. Put
**Spread** at 0.00 and it collapses to a point, which is what you want before a
**Space** that is going to place it somewhere itself.

**Dense settings saturate rather than clip.** With Spray and Pitch at zero the
grains are all reading the same thing and pile up in step; the output stage
takes the top off that instead of letting it tear. Turn Density down or Spray
up if you hear it thickening more than you meant.

**Try:** a **Noise** into **In**, Size 100 ms, Density 60 Hz, Spray 0.80,
Spread 1.00. That is wind. Now patch an **LFO** at about 0.15 Hz into **Pitch**
and it is wind that gusts.

---

### Delay

A delay line with the repeats fed back into it. The rack was entirely dry
before this module: a sound with nothing around it reads as a sample rather
than as something that happened somewhere.

- **Inputs:** In, Time (CV)
- **Outputs:** Out (dry and repeats mixed), Wet (the repeats alone)

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Time | 2 ms – 2.00 s | 40 ms | How far back each repeat comes from |
| Time Amt | −2.00 – +2.00 | +0.00 | How far the Time input moves it, in octaves — so ±1 is double and half the distance |
| Fdbk | 0.00 – 0.95 | 0.35 | How much of each repeat goes round again |
| Damp | 0.00 – 1.00 | 0.30 | Takes the high end off the repeats, so each one sounds further away |
| Mix | 0.00 – 1.00 | 0.35 | Dry at 0, repeats only at 1 |

**Time CV is what makes this more than an echo.** The read distance glides
rather than jumping, so moving it moves the pitch of everything already in
the line — the same thing that happens when a tape machine changes speed.

- An **envelope** into Time is a laser or a falling zap.
- An **LFO** into Time, with Time short, is a chorus or a flanger.
- A **slow sweep** is a tape machine being leaned on.

**Short times are their own effect.** Below about 20 ms the repeats stop being
heard as repeats and become a comb filter — metallic, hollow, and the basis of
a robot voice or a small pipe.

The feedback path saturates and loses high end each time round, so a long
feedback settles into something duller rather than something louder. The knob
cannot make it run away.

**Wet** carries the repeats without the dry signal, for sending them somewhere
the original does not go — into the Space module, say, so only the echoes are
in the room.

---

### Space

A reverb: four delay lines feeding each other back through a matrix, which is
the cheapest thing that sounds like a room rather than like four echoes.

- **Inputs:** In
- **Outputs:** L, R

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Size | 0.00 – 1.00 | 0.50 | How far away the walls are. Small is a box or a cupboard, large is a hall |
| Decay | 50 ms – 20.00 s | 1.60 s | How long the tail lasts, independent of Size |
| Damp | 0.00 – 1.00 | 0.40 | How soft the walls are. Up is carpet and curtains, down is tile and glass |
| Mix | 0.00 – 1.00 | 0.30 | Dry at 0, tail only at 1 |

**It is stereo out.** The two jacks carry different combinations of the four
lines, so the tail has width — patch L and R into two mixer channels panned
hard apart and the room opens up. Patching only one is a perfectly good mono
reverb.

**Size and Decay are separate on purpose.** A small room with a long decay is
not a real place, which is exactly what makes it useful: it is a metallic
spring, a sewer pipe, a spaceship corridor. A large room with a short decay is
an open field.

**Put it last.** Reverb belongs after the filter and the VCA, on the way into
the mixer — a room applied before the envelope shapes the sound will be cut
off with it, which is the one arrangement that never sounds like a space.

---

### Resonator

A delay line tuned to a pitch and fed back into itself: whatever goes in comes
out ringing at that note.

- **Inputs:** In, CV
- **Outputs:** Out

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Pitch | 20 Hz – 4.00 kHz | 220 Hz | The note it rings at |
| CV Amt | −5.00 – +5.00 | +0.00 | How far the CV input moves that, in octaves |
| Decay | 10 ms – 10.00 s | 600 ms | How long it rings for, whatever the pitch |
| Damp | 0.00 – 1.00 | 0.40 | Takes the high end off each time round, so the ring gets duller as it fades |

**What you patch in is the exciter**, and the rack is full of things to patch:

- A **burst of noise** through a short envelope is a plucked string.
- A **click** — a Burst pulse straight in — is a struck pipe or a bell.
- The **Burst** module with a few pulses is a ricochet, because a ricochet is
  a pitched ping repeated and crowding together.
- A **continuous tone** gives the hollow, tuned colour of a resonant body: a
  sci-fi door, a metal gantry, a hull.

The output is the ringing alone, not the ringing plus what you fed it. Use a
mixer channel for the dry signal if you want both — that way you can balance
them, which a Mix knob on this panel would not let you do as well.

**Decay is in seconds, not as an amount of feedback.** A high note goes round
its loop far more often than a low one, so a single feedback amount would make
the top of the range die instantly while the bottom rang forever. Set it in
seconds and the whole keyboard rings for as long as you asked.

---

### VCA

A volume knob that something else turns. Audio in, control in, quieter audio
out.

- **Inputs:** In, CV
- **Outputs:** Out

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Level | 0.00 – 1.00 | 0.00 | Volume before any CV is added |
| CV Amt | 0.00 – 2.00 | 1.00 | How much the CV input opens it |

It works out as `gain = Level + (CV × CV Amt)`.

**Level starts at 0.00 on purpose**, so a new VCA is silent until something
opens it. If a patch has gone quiet, this is the first knob to check.

An Envelope into CV is what turns a continuous drone into a note.

---

### Mixer

Eight inputs, one stereo output. Where layers get combined — and the way
out to your speakers. **A rack with no mixer is silent.**

- **Inputs:** 1 – 8
- **Outputs:** L, R

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Pan 1 – 8 | −1.00 – +1.00 | 0.00 | Left or right for that channel |
| Lvl 1 – 8 | 0.00 – 1.00 | 0.80 | Volume of that channel |
| Master | 0.00 – 1.00 | 0.80 | Volume of the whole mix |
| M | off / on | off | Mutes that channel |
| S | off / on | off | Solos it — silences every channel that is not soloed |

Every channel has a **meter** beside its knobs, and the main bus has one of
its own. They show peak level after the Lvl knob, so a meter reads what that
channel is actually putting into the mix, not what is arriving at the jack —
turn Lvl down and the meter comes down with it. The scale is in decibels down
to −48, so quiet layers still move the bar.

Real sound effects are almost always layers. An explosion is a low thump, a
mid-range body and a bright crack — three sources into three channels.

**Muting a channel is the fastest way to hear what a layer contributes.**
Press **M** under its fader, listen, press it again. This is the same thing as
pulling the fader to zero, except that the fader is still where you left it
when you come back.

**S solos.** One channel soloed anywhere on the mixer silences every channel
that is not — which is how you check a layer on its own without touching seven
other faders. Solo several at once to hear a group.

**M wins over S.** A channel that is both soloed and muted stays silent: solo
decides which channels are in the running, mute decides which are switched
off. That is how a desk behaves, and it means you can solo a group and still
drop one out of it.

A muted channel's meter goes dark, so a strip that is switched off looks
different from one that simply has nothing arriving at it.

**A dead channel shows up on its meter.** If a layer is missing, look at the
strip: a flat meter means nothing is reaching it, so the problem is the cable,
not the mix.

---

### Scope

Shows you the signal at any jack. It has no output and cannot change your
sound — you tap a signal rather than passing through it.

- **Inputs:** In
- **Outputs:** none

| Knob | Range | Default | What it does |
| --- | --- | --- | --- |
| Time | 1 ms – 80 ms | 20 ms | How much time fills the screen. Lower = more zoomed in |
| Gain | 0.10x – 16.00x | 1.00x | Vertical zoom. Turn up to see quiet signals |
| Mode | wave / spectrum | wave | Shape over time, or loudness by frequency |

**wave** shows the waveform. It is held still by starting each frame at the
same point in the cycle, so a steady tone looks stationary.

**spectrum** shows which frequencies are present, low on the left to high on
the right. A bright sound leans right, a dull one leans left.

Because outputs fan out, you can leave a scope attached to something while
that signal also goes where it was going. Patch one to a CV signal to see
your envelope shape as it actually arrives.

---

### Recorder

Where renders come from. It has no knobs of its own beyond the render
settings: it is a tape machine, not a mixer, so it takes the level it is
given. Volume lives on the Mixer's **Master**.

- **Inputs:** L / Mono, R
- **Outputs:** none

**With nothing patched it records what you hear**, so you can render the
moment the rack makes a sound. Patch it when you want to record something
else — one channel, a sub-mix, a layer before the master.

Patch only **L / Mono** and the same sound goes to both speakers.

A recorder cannot change what the rack sounds like. It has no outputs, so
like the Scope it only listens, and taking a mixer to one leaves that mixer
just as audible as it was.

---

## 6. Rendering sounds to files

Everything so far has been about the rack. This is about getting files out of
it. The render settings live on the **Recorder** module. Its jacks decide
what gets recorded; with nothing patched to them, that is whatever you hear.

They are knobs, turned the same way every other knob in the rack is: drag up
and down, hold **Shift** for fine control, roll the mouse wheel over one to
nudge it, and double-click to put it back to its default.

| Setting | Range | Default | What it does |
| --- | --- | --- | --- |
| Takes | 1 – 64 | 8 | How many variations to render |
| Length | 0.1 – 30 s | 2 | Longest a take may run. Silence at the end is trimmed |
| Gate | 0.001 – 10 s | 0.1 | How long the trigger is held for each take |
| Spread | 0 – 0.5 | 0.08 | How far knobs wander between takes. 0 means identical takes |
| Seed | 1 – 128 | 1 | The same seed always gives exactly the same takes |
| Format | — | 48 kHz · 16-bit | Sample rate and bit depth |

Press **Render** and you get a list of takes. Click a waveform to hear it,
click again to stop. Untick the ones you do not want. Untick any you do not want, then **Save** — one take
downloads as a `.wav`, several as a `.zip`.

**This is the reason the app exists.** Ten footsteps that are recognisably the
same footstep but not identical is what stops a game sounding repetitive, and
Spread is the knob that decides how varied they are. Start around 0.05 – 0.10.

**Nothing is written to disk until you press Save.** Render freely.

**Renders are reproducible.** Note the seed of a take you liked and you can
make it again exactly, even after closing the browser.

---

## 7. Tutorials

Knob values are written as they read on the panel. You do not have to hit them
exactly — these are sound effects, and near enough is near enough.

**Every tutorial here is in Patch → Library**, already built. Building one by
hand teaches you more than loading it does, which is why the steps are
written out — but if you only want to hear where a tutorial ends up, or you
have lost your place half way through, the finished rack is one menu away.

### Build the tutorial rack

Every tutorial below starts from the same rack. The stock rack you get from
**New** is a voice, not a workbench: several of these run **noise** through the
filter, and noise carries no envelope of its own, so they need a separate
envelope and a VCA for it to open. The **Trigger** that fires them is already
there, on **Space**.

Build it once and keep it. Press **New** if you want to start over — it does
not ask, because **Ctrl+Z** brings back whatever it replaced.

**You already have five modules.** New gives you `gate1`, `osc1`, `lpf1`,
`lfo1` and `mix1` — a Trigger, an oscillator, a filter, an LFO and the mixer.
Four of those turn up in the wiring below; you are adding the other four.

1. From the **Modules** menu add, in this order: **Modulation → Envelope**,
   **Voice → VCA**, **Voice → Noise**, **Voice → Oscillator**. They arrive as
   `env1`, `vca1`, `noise1` and `osc2`.
   Each one lands at the top of the rack, so they end up stacked in the
   reverse of the order you added them — which changes nothing, because what
   a patch does is decided by its cables and not by the order of its units.
2. Press **Tab** and patch:
   - **gate1 · Gate → env1 · Gate**  *(an output feeds as many inputs as you
     like, so the Trigger's stock cable into `osc1 · Gate` stays where it is)*
   - **env1 · Out → lpf1 · CV**
   - **lpf1 · Out → vca1 · In**
   - **env1 · Out → vca1 · CV**
   - **vca1 · Out → mix1 · 1**
3. Press **Tab** back to the front and set **osc1 · Env Amt** to **0.00**.

Two of those cables land in occupied inputs and push the stock cables out,
which is the point: the envelope takes the filter over from the oscillator,
and the VCA takes over the feed to the mixer.

Step 3 hands the oscillator's envelope duties to `env1`. Left at full, the
oscillator would shape the sound a second time underneath whatever the
tutorial is setting.

**Nothing here renders to a file yet.** Add a **Recorder** whenever you want
that; the rack sounds exactly the same with or without one.

### Tutorial 1 — Laser

**What you will learn:** using an envelope to move pitch, inverting a signal
with the CV Utility, and adding two control signals together so a keyboard
can play the result.

The tutorial rack already has an envelope opening a filter and a VCA. All this
needs is for that same envelope to also drag the pitch down.

1. Start from the tutorial rack.
2. Press **Tab** to see the back.
3. Drag a cable from **env1 · Out** to **osc1 · FM**.
4. Press **Tab** to come back to the front, and set:

| Module | Knob | Value |
| --- | --- | --- |
| osc1 | Pitch | 220 Hz |
| osc1 | Wave | saw |
| osc1 | FM Amt | **+3.00** |
| env1 | Attack | 1 ms |
| env1 | Decay | 180 ms |
| env1 | Sustain | 0.00 |
| env1 | Release | 50 ms |
| lpf1 | Cutoff | 12.00 kHz |
| lpf1 | Res | 0.20 |
| lpf1 | CV Amt | +0.00 |

Tap **Space**.

The envelope jumps to 1 and falls to 0. FM Amt turns that into "three octaves
up, falling to the Pitch knob" — a descending *pew*. The filter is set wide
open and its CV turned off so it stays out of the way.

**Try:** Decay controls how fast it falls. FM Amt controls how far. Sine wave
gives a cleaner sci-fi zap; pulse gives a harsher one.

#### Make it rise instead

A rising sweep needs the envelope upside down, which is what the CV Utility
is for.

1. **Modules → Modulation → CV Utility**.
2. On the back, right-click **osc1 · FM** to clear it.
3. Patch **env1 · Out → cv1 · 1**, and **cv1 · Out 1 → osc1 · FM**.
4. On cv1, set **Gain 1** to **−1.00** and **Off 1** to **1.00**.

The envelope's 1 → 0 becomes 0 → 1, so the pitch now climbs. Same envelope,
same oscillator, opposite sweep — this is the trick worth remembering.

#### Play it from the keyboard

Every shot so far has been the same shot. To fire one at a pitch you choose,
the keyboard has to reach **osc1 · FM** — but so does the envelope, and an
input takes one cable. So add the two together before they get there.

Start again from the plain laser above, then:

1. **Modules → Control → Keyboard**, then **Modules → Modulation → CV Utility**.
2. On the back, patch:
   - **key1 · Gate → env1 · Gate**  *(now a key fires the shot; this replaces the Trigger's cable)*
   - **env1 · Out → cv1 · 1**
   - **key1 · Pitch → cv1 · 2**
   - **cv1 · Sum → osc1 · FM**  *(and this replaces the envelope's own cable)*
3. On the front, change three knobs:

| Module | Knob | Value |
| --- | --- | --- |
| osc1 | FM Amt | **+1.00** |
| cv1 | Gain 1 | **2.00** |
| cv1 | Gain 2 | 1.00 |

Click a key.

**FM Amt has to come down to +1.00**, because that is what makes the keyboard
play in tune — one octave up the keys is one octave up the shot. The sweep
gets its depth back from **cv1 · Gain 1** instead: the envelope is doubled on
the way in, so every shot still starts two octaves above the note you played
and falls onto it.

**Sum is what makes this possible.** Each of the CV Utility's two channels has
its own Gain, and Sum adds them together, so a single cable carries the note
you are holding *and* the sweep sitting on top of it. Anywhere you want two
modulations in one input, this is the move.

**A Trigger fires it too**, at whichever key you pressed last — patch
`gate1 · Gate` to `key1 · Gate` and Space plays the note you chose. So does a
render, which is how you get a batch of laser shots that are all the same
note.

**Try:** `osc1` **Pitch** now sets what the *bottom* key plays. Gain 1 is the
length of the sweep; at 0.00 the keyboard plays plain tones, and negative
turns each shot into a rising one.

---

### Tutorial 2 — Footstep

**What you will learn:** noise as a sound source, and why one cable per input
is convenient.

1. Start from the tutorial rack.
2. On the back, drag **noise1 · Out** to **lpf1 · In**.

   Notice the oscillator's cable pops out by itself. One cable per input —
   you have swapped the sound source in a single drag, and everything
   downstream is untouched.

3. On the front:

| Module | Knob | Value |
| --- | --- | --- |
| noise1 | Color | **pink** |
| noise1 | Level | 1.00 |
| env1 | Attack | 1 ms |
| env1 | Decay | 70 ms |
| env1 | Sustain | 0.00 |
| env1 | Release | 40 ms |
| lpf1 | Cutoff | 300 Hz |
| lpf1 | Res | 0.25 |
| lpf1 | Drive | 2.00x |
| lpf1 | CV Amt | **+2.50** |

4. Tap **Space** — a soft thump on a wooden floor.

The envelope is doing two jobs at once, and this is the core trick of the
whole app: it opens the **VCA** so you hear a short burst, and it sweeps the
**filter** so the burst starts bright and darkens as it fades. Take the cable
out of `lpf1 · CV` and it immediately sounds like a flat click instead of a
footstep.

**Try:** Cutoff sets the surface. 300 Hz is wood; 1.20 kHz is gravel; 4.00 kHz
with white noise is a footstep in dry leaves. Decay sets the size of the boot.

**Then render a set:** on the Recorder panel set Takes 8, Length 0.5, Gate 0.01
and Spread 0.08, then hit **Render**. Eight footsteps that belong to the same
pair of boots.

---

### Tutorial 3 — Computer chatter

**What you will learn:** the Sample & Hold as a free-running source, scaling
CV, and the Oscillator's built-in envelope.

The Sample & Hold runs on its own here, with no clock and no trigger --
but you still play it, by holding **Space**.

1. Start from the tutorial rack.
2. **Modules → Modulation → Sample & Hold**, then **Modules → Modulation → CV Utility**.
3. On the back, patch:
   - **sh1 · Out 1 → cv1 · 1**
   - **cv1 · Out 1 → osc1 · FM**
   - **sh1 · Clk 1 → osc1 · Gate**
4. On the front:

| Module | Knob | Value |
| --- | --- | --- |
| sh1 | Rate 1 | 9.00 Hz |
| cv1 | Gain 1 | 0.50 |
| osc1 | Pitch | 700 Hz |
| osc1 | Wave | pulse |
| osc1 | FM Amt | +2.00 |
| osc1 | **Env Amt** | **1.00** |
| osc1 | Attack | 2 ms |
| osc1 | Decay | 30 ms |
| osc1 | Sustain | 0.00 |
| osc1 | Release | 10 ms |
| lpf1 | Cutoff | 12.00 kHz |
| lpf1 | CV Amt | +0.00 |
| vca1 | Level | 0.00 |
| env1 | Attack | 5 ms |
| env1 | Decay | 10 ms |
| env1 | **Sustain** | **1.00** |
| env1 | Release | 40 ms |

Hold **Space** and it chatters.

Three things are happening. The Sample & Hold picks a new random number nine
times a second, using its own built-in noise because nothing is plugged into
its In. Its clock fires the oscillator's own envelope, so each tick is a short
blip. And the random value goes through the CV Utility to the pitch, so every
blip is a different note.

**env1 is a gate follower here, not a shape.** Sustain at 1.00 means it goes
up when you press and stays up until you let go, so the envelope is doing
nothing but passing the key through to the VCA. That is what makes this a
patch you play rather than one that shouts the moment it is loaded -- the
Sample & Hold underneath it is still free-running either way.

Turn **vca1 · Level** up to 1.00 if you do want it running on its own, with
nothing held at all. Every patch in this manual is built the other way --
silent until you play it — because a rack that makes a noise the moment it is
loaded is a rack you cannot think next to.

**cv1 · Gain 1 is the tuning control.** The Sample & Hold swings the full −1
to +1; at 0.50 with FM Amt at +2.00 the notes land within about an octave
either side of 700 Hz. Turn Gain 1 up for wilder leaps, down for a tighter
mutter.

**Try:** Rate is the talking speed. Decay decides between clipped data bursts
and a warbling robot.

#### Make it sing

1. **Modules → Modulation → Slew**.
2. Right-click **cv1 · 1** to clear it.
3. Patch **sh1 · Out 1 → slew1 · In** and **slew1 · Out → cv1 · 1**.
4. Set slew1 **Rise** 80 ms, **Fall** 80 ms, **Shape** exp.
5. Set osc1 **Env Amt** to **0.00** and **Wave** to **sine**.

The pitch now glides between the random values instead of jumping, and with
the envelope out of the way it becomes one continuous voice. Same three
modules; completely different creature.

---

### Tutorial 4 — Wind

**What you will learn:** building a sound that never stops, and using Slew to
turn random steps into slow drift.

1. Start from the tutorial rack.
2. **Modules → Modulation → Sample & Hold**, then **Modules → Modulation → Slew**.
3. On the back, patch:
   - **noise1 · Out → lpf1 · In**
   - **sh1 · Out 1 → slew1 · In**
   - **slew1 · Out → lpf1 · CV**  *(this replaces the envelope's cable)*
4. On the front:

| Module | Knob | Value |
| --- | --- | --- |
| noise1 | Color | **pink** |
| noise1 | Level | 1.00 |
| sh1 | Rate 1 | 1.50 Hz |
| slew1 | Rise | 500 ms |
| slew1 | Fall | 500 ms |
| slew1 | Shape | exp |
| lpf1 | Cutoff | 700 Hz |
| lpf1 | Res | 0.55 |
| lpf1 | Drive | 1.00x |
| lpf1 | CV Amt | +1.50 |
| vca1 | Level | 0.00 |
| env1 | Attack | 5 ms |
| env1 | Decay | 10 ms |
| env1 | **Sustain** | **1.00** |
| env1 | Release | 40 ms |

Hold **Space** and it blows, for as long as you hold it.

The Sample & Hold picks a new random value every two-thirds of a second, which
on its own would make the filter jump in ugly steps. The Slew smooths each
jump over half a second, and the result is a filter that drifts the way real
wind does. **Res at 0.55** adds the whistle of wind round an edge.

**Try:** sh1 Rate is how gusty it is. lpf1 CV Amt is how much the gusts
change the tone. Res near 0.80 becomes a howl through a gap; Cutoff down at
200 Hz becomes distant wind heard from indoors.

**Watch it work:** add a **Scope**, patch **slew1 · Out** to its In, and set
Gain to about 4.00x. You will see the rounded random drift that is doing the
work. Then move the cable to **sh1 · Out 1** to see the raw steps before the
Slew gets to them.

---

### Tutorial 5 — Explosion

**What you will learn:** layering two sounds through the Mixer, and letting
the Oscillator shape itself.

Real impacts are never one sound. This is a low thump and a body of noise,
mixed.

1. Start from the tutorial rack. You will not need any new modules.
2. On the back, patch:
   - **noise1 · Out → lpf1 · In**  *(the noise layer)*
   - **gate1 · Gate → osc1 · Gate**  *(the low layer gets its own trigger)*
   - **osc1 · Env → osc1 · FM**  *(its envelope drags its own pitch down)*
   - **osc1 · Out → mix1 · 2**
3. On the front:

| Module | Knob | Value |
| --- | --- | --- |
| noise1 | Color | pink |
| noise1 | Level | 1.00 |
| env1 | Attack | 2 ms |
| env1 | Decay | **1.20 s** |
| env1 | Sustain | 0.00 |
| env1 | Release | 400 ms |
| lpf1 | Cutoff | 180 Hz |
| lpf1 | Res | 0.30 |
| lpf1 | Drive | 3.00x |
| lpf1 | CV Amt | **+3.00** |
| osc1 | Pitch | 70 Hz |
| osc1 | Wave | **sine** |
| osc1 | FM Amt | +1.50 |
| osc1 | **Env Amt** | **1.00** |
| osc1 | Attack | 4 ms |
| osc1 | Decay | 700 ms |
| osc1 | Sustain | 0.00 |
| osc1 | Release | 300 ms |
| mix1 | Lvl 1 | 0.80 |
| mix1 | Lvl 2 | 0.70 |

4. Hold **Space** for a moment.

Two layers arrive at the Mixer. **Channel 1** is pink noise through a filter
that opens wide at the start and closes over a second — the blast and its
rumble. **Channel 2** is a low sine whose own envelope both fades it out *and*
pulls its pitch down, because its Env output is patched to its own FM input.
That falling pitch is what a chest hears as weight.

**Listen to the layers one at a time.** Set `mix1 · Lvl 2` to 0.00 and you have
a rush of air with no punch. Set it back and mute `Lvl 1` and you have a punch
with no blast. Neither is an explosion; together they are.

**Try:** osc1 Pitch decides the size — 40 Hz is a building, 120 Hz is a barrel.
env1 Decay is how long the debris takes to settle. Then render eight takes with
Length 4 and Spread 0.10.

---

### Tutorial 6 — Siren

**What you will learn:** the LFO, and building a sound that runs on its own
with no trigger at all.

Everything so far has been fired by the gate. A siren is the other kind of
sound: it starts, and then it is simply *on*.

1. Start from the tutorial rack. You will not need any new modules.
2. Press **Tab** and patch **lfo1 · Out → osc1 · FM**.
3. Press **Tab** back and set:

| Module | Knob | Value |
| --- | --- | --- |
| osc1 | Pitch | 440 Hz |
| osc1 | Wave | saw |
| osc1 | FM Amt | **+0.60** |
| lfo1 | Rate | 0.70 Hz |
| lfo1 | Shape | tri |
| lfo1 | Depth | 1.00 |
| lpf1 | Cutoff | 6.00 kHz |
| lpf1 | Res | 0.20 |
| lpf1 | CV Amt | +0.00 |
| vca1 | Level | 0.00 |
| env1 | Attack | 5 ms |
| env1 | Decay | 10 ms |
| env1 | **Sustain** | **1.00** |
| env1 | Release | 40 ms |

Hold **Space** and it wails.

**env1 is a gate follower**, as it is in the wind: Sustain at 1.00 means it
goes up when you press and stays up until you let go, so what you hear runs
for exactly as long as the key is down. And the **LFO**
is an oscillator too slow to hear, so instead of a tone it is a shape: a
triangle at 0.7 Hz, swinging the pitch two-thirds of an octave either side of
440 Hz, forever. Out swings negative as well as positive, which is why the
siren goes below the Pitch knob as well as above it.

**Try:** Shape is the character of the siren. **tri** is the classic wail;
**saw** is a rising warble that snaps back; **pulse** is the two-tone European
kind, because the pitch only ever sits at one of two values. Depth is how far
it swings, Rate is how fast.

**FM Amt sets the range and the LFO sets the shape.** That split is worth
holding onto: nearly every modulation in the rack works this way, with the
amount knob on the *destination* and the movement coming from the source.

---

### Tutorial 7 — Water drop

**What you will learn:** resonance as a sound source of its own, and turning
a gate into a rising envelope with Slew.

A filter turned up near self-oscillation stops being a filter and starts
being a voice. Sweep it upward and you get the hollow *bloop* of a drip in a
cave.

1. Start from the tutorial rack.
2. **Modules → Modulation → Slew**.
3. On the back, patch:
   - **noise1 · Out → lpf1 · In**  *(this replaces the oscillator's cable)*
   - **gate1 · Gate → slew1 · In**
   - **slew1 · Out → lpf1 · CV**  *(and this replaces the envelope's)*
4. On the front:

| Module | Knob | Value |
| --- | --- | --- |
| noise1 | Level | 1.00 |
| slew1 | Rise | 250 ms |
| slew1 | Fall | 20 ms |
| slew1 | Shape | exp |
| lpf1 | Cutoff | 260 Hz |
| lpf1 | Res | **0.97** |
| lpf1 | Drive | 1.50x |
| lpf1 | CV Amt | +2.50 |
| env1 | Attack | 4 ms |
| env1 | Decay | 300 ms |
| env1 | Sustain | 0.00 |
| env1 | Release | 80 ms |

Hold **Space** for about a third of a second.

**Res at 0.97** is the whole sound. That close to self-oscillation the filter
rings at its cutoff frequency, so the noise is not really being filtered any
more — it is being used to hit a bell.

The **Slew** is what makes the bell rise. A gate is a square: 0, then 1, then
0 again. Slew cannot follow a square, so 1 becomes a 250 ms climb, and that
climb goes to the filter's CV. Because the Rise is longer than the sound
lasts, the pitch is still going up when the envelope has already faded it
out, which is exactly the shape a drip has.

**Try:** Rise is how fast the drop rises — 80 ms is a plink, 500 ms is a
bubble surfacing. Cutoff is the pitch it starts from. Hold Space longer and
the rise goes further.

**Watch it work:** put a **Scope** on **slew1 · Out** and hold Space. You will
see the square gate arriving as a curve.

---

### Tutorial 8 — Engine

**What you will learn:** pulse width modulation, and thickening a sound by
detuning two oscillators against each other.

1. Start from the tutorial rack.
2. On the back, patch:
   - **lfo1 · Out → osc1 · PWM**
   - **osc2 · Out → mix1 · 2**
3. On the front:

| Module | Knob | Value |
| --- | --- | --- |
| osc1 | Pitch | 55 Hz |
| osc1 | Wave | **pulse** |
| osc1 | Width | 0.50 |
| osc2 | Pitch | **56 Hz** |
| osc2 | Wave | saw |
| lfo1 | Rate | 7.00 Hz |
| lfo1 | Shape | sine |
| lfo1 | Depth | 0.80 |
| lpf1 | Cutoff | 420 Hz |
| lpf1 | Res | 0.40 |
| lpf1 | Drive | 2.50x |
| lpf1 | CV Amt | +0.00 |
| vca1 | Level | 0.00 |
| env1 | Attack | 5 ms |
| env1 | Decay | 10 ms |
| env1 | **Sustain** | **1.00** |
| env1 | Release | 40 ms |
| mix1 | Lvl 1 | 0.80 |
| mix1 | Lvl 2 | **0.35** |

Hold **Space** and it idles, like the siren.

**Width is what a pulse wave has instead of a tone control.** At 0.50 it is a
square and hollow; pushed towards either end it thins out and turns nasal.
Sweeping it with an LFO — pulse width modulation — is why one oscillator can
sound like several, and at 7 Hz it is the putt-putt of an idling motor.

**osc2 is one hertz away from osc1**, which is the other half of the trick.
Two oscillators that close drift in and out of phase with each other once a
second, and that slow heave is what stops the sound being a dead electronic
buzz. It goes to its own mixer channel rather than through the filter, so it
stays as a raw, bright layer underneath.

**Try:** LFO Rate is the engine speed — 2 Hz is a tractor, 20 Hz is a chainsaw.
Pull osc2 further from osc1 and the drift speeds up; put them at exactly the
same pitch and the drift stops altogether. Drive on the filter is how worn
the engine is.

---

### Tutorial 9 — Power-up

**What you will learn:** feeding the Sample & Hold a real signal instead of
its own noise, and using its clock to fire something else.

Every use of the Sample & Hold so far has left its In jack empty, so it has
been sampling its own noise and handing back random values. Give it something
to look at and it becomes a very different module: it turns a smooth signal
into steps.

1. Start from the tutorial rack.
2. **Modules → Modulation → Sample & Hold**.
3. On the back, patch:
   - **lfo1 · Out → sh1 · In 1**
   - **sh1 · Out 1 → osc1 · FM**
   - **sh1 · Clk 1 → osc1 · Gate**
4. On the front:

| Module | Knob | Value |
| --- | --- | --- |
| lfo1 | Rate | 0.50 Hz |
| lfo1 | Shape | **saw** |
| lfo1 | Depth | 1.00 |
| sh1 | Rate 1 | 12 Hz |
| osc1 | Pitch | 440 Hz |
| osc1 | Wave | pulse |
| osc1 | Width | 0.35 |
| osc1 | FM Amt | +1.50 |
| osc1 | **Env Amt** | **1.00** |
| osc1 | Attack | 2 ms |
| osc1 | Decay | 50 ms |
| osc1 | Sustain | 0.00 |
| osc1 | Release | 20 ms |
| lpf1 | Cutoff | 9.00 kHz |
| lpf1 | CV Amt | +0.00 |
| vca1 | Level | 0.00 |
| env1 | Attack | 5 ms |
| env1 | Decay | 10 ms |
| env1 | **Sustain** | **1.00** |
| env1 | Release | 40 ms |

Hold **Space** and it climbs. Let go and it stops.

The **LFO is a saw**, so it ramps steadily from bottom to top and snaps back.
The Sample & Hold looks at that ramp twelve times a second and holds each
reading, so the smooth ramp arrives at the oscillator as a staircase — a
rising run of notes rather than a slide.

**sh1 · Clk 1 is firing the oscillator.** Its clock is a square at the same
12 Hz, so every new step also strikes a new note. This is the one steady clock
the rack has, and it is worth remembering: anything with a Gate input can be
driven from it.

**Try:** sh1 Rate is how many notes are in the run. lfo1 Rate is how long the
run takes — slower is a longer climb. FM Amt is how far it climbs. Set the LFO
Shape to **tri** and it climbs and comes back down.

---

### Tutorial 10 — Sync zap

**What you will learn:** hard sync, which is the one thing in this rack that
sounds like nothing else.

1. Start from the tutorial rack. You will not need any new modules.
2. On the back, patch:
   - **osc1 · Out → osc2 · Sync**
   - **osc2 · Out → lpf1 · In**  *(this replaces osc1's cable)*
   - **env1 · Out → osc2 · FM**
3. On the front:

| Module | Knob | Value |
| --- | --- | --- |
| osc1 | Pitch | 165 Hz |
| osc1 | Wave | saw |
| osc2 | Pitch | 165 Hz |
| osc2 | Wave | saw |
| osc2 | FM Amt | **+3.00** |
| env1 | Attack | 2 ms |
| env1 | Decay | 500 ms |
| env1 | Sustain | 0.00 |
| env1 | Release | 120 ms |
| lpf1 | Cutoff | 14.00 kHz |
| lpf1 | Res | 0.15 |
| lpf1 | CV Amt | +0.00 |

Tap **Space**.

**Sync means "start your wave over, now".** Every time osc1 begins a new
cycle it forces osc2 back to the start of its own, whatever osc2 was in the
middle of. So osc2 can only ever repeat at osc1's rate — you hear 165 Hz no
matter what osc2's pitch knob says.

What osc2's pitch *does* change is the shape inside each of those cycles.
Sweep it with an envelope, as **FM Amt +3.00** does here, and the pitch stays
nailed to 165 Hz while the timbre tears its way down three octaves. That
scream is hard sync, and it is worth knowing that nothing else in the rack
can make it.

**Try:** osc2's Pitch knob is the whole instrument here — move it and listen
to the pitch *not* change. Take the sync cable out and the same patch becomes
an ordinary falling sweep, which is a good way to hear what sync is adding.
FM Amt decides how far it tears.

---

### Tutorial 11 — Ricochet

**What you will learn:** the Burst generator, the Resonator, and how the Ramp
output makes a run of hits into something physical.

A ricochet is one sound played several times, crowding together and dropping
in pitch as it goes. That is three knobs on the Burst and one cable.

#### Patch

1. Start from the [tutorial rack](#build-the-tutorial-rack).
2. **Modules → Control → Burst**, then **Modules → Effects → Resonator**.
3. On the back, patch six cables:

- `noise1 · Out` → `lpf1 · In`
- `gate1 · Gate` → `brst1 · Trig` — *the key fires the run*
- `brst1 · Gate` → `env1 · Gate` — *replaces the Trigger's cable into the envelope*
- `vca1 · Out` → `res1 · In`
- `brst1 · Ramp` → `res1 · CV`
- `res1 · Out` → `mix1 · 1` — *replaces the VCA's cable*

#### Set

| Module | Knob | Value |
| --- | --- | --- |
| brst1 | Count | 6 |
| brst1 | Rate | 11 Hz |
| brst1 | Curve | -0.50 |
| brst1 | Jitter | 0.30 |
| brst1 | Width | 0.05 |
| env1 | Attack | 1 ms |
| env1 | Decay | 20 ms |
| env1 | Sustain | 0.00 |
| env1 | Release | 10 ms |
| lpf1 | Cutoff | 1.20 kHz |
| lpf1 | CV Amt | +0.00 |
| res1 | Pitch | 1.40 kHz |
| res1 | CV Amt | -2.00 |
| res1 | Decay | 250 ms |
| res1 | Damp | 0.30 |

Tap **Space**.

Six pings, crowding together as they go, each one lower than the last.

**The Burst is doing the rhythm.** One trigger in, six out — and **Curve** at
−0.50 packs them tighter as the run proceeds, which is what a bouncing object
does. **Jitter** takes the last of the regularity out so it does not sound
like a machine.

**The Resonator is doing the sound.** The filtered noise burst is only a dull
click; what you actually hear is the Resonator ringing at 1.40 kHz after each
click hits it. That is the difference between a tap and a ping.

**The Ramp cable is doing the physics.** Ramp climbs from 0 on the first pulse
to 1 on the last, and **CV Amt at −2.00** turns that climb into a pitch that
falls two octaves across the run. Pull that one cable out and every ping is
the same note — a rattle rather than something bouncing away from you.

> **Try:** Count is how far it bounces. Curve near +1.00 is a rattle coming to
> rest instead. `res1` Decay is how hard the surface is — 50 ms is wood,
> 1.00 s is a steel pipe.

---

### Tutorial 12 — Machine gun

**What you will learn:** the Burst generator as a rate-of-fire control, and
the Drive module's Bias knob.

#### Patch

1. Start from the [tutorial rack](#build-the-tutorial-rack).
2. **Modules → Control → Burst**, then **Modules → Effects → Drive**.
3. On the back, patch five cables:

- `noise1 · Out` → `lpf1 · In`
- `gate1 · Gate` → `brst1 · Trig` — *the key fires the run*
- `brst1 · Gate` → `env1 · Gate`
- `vca1 · Out` → `drv1 · In`
- `drv1 · Out` → `mix1 · 1`

#### Set

| Module | Knob | Value |
| --- | --- | --- |
| brst1 | Count | 8 |
| brst1 | Rate | 14 Hz |
| brst1 | Curve | 0.00 |
| brst1 | Jitter | 0.15 |
| brst1 | Width | 0.10 |
| noise1 | Color | white |
| env1 | Attack | 1 ms |
| env1 | Decay | 35 ms |
| env1 | Sustain | 0.00 |
| env1 | Release | 20 ms |
| lpf1 | Cutoff | 1.80 kHz |
| lpf1 | Res | 0.30 |
| lpf1 | Drive | 2.00x |
| lpf1 | CV Amt | +3.00 |
| drv1 | Drive | 20.00x |
| drv1 | Curve | clip |
| drv1 | Bias | 0.35 |
| drv1 | Level | 0.70 |

Tap **Space** — eight rounds.

**Rate is the rate of fire**, straightforwardly: 14 Hz is about 840 rounds a
minute, which is a rifle. **Curve at 0.00** keeps the spacing even, because a
gun is a machine and should sound like one — this is the one place in the rack
where you want the regularity left in.

**Bias is what makes it crack.** Turn it to 0.00 and listen: the shots go soft
and rounded. Clipping a centred wave only makes odd harmonics, and that sounds
like distortion. Sliding it off centre adds the even ones, and *that* sounds
like something breaking. It is the single most useful knob on the Drive panel
and the least obvious.

> **Try:** Count and Rate are the weapon. Jitter above 0.40 is a badly
> maintained one. Drop `lpf1` Cutoff to 600 Hz for something heavier, and
> render eight takes with Spread 0.10 so no two bursts are identical.

---

### Tutorial 13 — Alien transmission

**What you will learn:** the Ring Modulator and the Bitcrusher, and why they
belong at the end of a chain rather than the start.

This one runs on its own, with no trigger — it is the computer chatter patch
with two things done to it on the way out.

#### Patch

1. Start from the [tutorial rack](#build-the-tutorial-rack).
2. Add four modules: **Sample & Hold**, **CV Utility**, **Ring Mod**,
   **Bitcrusher**.
3. On the back, patch six cables:

- `sh1 · Out 1` → `cv1 · 1`
- `cv1 · Out 1` → `osc1 · FM`
- `sh1 · Clk 1` → `osc1 · Gate`
- `vca1 · Out` → `ring1 · In`
- `ring1 · Out` → `bits1 · In`
- `bits1 · Out` → `mix1 · 1` — *replaces the VCA's cable*

#### Set

| Module | Knob | Value |
| --- | --- | --- |
| sh1 | Rate 1 | 7.00 Hz |
| cv1 | Gain 1 | 0.50 |
| osc1 | Pitch | 600 Hz |
| osc1 | Wave | pulse |
| osc1 | FM Amt | +2.00 |
| osc1 | Env Amt | 1.00 |
| osc1 | Attack | 2 ms |
| osc1 | Decay | 40 ms |
| osc1 | Sustain | 0.00 |
| osc1 | Release | 10 ms |
| lpf1 | Cutoff | 12.00 kHz |
| lpf1 | CV Amt | +0.00 |
| vca1 | Level | 0.00 |
| env1 | Attack | 5 ms |
| env1 | Decay | 10 ms |
| env1 | **Sustain** | **1.00** |
| env1 | Release | 40 ms |
| ring1 | Freq | 180 Hz |
| ring1 | Mix | 0.80 |
| bits1 | Bits | 4 |
| bits1 | Rate | 4.50 kHz |
| bits1 | Mix | 1.00 |

Hold **Space** and it talks.

**The Ring Mod is what makes it inhuman.** Every note the oscillator plays is
replaced by two frequencies that are not in any harmonic series — the note
plus 180 Hz and the note minus 180 Hz. The result has a pitch you cannot quite
name, which is exactly why it has been the sound of robots since the 1960s.

**The Bitcrusher is what makes it a transmission.** 4 bits is coarse enough to
hear grit on every note, and a 4.50 kHz sample rate folds the high end back
down as a metallic ringing. Together they sound like equipment, not like a
voice.

**Order matters here.** Both of these are at the *end* of the chain, after the
VCA. Put the Bitcrusher before the filter and the filter smooths the damage
back out again; put it last and the damage is the last thing you hear.

> **Try:** `ring1` Freq is the character — below 60 Hz it stops being a ring
> modulator and becomes a tremolo. Set `ring1` Mix to 0.00 and back to hear
> exactly what it is adding. `bits1` Bits at 2 is barely a signal any more,
> which is right for something failing.

---

### Tutorial 14 — Arpeggio

**What you will learn:** the Clock and the Sequencer working together, and
putting a sound in a room with the stereo Space module.

#### Patch

1. Start from the [tutorial rack](#build-the-tutorial-rack).
2. Add three modules: **Clock**, **Sequencer**, **Space**.
3. On the back, patch six cables:

- `clk1 · x1` → `seq1 · Clock`
- `seq1 · CV` → `osc1 · FM`
- `seq1 · Gate` → `osc1 · Gate`
- `vca1 · Out` → `spc1 · In`
- `spc1 · L` → `mix1 · 1` — *replaces the VCA's cable*
- `spc1 · R` → `mix1 · 2`

#### Set

| Module | Knob | Value |
| --- | --- | --- |
| clk1 | Rate | 9.00 Hz |
| clk1 | Width | 0.40 |
| seq1 | Gate | 0.40 |
| seq1 | Steps | 8 |
| osc1 | Pitch | 330 Hz |
| osc1 | Wave | pulse |
| osc1 | Width | 0.40 |
| osc1 | FM Amt | +1.00 |
| osc1 | Env Amt | 1.00 |
| osc1 | Attack | 2 ms |
| osc1 | Decay | 90 ms |
| osc1 | Sustain | 0.00 |
| osc1 | Release | 40 ms |
| lpf1 | Cutoff | 9.00 kHz |
| lpf1 | CV Amt | +0.00 |
| vca1 | Level | 0.00 |
| env1 | Attack | 5 ms |
| env1 | Decay | 10 ms |
| env1 | **Sustain** | **1.00** |
| env1 | Release | 40 ms |
| spc1 | Size | 0.60 |
| spc1 | Decay | 2.00 s |
| spc1 | Mix | 0.35 |
| mix1 | Pan 1 | -1.00 |
| mix1 | Pan 2 | 1.00 |

Hold **Space** and it plays a rising and falling figure.

**You did not set the notes.** A new Sequencer arrives playing a minor seventh
arpeggio rather than a row of zeroes, so there is something to hear before you
have turned anything. The eight **CV** knobs along its panel are the pattern —
change one and that step changes.

**FM Amt at +1.00 is what puts it in tune.** The Sequencer's CV is in octaves,
like everything else in this rack, so at +1.00 one octave on the knob is one
octave of pitch. `osc1` Pitch sets what step 1 plays.

**The Clock is why this is worth two modules.** The Sequencer has a clock of
its own and would run perfectly well without one — but the moment you want a
second thing on the beat, it has to come from somewhere that both can hear.
Patch `clk1 · /4` to a **Burst** and you have a drum fill every fourth note,
still in time.

**Space is stereo**, so it takes two mixer channels panned hard apart. That is
what gives the tail width; patch only `L` and it is a perfectly good mono
reverb.

> **Try:** `clk1` Rate is the tempo. `seq1` Steps at 5 makes the pattern loop
> in five, which stops it sounding like a scale. Set a step's **Lvl** to 0.00
> and it becomes a rest, which is where the rhythm comes from.

---

### Tutorial 15 — Sci-fi door

**What you will learn:** the Wavefolder, and using an envelope on the Delay's
Time input to bend pitch the way tape does.

#### Patch

1. Start from the [tutorial rack](#build-the-tutorial-rack).
2. Add three modules: **Wavefolder**, **Delay**, **Space**.
3. On the back, patch seven cables:

- `osc1 · Out` → `fold1 · In`
- `fold1 · Out` → `lpf1 · In` — *replaces the oscillator's own cable*
- `vca1 · Out` → `dly1 · In`
- `env1 · Out` → `dly1 · Time`
- `dly1 · Out` → `spc1 · In`
- `spc1 · L` → `mix1 · 1`
- `spc1 · R` → `mix1 · 2`

#### Set

| Module | Knob | Value |
| --- | --- | --- |
| osc1 | Pitch | 140 Hz |
| osc1 | Wave | sine |
| fold1 | Fold | 7.00x |
| fold1 | Sym | 0.25 |
| env1 | Attack | 10 ms |
| env1 | Decay | 800 ms |
| env1 | Sustain | 0.00 |
| env1 | Release | 300 ms |
| lpf1 | Cutoff | 3.00 kHz |
| lpf1 | Res | 0.40 |
| lpf1 | CV Amt | +2.00 |
| dly1 | Time | 12 ms |
| dly1 | Time Amt | +1.20 |
| dly1 | Fdbk | 0.60 |
| dly1 | Damp | 0.35 |
| dly1 | Mix | 0.50 |
| spc1 | Size | 0.80 |
| spc1 | Decay | 3.00 s |
| spc1 | Mix | 0.40 |
| mix1 | Pan 1 | -1.00 |
| mix1 | Pan 2 | 1.00 |

Hold **Space** briefly.

**The Wavefolder turns the sine into metal.** A 140 Hz sine has nothing in it
but 140 Hz. Folded seven times over it has a dozen harmonics that were never
there, and none of them in a tidy series — which is what makes it read as a
sheet of metal rather than as a note. **Sym at 0.25** shifts where the folds
land, and moving it changes the metal rather than the loudness.

**The Delay is bending, not echoing.** At 12 ms the repeats are too close
together to hear as repeats — that is a comb filter, hollow and pipe-like. But
the envelope is patched to **Time**, so as it decays the read distance changes,
and everything already inside the delay line changes pitch with it. That is a
tape machine being slowed down, and it is the sound of something heavy moving.

**Space puts it in a corridor.** Size 0.80 with a 3.00 s decay is a large hard
room — not a concert hall, because the damping is low and it is too metallic
for that.

> **Try:** `fold1` Fold is how much metal there is. `dly1` Time Amt decides
> which way the door goes — **−1.20** makes it close instead of open. Put a
> **VCA** between the oscillator and the folder, with the envelope on its CV,
> and the folding sweeps as the sound decays, which is even better.

---

## 8. When you get no sound

Work down this list; it is roughly in order of likelihood.

1. **Have you clicked the page yet?** Browsers block audio until you interact.
   The small light in the header comes on once audio is running.
2. **Is a VCA closed?** `Level` starts at 0.00 and only opens when something
   reaches its CV. If nothing is triggering it, turn Level up.
3. **Is anything reaching a Mixer?** The mixer is the way out to your
   speakers, and a rack with no mixer in it cannot make a sound at all.
   Follow the cables back from `mix1 · 1`, and check its Lvl and Master.
4. **Is the filter shut?** A Cutoff down at 20 Hz removes essentially
   everything. Turn it up and see if the sound returns.
5. **Did a cable pop out?** Patching into an occupied input silently unplugs
   what was there. **Ctrl+Z** steps back through every edit.
6. **Is the envelope firing?** Patch an Envelope's Out to a Scope. If the trace
   stays flat when you press Space, its Gate input is not connected.
7. **Is Sustain doing what you expect?** With Sustain at 0.00 a long Decay has
   already faded the sound before you release the key.

When something sounds wrong rather than absent, add a **Scope** and look at it
at each stage. Almost every confusing patch becomes obvious once you can see
the signal.
