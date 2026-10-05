import { useCallback, useEffect, useRef, useState } from 'react'

/** A note from a controller: which key, and how hard. */
export interface MidiNote {
  kind: 'on' | 'off'
  /** The MIDI note number, 60 being middle C. */
  note: number
  /** 0..1; 0 on an off. */
  velocity: number
}

/**
 * The notes in a MIDI message, if it is one: note on and note off, on any
 * channel. A note on at velocity zero is a note off -- most keyboards send
 * their releases that way, to save a byte of running status. Everything
 * else a controller sends (the pitch wheel, knobs, the clock) is not a note
 * and comes back null.
 */
export function parseMidi(data: ArrayLike<number>): MidiNote | null {
  if (data.length < 3) return null
  const type = data[0] & 0xf0
  const note = data[1] & 0x7f
  const velocity = data[2] & 0x7f
  if (type === 0x90 && velocity > 0) return { kind: 'on', note, velocity: velocity / 127 }
  if (type === 0x80 || type === 0x90) return { kind: 'off', note, velocity: 0 }
  return null
}

/**
 * One message from a controller, as a mapping reads it: where it came from,
 * what kind it is, and its number and value in MIDI's own 0..127.
 *
 * The kinds the controls on a controller send. A knob or a slider sends a
 * control change; a button or a pad sends either a control change or a
 * note, whichever its maker chose -- so both are read, and a note on at
 * velocity zero is a note off here as well. A fader on a Mackie Control
 * surface sends pitch bend, one channel per fader, for its finer steps.
 */
export interface MidiMessage {
  /** The input it arrived on, by the name the system gives it. */
  device: string
  /** 1..16, as a controller's own display counts them. */
  channel: number
  kind: 'cc' | 'noteOn' | 'noteOff' | 'bend'
  /** The controller number, or the note; 0 for a bend. */
  number: number
  /** The controller's value, or the velocity, 0..127; 0 on a note off. A bend's top seven bits. */
  value: number
  /** A bend's whole value, 0..16383. */
  fine?: number
}

/** Where a message puts a control with ends, 0..1: a bend's to its full fourteen bits. */
export const positionOf = (m: MidiMessage) => (m.kind === 'bend' && m.fine !== undefined ? m.fine / 16383 : m.value / 127)

/** A control change, a note or a bend in these bytes, or null for anything else. */
export function readMessage(data: ArrayLike<number>, device: string): MidiMessage | null {
  if (data.length < 3) return null
  const type = data[0] & 0xf0
  const channel = (data[0] & 0x0f) + 1
  const number = data[1] & 0x7f
  const value = data[2] & 0x7f
  if (type === 0xe0) return { device, channel, kind: 'bend', number: 0, value, fine: (value << 7) | number }
  if (type === 0xb0) return { device, channel, kind: 'cc', number, value }
  if (type === 0x90 && value > 0) return { device, channel, kind: 'noteOn', number, value }
  if (type === 0x80 || type === 0x90) return { device, channel, kind: 'noteOff', number, value: 0 }
  return null
}

export type MidiStatus =
  | { state: 'off' }
  | { state: 'unsupported' }
  | { state: 'asking' }
  | { state: 'denied'; error: string }
  | { state: 'ready'; devices: string[] }

/** Only what is used of the Web MIDI types, which not every DOM lib ships. */
interface MidiInputPort {
  name?: string | null
  state?: string
  onmidimessage: ((e: { data: Uint8Array | null }) => void) | null
}
interface MidiOutputPort {
  name?: string | null
  state?: string
  send(data: number[]): void
}
interface MidiAccess {
  inputs: Map<string, MidiInputPort>
  outputs?: Map<string, MidiOutputPort>
  onstatechange: (() => void) | null
}

/**
 * The output a controller's input goes with: the one of the same name, which
 * is how most systems list a device's two halves, or failing that one whose
 * name contains it or is contained in it.
 */
export function outputFor<T extends { name?: string | null }>(outputs: Iterable<T>, device: string): T | null {
  const list = [...outputs]
  const name = (o: T) => o.name || ''
  return (
    list.find((o) => name(o) === device) ??
    list.find((o) => name(o) && (name(o).includes(device) || device.includes(name(o)))) ??
    null
  )
}

/**
 * Every MIDI input the browser can see, each message handed to `onMessage`
 * with the name of the input it came in on, while `enabled`. Asked for only when switched on: the browser asks the person
 * first, and a page that asked on load would be asking before anybody had
 * said they own a keyboard. Devices plugged in afterwards are picked up as
 * they arrive.
 */
export function useMidiInput(
  enabled: boolean,
  onMessage: (data: Uint8Array, device: string) => void,
): { status: MidiStatus; send: (device: string, data: number[]) => boolean } {
  const [status, setStatus] = useState<MidiStatus>({ state: 'off' })
  const handler = useRef(onMessage)
  handler.current = onMessage
  const accessRef = useRef<MidiAccess | null>(null)
  /**
   * A message back to a controller -- a light on its buttons, where its
   * fader should be -- on the output that goes with the input it is known
   * by. False when it has none, or nothing is listening yet.
   */
  const send = useCallback((device: string, data: number[]) => {
    const outputs = accessRef.current?.outputs
    const out = outputs && outputFor(outputs.values(), device)
    if (!out || out.state === 'disconnected') return false
    try {
      out.send(data)
      return true
    } catch {
      return false
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setStatus({ state: 'off' })
      return
    }
    const ask = (navigator as Navigator & { requestMIDIAccess?: () => Promise<MidiAccess> }).requestMIDIAccess
    if (!ask) {
      setStatus({ state: 'unsupported' })
      return
    }
    let access: MidiAccess | null = null
    let gone = false
    setStatus({ state: 'asking' })

    const listen = () => {
      if (!access) return
      const names: string[] = []
      for (const port of access.inputs.values()) {
        const name = port.name || 'MIDI input'
        port.onmidimessage = (e) => {
          if (e.data) handler.current(e.data, name)
        }
        if (port.state !== 'disconnected') names.push(name)
      }
      setStatus({ state: 'ready', devices: names })
    }

    ask.call(navigator).then(
      (a) => {
        if (gone) return
        access = a
        accessRef.current = a
        a.onstatechange = listen
        listen()
      },
      (e: unknown) => {
        if (!gone) setStatus({ state: 'denied', error: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => {
      gone = true
      accessRef.current = null
      if (!access) return
      access.onstatechange = null
      for (const port of access.inputs.values()) port.onmidimessage = null
    }
  }, [enabled])

  return { status, send }
}
