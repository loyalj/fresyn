import { useEffect, useRef } from 'react'
import { MIXER_CHANNELS } from '../patch/defs'
import type { ModuleDef } from '../patch/types'
import { useEngine } from './EngineContext'
import { Knob } from './Knob'

interface Props {
  def: ModuleDef
  moduleId: string
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
}

/** One bar per channel, with the stereo bus last -- the order the DSP reports. */
const BARS = MIXER_CHANNELS.length + 1
/** Quieter than this reads as silence, as it does on the scope. */
const FLOOR_DB = -48
/**
 * How far a bar falls per frame at 60 Hz: full scale to silence in about
 * three quarters of a second. A meter that tracked a 30 Hz peak exactly
 * would be a strobe -- the fall is what the eye actually reads a level off.
 */
const FALL = 1 / 45

/**
 * A mixer reads as channel strips, not as a row of seventeen loose knobs.
 *
 * Each strip has a meter beside its faders, and the main bus has one of its
 * own. Levels arrive from the audio thread about thirty times a second and
 * are written straight to the bars' geometry, never through React state: a
 * rack-wide re-render at that rate would make every knob in the room feel
 * sticky, which is the same reason the scope draws the way it does.
 */
export function MixerFace({ def, moduleId, valueOf, onChange }: Props) {
  const engine = useEngine()
  const byId = Object.fromEntries(def.params.map((p) => [p.id, p]))
  /** A mute or solo, which is stored as a number and read as a state. */
  const isOn = (id: string) => (valueOf(id) ?? byId[id].default) >= 0.5
  const toggle = (id: string) => onChange(id, isOn(id) ? 0 : 1)

  const bars = useRef<(HTMLDivElement | null)[]>([])
  /** The newest peak per bar, consumed and cleared by the draw loop. */
  const incoming = useRef(new Float32Array(BARS))
  /** What each bar is currently showing, which is what falls. */
  const shown = useRef(new Float32Array(BARS))

  useEffect(() => {
    if (!engine) return
    return engine.onLevels((levels) => {
      const next = levels[moduleId]
      if (next) incoming.current.set(next.subarray(0, BARS))
    })
  }, [engine, moduleId])

  useEffect(() => {
    let raf = 0
    const tick = () => {
      for (let i = 0; i < BARS; i++) {
        // Each reported peak is taken once. Left in place it would hold the
        // bar up for good once the rack went quiet.
        const target = scale(incoming.current[i])
        incoming.current[i] = 0

        const fallen = shown.current[i] - FALL
        const v = target > fallen ? target : fallen > 0 ? fallen : 0
        if (v === shown.current[i]) continue
        shown.current[i] = v

        // Clipped rather than scaled: scaling the fill would squash its
        // gradient, so a bar at a tenth would be painted in the colour the
        // top of the scale is meant to be reserved for.
        const el = bars.current[i]
        if (el) el.style.clipPath = `inset(${(1 - v) * 100}% 0 0 0)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="mixer">
      {MIXER_CHANNELS.map((n, i) => (
        <div className="strip" key={n}>
          <div className="strip-body">
            <div className="strip-knobs">
              <Knob
                spec={byId[`pan${n}`]}
                value={valueOf(`pan${n}`) ?? byId[`pan${n}`].default}
                onChange={(v) => onChange(`pan${n}`, v)}
              />
              <Knob
                spec={byId[`level${n}`]}
                value={valueOf(`level${n}`) ?? byId[`level${n}`].default}
                onChange={(v) => onChange(`level${n}`, v)}
              />
            </div>
            <Meter index={i} bars={bars} />
          </div>
          <div className="strip-switches">
            <button
              type="button"
              className={`strip-switch${isOn(`mute${n}`) ? ' on' : ''}`}
              onClick={() => toggle(`mute${n}`)}
              aria-pressed={isOn(`mute${n}`)}
              aria-label={`Mute channel ${n}`}
              title={`Mute channel ${n}`}
            >
              M
            </button>
            <button
              type="button"
              className={`strip-switch solo${isOn(`solo${n}`) ? ' on' : ''}`}
              onClick={() => toggle(`solo${n}`)}
              aria-pressed={isOn(`solo${n}`)}
              aria-label={`Solo channel ${n}`}
              title={`Solo channel ${n} -- silences every channel that is not soloed`}
            >
              S
            </button>
          </div>
          <span className="strip-number">{n}</span>
        </div>
      ))}

      <div className="strip strip-master">
        <div className="strip-body">
          <div className="strip-knobs">
            <Knob
              spec={byId.master}
              value={valueOf('master') ?? byId.master.default}
              onChange={(v) => onChange('master', v)}
            />
          </div>
          <Meter index={BARS - 1} bars={bars} />
        </div>
        <span className="strip-number">MAIN</span>
      </div>
    </div>
  )
}

interface MeterProps {
  index: number
  bars: React.RefObject<(HTMLDivElement | null)[]>
}

/**
 * Hidden from assistive technology on purpose. A bar that changes sixty
 * times a second has nothing to say that the fader's own readout does not,
 * and a live region that shouted every frame would be unusable.
 */
function Meter({ index, bars }: MeterProps) {
  return (
    <div className="strip-meter" aria-hidden="true">
      <div
        className="strip-meter-fill"
        ref={(el) => {
          bars.current[index] = el
        }}
      />
    </div>
  )
}

/**
 * Amplitude to a fraction of the bar, on a decibel scale. A linear meter
 * spends almost all of its travel in the loudest few decibels, so everything
 * below a shout sits flat on the floor and tells you nothing.
 */
function scale(amplitude: number) {
  if (amplitude <= 0) return 0
  const db = 20 * Math.log10(amplitude)
  if (db <= FLOOR_DB) return 0
  return db >= 0 ? 1 : 1 - db / FLOOR_DB
}
