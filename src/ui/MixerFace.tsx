import { useEffect, useRef } from 'react'
import { MIXER_CHANNELS } from '../patch/defs'
import type { ModuleDef } from '../patch/types'
import { useEngine, useEngineId } from './EngineContext'
import { FALL, fillBar, scale } from './meter'
import { useFace } from './useFace'
import { useFallingMeter } from './useFallingMeter'

interface Props {
  def: ModuleDef
  moduleId: string
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
}

/** One bar per channel, with the stereo bus last -- the order the DSP reports. */
const BARS = MIXER_CHANNELS.length + 1

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
  /** How the engine reports this module: by its id in the track, a pad's included. */
  const engineId = useEngineId(moduleId)
  const { read, control } = useFace(def, valueOf, onChange)
  /** A mute or solo, which is stored as a number and read as a state. */
  const isOn = (id: string) => read(id) >= 0.5
  const toggle = (id: string) => onChange(id, isOn(id) ? 0 : 1)

  const bars = useRef<(HTMLDivElement | null)[]>([])
  const feed = useFallingMeter(FALL, (i: number, v) => fillBar(bars.current[i], v))

  /** The loudness readout, written to directly like the bars are. */
  const lufsRef = useRef<HTMLSpanElement>(null)
  const lastLufs = useRef('')

  useEffect(() => {
    if (!engine) return
    return engine.onLevels((levels) => {
      const next = levels[engineId]
      if (!next) return
      for (let i = 0; i < BARS; i++) feed(i, scale(next[i] ?? 0))
      // Short-term, the three-second reading, because it is the one steady
      // enough to read while a sound plays and the one a target is set in.
      // Only written when the figure it shows changes.
      const el = lufsRef.current
      if (el && next.length > BARS + 1) {
        const st = next[BARS + 1]
        const text = st <= -70 ? '— LUFS' : `${st.toFixed(1).replace('-', '−')} LUFS`
        if (text !== lastLufs.current) {
          lastLufs.current = text
          el.textContent = text
          el.title = `Loudness over the last 3 s, as BS.1770 measures it. The last 400 ms: ${
            next[BARS] <= -70 ? 'silent' : `${next[BARS].toFixed(1)} LUFS`
          }`
        }
      }
    })
  }, [engine, engineId, feed])

  return (
    <div className="mixer">
      {MIXER_CHANNELS.map((n, i) => (
        <div className="strip" key={n}>
          <div className="strip-body">
            <div className="strip-knobs">
              {control(`pan${n}`)}
              {control(`level${n}`)}
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
            {control('master')}
          </div>
          <Meter index={BARS - 1} bars={bars} />
        </div>
        {/* How loud the mix is, which a peak meter cannot say: two sounds
            with the same peak can be far apart to the ear. */}
        <span className="strip-lufs" ref={lufsRef}>
          — LUFS
        </span>
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
    <div className="strip-meter level-meter" aria-hidden="true">
      <div
        className="strip-meter-fill level-meter-fill"
        ref={(el) => {
          bars.current[index] = el
        }}
      />
    </div>
  )
}

