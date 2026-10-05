import { positionOf, type MidiMessage } from './midi'

/**
 * A controller's knobs, sliders and buttons, mapped onto the app's own.
 *
 * Nothing here knows any controller by name. A mapping is learnt from what a
 * control sends -- which input, which channel, a control change or a note,
 * which number -- and what kind of control it is is worked out from how its
 * values move while it is being learnt. That is what lets any controller
 * work without a profile for it, and it keeps all of this free of the
 * browser, so it can be checked headless.
 */

/** One physical control, as a message identifies it. */
export interface MidiControl {
  /** The input's name, or '' for any input. */
  device: string
  /** 1..16. */
  channel: number
  /** A bend is a Mackie Control fader: one to a channel, so its number is always 0. */
  type: 'cc' | 'note' | 'bend'
  number: number
}

/**
 * How an endless knob says which way it turned. Every maker picked one of
 * three: two's complement (1 up, 127 down), binary offset (65 up, 63 down)
 * and sign and magnitude (1 up, 65 down).
 */
export type Encoding = 'twos' | 'offset' | 'signed'

/**
 * What a button does to something with two states. `toggle`: each press
 * switches it, for a button that sends on when pressed and off when let go.
 * `follow`: on while the button says on, for a button the controller itself
 * latches -- one press sends on, the next sends off.
 */
export type ButtonMode = 'toggle' | 'follow'

export interface MidiMapping {
  control: MidiControl
  /**
   * `absolute`: a knob or slider with ends, whose position is the value.
   * `relative`: an endless knob, whose turns nudge the value.
   * `button`: on and off.
   */
  kind: 'absolute' | 'relative' | 'button'
  /** For `relative` only. */
  encoding?: Encoding
  /** For `button` only. */
  button?: ButtonMode
  /** What it moves: see `midiTargets`. */
  target: string
}

export const ENCODINGS: readonly Encoding[] = ['twos', 'offset', 'signed']
export const BUTTON_MODES: readonly ButtonMode[] = ['toggle', 'follow']

const typeOf = (m: MidiMessage): MidiControl['type'] => (m.kind === 'cc' ? 'cc' : m.kind === 'bend' ? 'bend' : 'note')

export function controlOf(m: MidiMessage): MidiControl {
  return { device: m.device, channel: m.channel, type: typeOf(m), number: m.number }
}

/** Whether a mapping's control is the one this message came from. A mapping for any input takes them all. */
export function matches(c: MidiControl, m: MidiMessage): boolean {
  return (
    (c.device === '' || c.device === m.device) &&
    c.channel === m.channel &&
    c.number === m.number &&
    c.type === typeOf(m)
  )
}

