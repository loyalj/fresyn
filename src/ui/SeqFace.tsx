import { useEffect, useRef } from 'react'
import { SEQ_STEPS_LIST } from '../patch/defs'
import type { ModuleDef } from '../patch/types'
import { useEngine } from './EngineContext'
import { Knob } from './Knob'

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
  const byId = Object.fromEntries(def.params.map((p) => [p.id, p]))
  const length = Math.round(valueOf('length') ?? byId.length.default)

  const lamps = useRef<(HTMLDivElement | null)[]>([])
  /** Steps reported since the draw loop last looked, then consumed. */
  const incoming = useRef(new Float32Array(SEQ_STEPS_LIST.length))
  /** What each lamp is currently showing, which is what fades. */
  const shown = useRef(new Float32Array(SEQ_STEPS_LIST.length))

  useEffect(() => {
    if (!engine) return
    return engine.onLevels((levels) => {
      const next = levels[moduleId]
      if (next) incoming.current.set(next.subarray(0, SEQ_STEPS_LIST.length))
    })
  }, [engine, moduleId])

  // Written straight to the elements rather than through React state, as the
  // mixer's meters are: a rack-wide re-render thirty times a second would
  // make every knob in the room feel sticky.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      for (let i = 0; i < SEQ_STEPS_LIST.length; i++) {
        // Each report is taken once. Left in place it would hold the lamp lit
        // for good once the sequencer stopped.
        const target = incoming.current[i]
        incoming.current[i] = 0

        const faded = shown.current[i] - FADE
        const v = target > faded ? target : faded > 0 ? faded : 0
        if (v === shown.current[i]) continue
        shown.current[i] = v

        const el = lamps.current[i]
        if (el) el.style.opacity = String(v)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const knob = (id: string) => (
    <Knob
      spec={byId[id]}
      value={valueOf(id) ?? byId[id].default}
      onChange={(v) => onChange(id, v)}
      step={byId[id].unit === '#' ? 1 : undefined}
    />
  )

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
