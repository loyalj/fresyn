import { useCallback, useEffect, useRef, useState } from 'react'
import type { Transport } from '../audio/Transport'
import type { LiveNotes } from '../input/liveNotes'
import { recordedNote, type HeldNote, type InputQuantize } from '../song/record'
import type { Note } from '../song/types'

interface Options {
  live: LiveNotes
  transport: Transport
  /** The track notes are written to: the one in the roll. */
  track: string
  lengthTicks: number
  /** Where the pattern's tick zero is in what the transport plays. */
  zero: number
  /** Quantize what is played in to this, or leave it as played. */
  quantize: InputQuantize | undefined
  /**
   * Write one note into the pattern. `take` is the same for every note of
   * one pass of recording, so the whole take is one step of undo.
   */
  onRecord: (note: Note, take: string) => void
}

/**
 * Recording notes played by hand into the pattern in the roll.
 *
 * Armed, it listens to every note played on the track and writes each one
 * where the playhead was heard when the key went down, once the key comes
 * back up. Arming starts the transport if it is stopped, and stopping the
 * transport ends the take: there is nothing to record against when nothing
 * is playing.
 */
export function useNoteRecording({ live, transport, track, lengthTicks, zero, quantize, onRecord }: Options) {
  const [armed, setArmed] = useState(false)
  // Read at the moment a note lands rather than captured when the take began:
  // the grid or the quantize can change mid-take and should count from then.
  const now = useRef({ track, lengthTicks, zero, quantize, onRecord })
  now.current = { track, lengthTicks, zero, quantize, onRecord }
  const take = useRef(0)

  useEffect(() => {
    if (!armed) return
    const id = `take:${++take.current}`
    /** Keys down, by where they came from and which row. */
    const held = new Map<string, HeldNote>()
    let last = transport.state.tick

    const finish = (key: string, end: number) => {
      const h = held.get(key)
      if (!h) return
      held.delete(key)
      const c = now.current
      const note = recordedNote(c.track, h, end, c.zero, c.lengthTicks, transport.currentLoop, c.quantize)
      if (note) c.onRecord(note, id)
    }
    const finishAll = (end: number, source?: string) => {
      for (const key of [...held.keys()]) if (!source || key.startsWith(source)) finish(key, end)
    }

    const stopNotes = live.subscribe((n) => {
      if (n.track !== now.current.track) return
      const at = transport.heardTick()
      const key = `${n.source}:${n.pitch}`
      if (n.kind === 'on') {
        if (at === null) return
        // The panel is one finger: sliding to the next key lets go of the last.
        if (n.source === 'panel') finishAll(at, 'panel:')
        finish(key, at)
        held.set(key, { start: at, pitch: n.pitch, velocity: n.velocity })
      } else {
        finish(key, at ?? last)
      }
    })
    const stopTransport = transport.subscribe((state) => {
      if (state.playing) {
        last = transport.heardTick() ?? state.tick
        return
      }
      finishAll(last)
      setArmed(false)
    })
    return () => {
      stopNotes()
      stopTransport()
      finishAll(transport.heardTick() ?? last)
    }
  }, [armed, live, transport])

  /** Start recording, and the transport with it; or stop recording and leave it playing. */
  const toggle = useCallback(
    (fromTick: number) => {
      if (armed) {
        setArmed(false)
        return
      }
      setArmed(true)
      if (!transport.state.playing) void transport.play(fromTick)
    },
    [armed, transport],
  )

  return { armed, toggle }
}
