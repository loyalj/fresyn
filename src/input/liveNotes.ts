/**
 * Notes being played by hand, as they are played: a key on the Keyboard
 * panel, a Trigger's key or button, a note on a MIDI controller.
 *
 * Each of those already makes its own sound by its own path. This is only
 * the news that it happened, for whatever wants to hear it -- the roll, when
 * it is recording. A plain emitter rather than React state, because a note
 * has to reach the recorder in the same moment it is played, and a state
 * update would arrive a render later with the playhead already moved on.
 */
export interface LiveNote {
  kind: 'on' | 'off'
  /** The track it was played on: always the one on the bench, for now. */
  track: string
  /** In the track's rows, as the roll counts them. */
  pitch: number
  /** 0..1. Ignored on an off. */
  velocity: number
  /**
   * Where it came from. The panel is one finger: a new key replaces the one
   * held, where a controller can hold a chord.
   */
  source: 'panel' | 'midi'
}

export class LiveNotes {
  private listeners = new Set<(note: LiveNote) => void>()

  emit(note: LiveNote) {
    for (const fn of this.listeners) fn(note)
  }

  subscribe(fn: (note: LiveNote) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}
