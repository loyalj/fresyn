import { useEffect, useRef } from 'react'
import { SEQ_STEPS_LIST } from '../patch/defs'
import type { ModuleDef } from '../patch/types'
import { useEngine, useEngineId } from './EngineContext'
import { useFace } from './useFace'
import { useFallingMeter } from './useFallingMeter'

interface Props {
  def: ModuleDef
  moduleId: string
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
}

/**
 * How far a lamp fades per frame at 60 Hz: lit to dark in about a fifth of a
 * second. A lamp that went out the instant the step did would be invisible at
 * any tempo worth using, and one that did not fade at all would leave the
 * whole row lit.
 */
const FADE = 1 / 12

/**
 * Eight steps as eight columns, which is the shape the module actually has.
 *
 * Laid out like the mixer's channel strips rather than as nineteen loose
 * knobs, for the same reason: a row of knobs called CV 1 through CV 8 tells
 * you nothing about which of them is playing, and the pattern is the thing
 * you are editing. Each column is one step -- its CV, its level, a lamp that
 * lights when it plays, and its number.
 *
 * Steps past the Steps knob are dimmed rather than hidden. They keep their
 * values -- shortening a pattern and lengthening it again must not cost you
 * what was in it -- and seeing them greyed is what makes it obvious that the
 * knob shortened the pattern rather than emptied it.
 */
export function SeqFace({ def, moduleId, valueOf, onChange }: Props) {
  const engine = useEngine()
  /** How the engine reports this module: by its id in the track, a pad's included. */
  const engineId = useEngineId(moduleId)
  const { read, control: knob } = useFace(def, valueOf, onChange)
  const length = Math.round(read('length'))

  const lamps = useRef<(HTMLDivElement | null)[]>([])
  // Written straight to the elements rather than through React state, as the
  // mixer's meters are: a rack-wide re-render thirty times a second would
  // make every knob in the room feel sticky.
  const feed = useFallingMeter(FADE, (i: number, v) => {
    const el = lamps.current[i]
    if (el) el.style.opacity = String(v)
  })

  useEffect(() => {
    if (!engine) return
    return engine.onLevels((levels) => {
      const next = levels[engineId]
      if (!next) return
      for (let i = 0; i < SEQ_STEPS_LIST.length; i++) feed(i, next[i] ?? 0)
    })
  }, [engine, engineId, feed])

  return (
    <div className="seq">
      <div className="seq-steps">
        {SEQ_STEPS_LIST.map((n, i) => (
          <div className={`seq-step${n > length ? ' seq-step-off' : ''}`} key={n}>
            {knob(`step${n}`)}
            {knob(`level${n}`)}
            {/* Hidden from assistive technology: a lamp that changes sixty
                times a second has nothing to say, and a live region that
                announced every step would make the panel unusable. */}
            <div className="seq-lamp-track" aria-hidden="true">
              <div
                className="seq-lamp"
                ref={(el) => {
                  lamps.current[i] = el
                }}
              />
            </div>
            <span className="seq-number">{n}</span>
          </div>
        ))}
      </div>

      <div className="seq-controls">
        {knob('rate')}
        {knob('length')}
        {knob('gateLen')}
      </div>
    </div>
  )
}
