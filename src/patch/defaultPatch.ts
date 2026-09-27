import { cableId } from './edit'
import type { Patch } from './types'

/**
 * The starting rack: a voice the piano roll can play in tune.
 *
 * The Keyboard is what makes it an instrument rather than a sound effect. A
 * track finds it and hands it every note, and its three outputs each have a
 * job: Pitch into the oscillator's FM at +1.00, so one octave in the roll is
 * one octave out of the speaker; Gate into the oscillator's own envelope; and
 * Vel into the VCA, so a softer note in the roll is a quieter one. With the
 * VCA's Level at zero, velocity is the whole of its gain.
 *
 * No Trigger. The Keyboard's own keys play it, and so does the roll; a
 * Trigger patched into its Gate jack is what puts it on the computer
 * keyboard, and adding one is a single cable for anybody who wants that.
 *
 * The filter comes after the VCA and is set to highpass, as the rack it was
 * copied from had it.
 */
export function defaultPatch(): Patch {
  return {
    modules: [
      // Six voices, so the roll can play chords on a new track from the
      // start; one would make it a single line, as the rack once was.
      { id: 'key1', type: 'keys', params: { voices: 6 } },
      { id: 'osc1', type: 'osc', params: { fmAmount: 1, envAmount: 1 } },
      { id: 'vca1', type: 'vca', params: {} },
      { id: 'lpf1', type: 'ladder', params: { mode: 3 } },
      // Rack order is patch order, and the console belongs at the bottom.
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [
      cable('key1', 'gate', 'osc1', 'gate'),
      cable('key1', 'pitch', 'osc1', 'fm'),
      cable('osc1', 'out', 'vca1', 'in'),
      cable('key1', 'vel', 'vca1', 'cv'),
      cable('vca1', 'out', 'lpf1', 'in'),
      cable('lpf1', 'out', 'mix1', 'in1'),
    ],
  }
}

/**
 * The Trigger voice: five modules and four cables, which is the least that is
 * still a synthesiser you can play. It was the starting rack until tracks
 * came along, and it is still the rack every tutorial is built on -- see
 * `tutorialRack` in the library.
 *
 * The Trigger at the top is what the keyboard reaches. It holds the only key
 * binding in the rack -- Space, because that is the key a first press lands on
 * -- and its Gate jack is patched to the oscillator, so the instrument sounds
 * from the keyboard the moment the page opens. Rebind it, or add a second
 * Trigger on another key for a second sound; nothing else in the rack listens
 * to the keyboard on its own.
 *
 * The oscillator carries its own envelope, so the voice needs no separate
 * envelope, gate or VCA to be a plucked note rather than a drone -- and its
 * Env jack opens the filter on the way, which is the one cable that turns a
 * pluck into something with a shape. The LFO is unpatched, waiting on the
 * back panel: it is the thing you reach for first, and where you put it is
 * the first decision worth making.
 *
 * Deliberately no recorder. The mixer drives the speakers on its own, so this
 * rack makes a sound out of the box; add a Recorder when you want files.
 */
export function triggerPatch(): Patch {
  return {
    modules: [
      { id: 'gate1', type: 'gate', params: {}, key: 'Space' },
      // Env Amt at full, or the oscillator ignores its own envelope and the
      // rack drones from the moment the audio starts.
      { id: 'osc1', type: 'osc', params: { envAmount: 1 } },
      { id: 'lpf1', type: 'ladder', params: {} },
      { id: 'lfo1', type: 'lfo', params: {} },
      // Rack order is patch order, and the console belongs at the bottom.
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [
      cable('gate1', 'gate', 'osc1', 'gate'),
      cable('osc1', 'out', 'lpf1', 'in'),
      cable('osc1', 'env', 'lpf1', 'cv'),
      cable('lpf1', 'out', 'mix1', 'in1'),
    ],
  }
}

function cable(fromModule: string, fromPort: string, toModule: string, toPort: string) {
  const from = { module: fromModule, port: fromPort }
  const to = { module: toModule, port: toPort }
  return { id: cableId(from, to), from, to }
}
