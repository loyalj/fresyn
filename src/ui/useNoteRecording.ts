import { useCallback, useEffect, useRef, useState } from 'react'
import type { Transport } from '../audio/Transport'
import type { LiveMoves, LiveNotes } from '../input/liveNotes'
import { patternTick, recordedNote, type HeldNote, type InputQuantize } from '../song/record'
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

/** How long a control has to be still before the hand is taken to have let go of it. */
const LET_GO_MS = 350

/** One control's movement in a take: a stretch per pass round the loop. */
export type Touch = { tick: number; value: number }[][]

interface MoveOptions {
  armed: boolean
  moves: LiveMoves | undefined
  transport: Transport
  lengthTicks: number
  zero: number
  /** Write a control's take so far into its lane. Called as it moves, under one take key. */
  onWrite: (target: string, touch: Touch, take: string) => void
  /** The hand has let go: the control goes back to its automation, which now has the take. */
  onLetGo: (target: string) => void
}

/**
 * Recording a hand on the controls into automation lanes, beside the notes.
 *
 * Armed, every control moved while the song plays -- a knob, a fader, a
 * MIDI controller's slider -- is written into its lane in the pattern on the
 * roll, at the tick it was heard moving, over whatever the lane had in the
 * stretch it moved through. It is written as it goes, so the lane fills in
 * under the hand, and once the control has been still for a moment it goes
 * back to the automation: the next time round the loop plays the take.
 */
export function useAutomationRecording({ armed, moves, transport, lengthTicks, zero, onWrite, onLetGo }: MoveOptions) {
  const now = useRef({ lengthTicks, zero, onWrite, onLetGo })
  now.current = { lengthTicks, zero, onWrite, onLetGo }
  const take = useRef(0)

  useEffect(() => {
    if (!armed || !moves) return
    const id = `take:auto:${++take.current}`
    const touches = new Map<string, { touch: Touch; timer: number }>()
    const letGo = (target: string) => {
      const t = touches.get(target)
      if (!t) return
      window.clearTimeout(t.timer)
      touches.delete(target)
      now.current.onLetGo(target)
    }

    const stopMoves = moves.subscribe((m) => {
      const heard = transport.heardTick()
      const c = now.current
      const tick = heard === null ? null : patternTick(heard, c.zero, c.lengthTicks)
      if (tick === null) return
      let t = touches.get(m.target)
      if (!t) touches.set(m.target, (t = { touch: [[]], timer: 0 }))
      let stretch = t.touch[t.touch.length - 1]
      // Back round to the start of the loop: a new stretch, written over its
      // own part of the lane.
      if (stretch.length && tick < stretch[stretch.length - 1].tick - c.lengthTicks / 2) t.touch.push((stretch = []))
      stretch.push({ tick, value: m.position })
      c.onWrite(m.target, t.touch, id)
      window.clearTimeout(t.timer)
      t.timer = window.setTimeout(() => letGo(m.target), LET_GO_MS)
    })
    const stopTransport = transport.subscribe((state) => {
      if (!state.playing) for (const target of [...touches.keys()]) letGo(target)
    })
    return () => {
      stopMoves()
      stopTransport()
      for (const target of [...touches.keys()]) letGo(target)
    }
  }, [armed, moves, transport])
}
