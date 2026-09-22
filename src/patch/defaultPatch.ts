import type { Patch } from './types'

/**
 * The starting rack: five modules and four cables, which is the least that is
 * still a synthesiser you can play.
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
export function defaultPatch(): Patch {
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
  return {
    id: `${fromModule}.${fromPort}->${toModule}.${toPort}`,
    from: { module: fromModule, port: fromPort },
    to: { module: toModule, port: toPort },
  }
}