export function sameControl(a: MidiControl, b: MidiControl): boolean {
  return a.device === b.device && a.channel === b.channel && a.type === b.type && a.number === b.number
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** A control as a person would look for it: "CC 21 · ch 1", "Note C4 (60) · ch 10". */
export function describeControl(c: MidiControl): string {
  const what =
    c.type === 'cc'
      ? `CC ${c.number}`
      : c.type === 'bend'
        ? 'Fader (bend)'
        : `Note ${NOTE_NAMES[c.number % 12]}${Math.floor(c.number / 12) - 1} (${c.number})`
  return `${what} · ch ${c.channel}`
}

/** Whether a message is a button or pad going down: a note, or a control change in its top half. */
export const isOn = (m: MidiMessage) => (m.kind === 'cc' ? m.value >= 64 : m.kind === 'noteOn')

/** The values each encoding sends for a turn of a few steps either way. */
const near = (v: number, lo: number, hi: number) => v >= lo && v <= hi
const RELATIVE: Record<Encoding, (v: number) => boolean> = {
  twos: (v) => near(v, 1, 15) || near(v, 113, 127),
  offset: (v) => near(v, 49, 63) || near(v, 65, 79),
  signed: (v) => near(v, 1, 15) || near(v, 65, 79),
}

/**
 * What kind of control sent these, the messages of one control in the order
 * they came while it was being learnt.
 *
 * A note is a button or a pad. A control change that only ever says 0 or 127
 * is a button. An endless knob repeats itself -- one step up is the same
 * value every time -- where a knob with ends never sends the same value
 * twice running, because it only sends when it moves. So a control whose
 * values repeat, and all fall where one of the encodings puts its steps, is
 * endless; anything else is a knob or slider with ends.
 *
 * A button is taken to be one that springs back, which most do, and so to
 * toggle what it is mapped to. One the controller latches itself sends on at
 * one press and off at the next, and that cannot be told from one press, so
 * that is changed on the mapping afterwards.
 */
export function classify(messages: readonly MidiMessage[]): Pick<MidiMapping, 'kind' | 'encoding' | 'button'> {
  const button = (): Pick<MidiMapping, 'kind' | 'button'> => ({ kind: 'button', button: 'toggle' })
  // A bend is a fader with ends, whatever it does.
  if (messages.some((m) => m.kind === 'bend')) return { kind: 'absolute' }
  if (messages.some((m) => m.kind !== 'cc')) return button()
  const values = messages.map((m) => m.value)
  if (values.length && values.every((v) => v === 0 || v === 127)) return button()
  const repeats = values.some((v, i) => i > 0 && v === values[i - 1])
  if (repeats) {
    const up = (lo: number, hi: number) => values.some((v) => near(v, lo, hi))
    // Told apart by the values only one of them uses: 113..127 is two's
    // complement going down, 49..63 is offset going down. Turned only up,
    // 1..15 is two's complement or sign and magnitude, which agree there,
    // and 65..79 is offset or sign and magnitude going down; offset is the
    // commoner of those two.
    const encoding: Encoding = up(113, 127)
      ? 'twos'
      : up(49, 63)
        ? 'offset'
        : up(1, 15) && up(65, 79)
          ? 'signed'
          : up(1, 15)
            ? 'twos'
            : 'offset'
    if (values.every(RELATIVE[encoding])) return { kind: 'relative', encoding }
  }
  return { kind: 'absolute' }
}

/**
 * The encoding an endless knob really uses, when a value it sends gives it
 * away: a knob learnt turning only one way could not show which of two it
 * was, and the guess shows itself wrong the first time it turns the other
 * way. A value that would be a turn of dozens of steps in one message under
 * the encoding believed, and a small one under another, is that other.
 * Null when the value is plausible as it stands.
 */
export function correctedEncoding(encoding: Encoding, value: number): Encoding | null {
  if (Math.abs(relativeSteps(value, encoding)) < IMPLAUSIBLE) return null
  for (const e of ALTERNATIVES[encoding]) if (Math.abs(relativeSteps(value, e)) < IMPLAUSIBLE) return e
  return null
}

/** Steps in one message past which a value is taken to mean the encoding is wrong. */
const IMPLAUSIBLE = 24
/**
 * What each encoding could have been instead, given how it was learnt: one
 * learnt as two's complement or sign and magnitude was turning up with small
 * values, which both send; one learnt as offset was sending values just
 * above 64, which sign and magnitude sends turning down.
 */
const ALTERNATIVES: Record<Encoding, Encoding[]> = {
  twos: ['signed'],
  signed: ['twos'],
  offset: ['signed'],
}

/** Steps an endless knob turned, up positive. */
export function relativeSteps(value: number, encoding: Encoding): number {
  if (encoding === 'offset') return value - 64
  if (encoding === 'signed') return value < 64 ? value : -(value - 64)
  return value < 64 ? value : value - 128
}

/** One step of an endless knob, as a share of the range: a hundred cross it, as a hundred wheel notches cross a knob. */
export const RELATIVE_STEP = 0.01

/** Within this of the value, a control with ends has picked it up: a couple of its 127 steps. */
export const PICKUP_NEAR = 2 / 127
/**
 * How long after a value is written that a different one read back is taken
 * to be the page catching up, rather than somebody else moving it. Messages
 * arrive faster than the page draws them.
 */
export const OWN_ECHO_MS = 300

/**
 * Soft takeover for one mapping: a control with ends does nothing until it
 * reaches where the value is, or passes it, so that touching a slider that
 * stands somewhere else does not make the sound jump to it. Moving the value
 * any other way -- the mouse, undo, a different project -- lets go of it
 * again.
 */
export class Pickup {
  /** The value last written, as a position 0..1, and when. */
  private sent: number | null = null
  private at = 0
  /** Where the control was last heard. */
  private hw: number | null = null
  private held = false

  /** Whether the control at `hw` should move a value standing at `current`. All positions 0..1. */
  accept(hw: number, current: number, now: number, enabled = true): boolean {
    if (!enabled) return true
    if (this.sent === null || (Math.abs(current - this.sent) > 1e-3 && now - this.at > OWN_ECHO_MS)) this.held = false
    if (!this.held) {
      const crossed = this.hw !== null && (this.hw - current) * (hw - current) <= 0
      if (crossed || Math.abs(hw - current) <= PICKUP_NEAR) this.held = true
    }
    this.hw = hw
    return this.held
  }

  /** Where a nudge starts from: what was last written, while the page has not caught up with it yet. */
  base(current: number, now: number): number {
    return this.sent !== null && now - this.at <= OWN_ECHO_MS ? this.sent : current
  }

  /** The value as it was actually written, which a value with steps may have rounded. */
  wrote(t: number, now: number) {
    this.sent = t
    this.at = now
  }

  /** Forget everything: the control now moves something else, and has to pick it up afresh. */
  reset() {
    this.sent = null
    this.hw = null
    this.held = false
  }

  /** Whether it is waiting to be picked up, for the monitor to say so. */
  get waiting() {
    return !this.held
  }
}

/**
 * Something a control can move, as the mapping sees it: a value with a
 * position, something on or off, or something pressed and let go.
 */
export type MidiTarget =
  | {
      kind: 'value'
      label: string
      /** Where it stands, 0..1. */
      get: () => number
      /** Move it to `t` (0..1); returns where it landed, which a value with steps may round. */
      set: (t: number) => number
      /** How many positions it has, for one with steps: a button steps through them. */
      steps?: number
    }
  | { kind: 'switch'; label: string; get: () => boolean; set: (on: boolean) => void }
  | { kind: 'trigger'; label: string; press: () => void; release: () => void }

/** What a mapping keeps between messages. */
export interface MappingState {
  pickup: Pickup
  /** A trigger fired from a knob, which is pressed while the knob is in its top half. */
  down: boolean
}

export const freshState = (): MappingState => ({ pickup: new Pickup(), down: false })

/**
 * One message, played into what it is mapped to. Returns false where it did
 * nothing -- a slider not picked up yet, a button let go of in toggle mode --
 * which is how the monitor says why nothing happened.
 */
export function dispatch(
  mapping: MidiMapping,
  m: MidiMessage,
  target: MidiTarget,
  state: MappingState,
  now: number,
  pickupOn = true,
): boolean {
  const on = isOn(m)
  if (target.kind === 'trigger') {
    if (mapping.kind === 'relative') {
      target.press()
      target.release()
      return true
    }
    // A knob fires it crossing the middle, not every step past it.
    if (mapping.kind === 'absolute' && on === state.down) return false
    if (on) {
      // A button that sends nothing when it is let go: the next press lets
      // go of the last one first.
      if (state.down) target.release()
      state.down = true
      target.press()
      return true
    }
    if (!state.down) return false
    state.down = false
    target.release()
    return true
  }

  if (target.kind === 'switch') {
    let next: boolean
    if (mapping.kind === 'button' && (mapping.button ?? 'toggle') === 'toggle') {
      if (!on) return false
      next = !target.get()
    } else if (mapping.kind === 'relative') {
      next = relativeSteps(m.value, mapping.encoding ?? 'twos') > 0
    } else next = on
    if (next === target.get()) return false
    target.set(next)
    return true
  }

  // A value.
  const current = target.get()
  const n = target.steps
  if (mapping.kind === 'button') {
    if ((mapping.button ?? 'toggle') === 'follow') {
      state.pickup.wrote(target.set(on ? 1 : 0), now)
      return true
    }
    if (!on) return false
    // A press steps through the positions of one with steps, round to the
    // first; anything else goes from wherever it is to whichever end is
    // further, so pressing it twice is a switch between the two.
    const base = state.pickup.base(current, now)
    const t = n && n > 2 ? ((Math.round(base * (n - 1)) + 1) % n) / (n - 1) : base < 0.5 ? 1 : 0
    state.pickup.wrote(target.set(t), now)
    return true
  }
  if (mapping.kind === 'relative') {
    const steps = relativeSteps(m.value, mapping.encoding ?? 'twos')
    if (!steps) return false
    const size = n && n > 1 ? 1 / (n - 1) : RELATIVE_STEP
    const t = Math.min(1, Math.max(0, state.pickup.base(current, now) + steps * size))
    state.pickup.wrote(target.set(t), now)
    return true
  }
  const hw = positionOf(m)
  if (!state.pickup.accept(hw, current, now, pickupOn)) return false
  state.pickup.wrote(target.set(hw), now)
  return true
}

/**
 * A new mapping put in with the rest. A control moves one thing and a thing
 * is moved by one control, so whatever had this control, or this target,
 * before is let go of: learning is also how a mapping is changed.
 */
export function bind(list: readonly MidiMapping[], mapping: MidiMapping): MidiMapping[] {
  return [
    ...list.filter((m) => !sameControl(m.control, mapping.control) && m.target !== mapping.target),
    mapping,
  ]
}

/**
 * Mappings as they may be kept: from storage, or from a file somebody else
 * wrote. Anything that is not one is dropped rather than half-read, and a
 * later mapping of the same control or target wins, as learning it again
 * would.
 */
export function cleanMappings(data: unknown): MidiMapping[] {
  const raw = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { mappings?: unknown }).mappings)
      ? (data as { mappings: unknown[] }).mappings
      : []
  let out: MidiMapping[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const m = item as Record<string, unknown>
    const c = m.control as Record<string, unknown> | undefined
    if (!c || typeof c !== 'object') continue
    const { device, channel, type, number } = c
    if (typeof device !== 'string') continue
    if (!Number.isInteger(channel) || (channel as number) < 1 || (channel as number) > 16) continue
    if (type !== 'cc' && type !== 'note' && type !== 'bend') continue
    if (!Number.isInteger(number) || (number as number) < 0 || (number as number) > 127) continue
    if (typeof m.target !== 'string' || !m.target) continue
    if (m.kind !== 'absolute' && m.kind !== 'relative' && m.kind !== 'button') continue
    const mapping: MidiMapping = {
      control: { device, channel: channel as number, type, number: number as number },
      kind: m.kind,
      target: m.target,
    }
    if (m.kind === 'relative') mapping.encoding = ENCODINGS.includes(m.encoding as Encoding) ? (m.encoding as Encoding) : 'twos'
    if (m.kind === 'button') mapping.button = BUTTON_MODES.includes(m.button as ButtonMode) ? (m.button as ButtonMode) : 'toggle'
    out = bind(out, mapping)
  }
  return out
}

/** The file a set of mappings is exported as. */
export function mappingsFile(mappings: readonly MidiMapping[]) {
  return { fresyn: 'midi-mappings', version: 1, mappings }
}

/**
 * Listens to the first control moved while a learn is waiting, and says what
 * kind it is once it goes quiet: half a second after its last message, or
 * as soon as it has said enough. Messages from other controls meanwhile are
 * ignored -- the first one touched is the one being learnt.
 */
export class Learner {
  private heard: MidiMessage[] = []
  static readonly QUIET_MS = 500
  static readonly ENOUGH = 8

  /** Take a message; true once the control has said enough to classify straight away. */
  hear(m: MidiMessage): boolean {
    const first = this.heard[0]
    if (first && !matches(controlOf(first), m)) return false
    this.heard.push(m)
    return this.heard.length >= Learner.ENOUGH
  }

  get started() {
    return this.heard.length > 0
  }

  /** The mapping of what was heard onto `target`, and a fresh start; null if nothing was. */
  finish(target: string): MidiMapping | null {
    const heard = this.heard
    this.heard = []
    if (!heard.length) return null
    return { control: controlOf(heard[0]), ...classify(heard), target }
  }

  reset() {
    this.heard = []
  }
}
