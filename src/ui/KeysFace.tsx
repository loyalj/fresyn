import { useCallback, useRef } from 'react'
import { formatValue } from '../patch/param'
import type { ModuleDef } from '../patch/types'

/** Two octaves and the C on top, which is what a 25-key controller is. */
const KEYS = 25
const OCTAVE = 12
/** Semitones within an octave that are sharps. */
const SHARP = new Set([1, 3, 6, 8, 10])
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const notes = Array.from({ length: KEYS }, (_, i) => i)
const naturals = notes.filter((n) => !SHARP.has(n % OCTAVE))
const sharps = notes.filter((n) => SHARP.has(n % OCTAVE))
/** How many naturals a sharp sits past, which is where it is drawn. */
const seat = (note: number) => naturals.filter((n) => n < note).length

interface Props {
  def: ModuleDef
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  /** Opens and closes this module's gate, through the rack's transport. */
  onGate?: (open: boolean) => void
}

/**
 * A 25-key keyboard, and the octave switch that moves it.
 *
 * Pressing a key does two separate things: it writes the note as a parameter,
 * the same way turning a knob does, and it opens the module's gate through
 * the same transport a Trigger uses. Keeping those apart is what lets a cable
 * into the Gate jack, and an offline render, play the keyboard too -- they
 * open the gate without touching the note, so what sounds is whatever key was
 * pressed last. Choosing the note and firing it are separate gestures, and
 * only the first one belongs to this panel.
 */
export function KeysFace({ def, valueOf, onChange, onGate }: Props) {
  const noteSpec = def.params.find((p) => p.id === 'note')!
  const octaveSpec = def.params.find((p) => p.id === 'octave')!
  const voicesSpec = def.params.find((p) => p.id === 'voices')!
  const note = Math.round(valueOf('note') ?? noteSpec.default)
  const octave = Math.round(valueOf('octave') ?? octaveSpec.default)
  const voices = Math.round(valueOf('voices') ?? voicesSpec.default)

  /** True between pressing a key and letting go, so a drag can glissando. */
  const held = useRef(false)

  const press = useCallback(
    (n: number) => {
      onChange('note', n)
      onGate?.(true)
      held.current = true
    },
    [onChange, onGate],
  )

  const release = useCallback(() => {
    if (!held.current) return
    held.current = false
    onGate?.(false)
  }, [onGate])

  const shift = (by: number) => {
    const next = Math.min(octaveSpec.max, Math.max(octaveSpec.min, octave + by))
    if (next !== octave) onChange('octave', next)
  }

  const voice = (by: number) => {
    const next = Math.min(voicesSpec.max, Math.max(voicesSpec.min, voices + by))
    if (next !== voices) onChange('voices', next)
  }

  const key = (n: number) => (
    <button
      key={n}
      className={`keys-key${SHARP.has(n % OCTAVE) ? ' sharp' : ''}${n === note ? ' held' : ''}`}
      style={SHARP.has(n % OCTAVE) ? ({ '--at': seat(n) } as React.CSSProperties) : undefined}
      // Pointer down rather than click, so a key sounds as it goes down and
      // holds for as long as it is held -- which is the whole point of a gate.
      onPointerDown={() => press(n)}
      // Sliding across the keyboard with the button down plays what it crosses.
      onPointerEnter={(e) => e.buttons === 1 && press(n)}
      aria-label={`${NAMES[n % OCTAVE]}, key ${n + 1}`}
      aria-pressed={n === note}
      type="button"
    />
  )

  return (
    <div className="keys-face">
      {/* Releasing anywhere over the panel closes the gate, so a pointer that
          slid off the key it started on cannot leave a note stuck on. */}
      <div
        className="keys-board"
        style={{ '--naturals': naturals.length } as React.CSSProperties}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerLeave={release}
      >
        {naturals.map(key)}
        {sharps.map(key)}
      </div>

      <div className="keys-controls">
        <div className="keys-octave">
          <button type="button" onClick={() => shift(-1)} aria-label="Octave down">
            &minus;
          </button>
          <span className="keys-octave-value">
            {octave > 0 ? `+${octave}` : octave}
          </span>
          <button type="button" onClick={() => shift(1)} aria-label="Octave up">
            +
          </button>
          <span className="knob-label">Octave</span>
        </div>

        {/* How many notes sound at once. A stepper like Octave rather than a
            knob, because it is a count: one is a single line, more is chords. */}
        <div className="keys-octave">
          <button type="button" onClick={() => voice(-1)} aria-label="Fewer voices">
            &minus;
          </button>
          <span className="keys-octave-value">{voices}</span>
          <button type="button" onClick={() => voice(1)} aria-label="More voices">
            +
          </button>
          <span className="knob-label">{voices === 1 ? 'Mono' : 'Voices'}</span>
        </div>

        <div className="keys-readout">
          <span className="keys-note">{NAMES[note % OCTAVE]}</span>
          {/* What the Pitch jack is actually putting out, in the octaves
              every CV destination in this rack is scaled in. */}
          <span className="keys-pitch">
            {formatValue({ ...noteSpec, unit: 'oct' }, note / OCTAVE + octave)}
          </span>
          <span className="knob-label">Pitch out</span>
        </div>
      </div>
    </div>
  )
}
