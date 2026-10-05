import type { MidiMessage } from './midi'

/**
 * Mackie Control Universal: the protocol a controller's "DAW mode" speaks.
 *
 * Unlike a mapping, nothing here is learnt: Mackie Control fixed what every
 * control means long ago, which is why a DAW can map a whole surface at once
 * -- and why one implementation serves every controller that speaks it.
 * Eight channel strips, each with a fader (pitch bend on its own channel), a
 * knob (a "V-pot", an endless knob on CC 16..23) and buttons (notes at fixed
 * numbers), and a row of transport and navigation buttons. The DAW answers
 * with the same messages to light the buttons, place the faders -- or, on a
 * surface without motors, light the LED that says a fader is not where its
 * track is -- and light the rings round the knobs.
 *
 * Only the parts a surface without displays uses: no scribble strips, which
 * would need system exclusive messages and a second permission from the
 * browser.
 */

export type McuButton =
  | 'rec' | 'solo' | 'mute' | 'select' | 'vpot'
  | 'bankLeft' | 'bankRight' | 'channelLeft' | 'channelRight'
  | 'rewind' | 'forward' | 'stop' | 'play' | 'record' | 'cycle'
  | 'up' | 'down' | 'left' | 'right'
  | 'touch'

export type McuEvent =
  | { kind: 'fader'; strip: number; position: number }
  | { kind: 'master'; position: number }
  | { kind: 'vpot'; strip: number; steps: number }
  | { kind: 'button'; button: McuButton; strip: number; down: boolean }

/** The strip buttons, eight of each from these notes. */
const STRIP_BUTTONS: [number, McuButton][] = [
  [0, 'rec'],
  [8, 'solo'],
  [16, 'mute'],
  [24, 'select'],
  [32, 'vpot'],
  [104, 'touch'],
]

/** The rest, one note each. */
const BUTTONS: Record<number, McuButton> = {
  46: 'bankLeft', 47: 'bankRight', 48: 'channelLeft', 49: 'channelRight',
  86: 'cycle', 91: 'rewind', 92: 'forward', 93: 'stop', 94: 'play', 95: 'record',
  96: 'up', 97: 'down', 98: 'left', 99: 'right',
}

/** The note a button lights by, on a strip. */
export function mcuNote(button: McuButton, strip = 0): number | null {
  const s = STRIP_BUTTONS.find(([, b]) => b === button)
  if (s) return s[0] + strip
  const n = Object.entries(BUTTONS).find(([, b]) => b === button)
  return n ? Number(n[0]) : null
}

/** What a message from a Mackie Control surface means, or null for one it does not send. */
export function readMcu(m: MidiMessage): McuEvent | null {
  if (m.kind === 'bend') {
    const position = (m.fine ?? m.value << 7) / 16383
    if (m.channel >= 1 && m.channel <= 8) return { kind: 'fader', strip: m.channel - 1, position }
    if (m.channel === 9) return { kind: 'master', position }
    return null
  }
  if (m.kind === 'cc') {
    // A V-pot turns in sign and magnitude: bit 6 says which way.
    if (m.number >= 16 && m.number <= 23 && m.value) {
      return { kind: 'vpot', strip: m.number - 16, steps: m.value & 0x40 ? -(m.value & 0x3f) : m.value & 0x3f }
    }
    return null
  }
  const down = m.kind === 'noteOn'
  for (const [base, button] of STRIP_BUTTONS) {
    if (m.number >= base && m.number < base + 8) return { kind: 'button', button, strip: m.number - base, down }
  }
  const button = BUTTONS[m.number]
  return button ? { kind: 'button', button, strip: 0, down } : null
}

/** How a surface should look: what is lit, where each fader belongs, where each knob's ring points. */
export interface McuView {
  /** By note: lit or not. */
  lit: Record<number, boolean>
  /** Each strip's fader, 0..1. */
  faders: number[]
  /** Each strip's knob, 0..1, or null for a ring with nothing to show. */
  rings: (number | null)[]
}

/** What was last sent, to send only what changes. */
export interface McuSent {
  lit: Map<number, boolean>
  faders: Map<number, number>
  rings: Map<number, number>
}

export const nothingSent = (): McuSent => ({ lit: new Map(), faders: new Map(), rings: new Map() })

/**
 * The messages that bring a surface from what it was last sent to `view`,
 * with `sent` brought up to date. Everything, the first time.
 */
export function mcuFeedback(view: McuView, sent: McuSent): number[][] {
  const out: number[][] = []
  for (const [key, on] of Object.entries(view.lit)) {
    const note = Number(key)
    if (sent.lit.get(note) === on) continue
    sent.lit.set(note, on)
    out.push([0x90, note, on ? 0x7f : 0])
  }
  view.faders.forEach((position, strip) => {
    const v = Math.round(Math.min(1, Math.max(0, position)) * 16383)
    if (sent.faders.get(strip) === v) return
    sent.faders.set(strip, v)
    out.push([0xe0 | strip, v & 0x7f, (v >> 7) & 0x7f])
  })
  view.rings.forEach((position, strip) => {
    // Boost/cut, the mode a pan is shown in: the centre lit, and the lights
    // out to one side or the other. Eleven positions; 0 is all off.
    const v = position === null ? 0 : 0x10 | (1 + Math.round(Math.min(1, Math.max(0, position)) * 10))
    if (sent.rings.get(strip) === v) return
    sent.rings.set(strip, v)
    out.push([0xb0, 0x30 + strip, v])
  })
  return out
}
