import { useEffect, useRef, useState } from 'react'

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
interface MidiAccess {
  inputs: Map<string, MidiInputPort>
  onstatechange: (() => void) | null
}

/**
 * Every MIDI input the browser can see, played into `onNote`, while
 * `enabled`. Asked for only when switched on: the browser asks the person
 * first, and a page that asked on load would be asking before anybody had
 * said they own a keyboard. Devices plugged in afterwards are picked up as
 * they arrive.
 */
export function useMidiInput(enabled: boolean, onNote: (note: MidiNote) => void): MidiStatus {
  const [status, setStatus] = useState<MidiStatus>({ state: 'off' })
  const handler = useRef(onNote)
  handler.current = onNote

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
        port.onmidimessage = (e) => {
          const note = e.data && parseMidi(e.data)
          if (note) handler.current(note)
        }
        if (port.state !== 'disconnected') names.push(port.name || 'MIDI input')
      }
      setStatus({ state: 'ready', devices: names })
    }

    ask.call(navigator).then(
      (a) => {
        if (gone) return
        access = a
        a.onstatechange = listen
        listen()
      },
      (e: unknown) => {
        if (!gone) setStatus({ state: 'denied', error: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => {
      gone = true
      if (!access) return
      access.onstatechange = null
      for (const port of access.inputs.values()) port.onmidimessage = null
    }
  }, [enabled])

  return status
}
