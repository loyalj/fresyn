import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import type { Template } from '../patch/library'
import { engineEventsByTrack, kitRow, noteTarget, type NoteTarget } from '../song/bind'
import type { SongEvent } from '../song/schedule'
import { rowForMidi, tuningOf } from '../song/tuning'

/** The engine's name for the rack being auditioned: no project track can have it. */
const AUDITION = '__audition'
/** How long a sound with nothing to play -- a drone, an ambience -- is heard for. */
const DRONE_MS = 2200
/** How long the last note is given to ring out before the rack is taken away. */
const TAIL_MS = 1400

/** One note of the phrase: when, which row, how long, how hard. */
type Step = { at: number; row: number; length: number; velocity: number }

/**
 * A short phrase for a sound, by how it is played: an arpeggio up from C4
 * for a pitched voice, a bar of kick, hat and snare for a kit, two hits for
 * something fired.
 */
function phraseFor(target: NoteTarget | null, rowOf: (midi: number) => number): Step[] {
  if (!target) return []
  if (target.kind === 'kit') {
    return [36, 42, 38, 42, 36, 36, 38, 42].map((note, i) => ({ at: i * 220, row: kitRow(note), length: 110, velocity: i % 2 ? 0.7 : 0.95 }))
  }
  if (target.kind === 'trigger') return [0, 650].map((at) => ({ at, row: 0, length: 120, velocity: 0.9 }))
  return [60, 64, 67, 72].map((note, i) => ({ at: i * 260, row: rowOf(note), length: i === 3 ? 700 : 230, velocity: 0.85 }))
}

/**
 * Hearing a library sound before it replaces the rack on the bench.
 *
 * The sound is built as the library would build it and put on a track of its
 * own in the engine for as long as it plays -- never in the song, never on
 * the bench -- then taken away again. Starting another stops the one before.
 */
export function useAudition(engine: AudioEngine) {
  const [playing, setPlaying] = useState<string | null>(null)
  const timers = useRef<number[]>([])
  const target = useRef<NoteTarget | null>(null)

  const clear = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t)
    timers.current = []
  }, [])

  const stop = useCallback(() => {
    clear()
    engine.removeTrack(AUDITION)
    target.current = null
    setPlaying(null)
  }, [clear, engine])

  const play = useCallback(
    async (template: Template) => {
      clear()
      const built = template.build()
      await engine.start()
      engine.setTrackPatch(AUDITION, built.patch, built.values)
      const t = noteTarget(built.patch)
      target.current = t
      setPlaying(template.id)
      const tuning = t?.kind === 'note' ? tuningOf({ patch: built.patch, values: built.values }) : null
      const steps = phraseFor(t, (midi) => rowForMidi(midi, tuning))
      const send = (events: SongEvent[]) => {
        if (target.current) engine.schedule(engineEventsByTrack(events, new Map([[AUDITION, target.current]])))
      }
      for (const s of steps) {
        timers.current.push(window.setTimeout(() => send([{ frame: 0, track: AUDITION, kind: 'on', pitch: s.row, velocity: s.velocity }]), s.at))
        timers.current.push(window.setTimeout(() => send([{ frame: 0, track: AUDITION, kind: 'off', pitch: s.row, velocity: 0 }]), s.at + s.length))
      }
      const end = steps.length ? Math.max(...steps.map((s) => s.at + s.length)) : DRONE_MS
      timers.current.push(window.setTimeout(stop, end + TAIL_MS))
    },
    [clear, engine, stop],
  )

  // Never left playing behind a closed library.
  useEffect(() => stop, [stop])

  return { play, stop, playing }
}
