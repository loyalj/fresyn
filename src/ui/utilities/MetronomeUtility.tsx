import { useEffect, useRef, useState } from 'react'
import { loadPrefs, savePrefs, type MetronomePrefs } from '../../patch/storage'
import { TEMPO_MAX, TEMPO_MIN } from '../../song/types'
import type { UtilityProps } from '../../utilities'
import { CLICK_SOUNDS, ClickCounter, type Click, type ClickSound, type MetronomeSettings } from '../../utilities/metronome'
import { TapTempo } from '../../utilities/timing'
import { NumberField } from '../NumberField'
import { usePanelKey } from '../UtilityPanel'

/** How far ahead of the audio clicks are scheduled while the page is in front, in seconds. */
const AHEAD = 0.12
/**
 * And while it is in the background, where a browser runs timers once a
 * second at best: far enough ahead that the click never runs dry.
 */
const AHEAD_HIDDEN = 1.6
/** How often the scheduler looks, in milliseconds. */
const LOOK_MS = 25
/** How long after Start the first click lands: time for the device to wake. */
const LEAD_IN = 0.08

const UNITS = [1, 2, 4, 8, 16, 32]
const SUBDIVISIONS = [
  [1, 'Beats'],
  [2, '2 per beat'],
  [3, 'Triplets'],
  [4, '4 per beat'],
] as const
const SOUNDS: [ClickSound, string][] = [
  ['click', 'Click'],
  ['wood', 'Wood'],
  ['beep', 'Beep'],
]

function initial(props: UtilityProps): MetronomePrefs {
  return {
    bpm: props.song.tempo,
    beats: props.song.meter?.beats ?? 4,
    unit: props.song.meter?.unit ?? 4,
    subdivision: 1,
    accent: true,
    sound: 'click',
    volume: 0.7,
    ...loadPrefs().metronome,
  }
}

/**
 * The Metronome utility: a click at a tempo, on its own.
 *
 * It sounds through the same device as the rack but not through the rack or
 * the song's desk, so it is never in a bounce and never pushes the master
 * into its limiter. Each click is scheduled a little ahead on the audio
 * clock, so it lands on its sample however busy the page is; the lamps are
 * lit from the same schedule, as each click is heard rather than as it is
 * sent. Space starts and stops it while the panel has the focus. Closing the
 * panel stops it.
 */
export function MetronomeUtility(props: UtilityProps) {
  const [state, setState] = useState<MetronomePrefs>(() => initial(props))
  useEffect(() => savePrefs({ metronome: state }), [state])
  const set = (change: Partial<MetronomePrefs>) => setState((s) => ({ ...s, ...change }))

  const [running, setRunning] = useState(false)
  const [lit, setLit] = useState<{ beat: number; kind: Click['kind']; n: number } | null>(null)
  const [failed, setFailed] = useState(false)
  /** The audio device is being opened: the first press of a session waits on it. */
  const [waking, setWaking] = useState(false)

  // What the scheduler reads, kept current without restarting it.
  const settings = useRef<MetronomeSettings & { sound: ClickSound; volume: number }>(null!)
  settings.current = {
    bpm: state.bpm,
    sig: { beats: state.beats, unit: state.unit },
    subdivision: state.subdivision,
    accent: state.accent,
    sound: state.sound,
    volume: state.volume,
  }

  const engine = useRef<{ stop: () => void } | null>(null)
  const starting = useRef(false)

  const start = async () => {
    if (engine.current || starting.current) return
    starting.current = true
    setWaking(true)
    const ctx = await props.audio()
    starting.current = false
    setWaking(false)
    if (!ctx) {
      setFailed(true)
      return
    }
    setFailed(false)
    engine.current = run(ctx, settings, (click, n) => setLit({ beat: click.beat, kind: click.kind, n }))
    setRunning(true)
  }
  const stop = () => {
    engine.current?.stop()
    engine.current = null
    setRunning(false)
    setLit(null)
  }
  const toggle = () => (engine.current ? stop() : void start())

  // Stopped when the panel closes.
  useEffect(() => () => engine.current?.stop(), [])

  usePanelKey('Space', (e) => {
    if (!e.repeat) toggle()
  })

  const tapper = useRef(new TapTempo())
  const nudge = (by: number) => set({ bpm: clampTempo(Math.round((state.bpm + by) * 10) / 10) })

  return (
    <div className="metronome">
      <div className="metronome-top">
        <button
          type="button"
          className={`metronome-go${running ? ' on' : ''}`}
          aria-pressed={running}
          onClick={toggle}
          title="Start or stop (Space, while this panel has the focus)"
        >
          {running ? 'Stop' : waking ? 'Starting…' : 'Start'}
        </button>
        <div className="metronome-tempo">
          <button type="button" aria-label="5 slower" onClick={() => nudge(-5)}>
            −5
          </button>
          <button type="button" aria-label="1 slower" onClick={() => nudge(-1)}>
            −1
          </button>
          <NumberField
            className="metronome-bpm"
            value={state.bpm}
            min={TEMPO_MIN}
            max={TEMPO_MAX}
            step={0.1}
            label="Tempo, quarter notes a minute"
            onChange={(bpm) => set({ bpm })}
          />
          <button type="button" aria-label="1 faster" onClick={() => nudge(1)}>
            +1
          </button>
          <button type="button" aria-label="5 faster" onClick={() => nudge(5)}>
            +5
          </button>
          <button
            type="button"
            className="metronome-tap"
            title="Tap the tempo in"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              const r = tapper.current.tap(e.timeStamp / 1000)
              if (r && r.taps >= 3) set({ bpm: clampTempo(Math.round(r.bpm * 10) / 10) })
            }}
          >
            Tap
          </button>
        </div>
      </div>

      <div className="metronome-lamps" aria-hidden="true">
        {Array.from({ length: state.beats }, (_, b) => (
          <span
            key={b}
            className={`metronome-lamp${lit && lit.beat === b ? (lit.kind === 'sub' ? ' sub' : ' on') : ''}${b === 0 && state.accent ? ' first' : ''}`}
            data-n={lit && lit.beat === b ? lit.n % 2 : undefined}
          />
        ))}
      </div>
      {failed && <p className="metronome-note">The audio device would not start: see Edit, Audio settings.</p>}

      <div className="timing-row">
        <div className="timing-field">
          <span>Time</span>
          <span className="timing-sig">
            <NumberField value={state.beats} min={1} max={32} label="Beats in a bar" onChange={(beats) => set({ beats })} />
            <span aria-hidden="true">/</span>
            <select value={state.unit} aria-label="Note a beat is" onChange={(e) => set({ unit: Number(e.target.value) })}>
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </span>
        </div>
        <label className="timing-field">
          <span>Clicks</span>
          <select value={state.subdivision} onChange={(e) => set({ subdivision: Number(e.target.value) })}>
            {SUBDIVISIONS.map(([n, label]) => (
              <option key={n} value={n}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="timing-field">
          <span>Sound</span>
          <select value={state.sound} onChange={(e) => set({ sound: e.target.value as ClickSound })}>
            {SOUNDS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="timing-row">
        <label className="metronome-check">
          <input type="checkbox" checked={state.accent} onChange={(e) => set({ accent: e.target.checked })} />
          Accent the first beat
        </label>
        <label className="metronome-volume">
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={state.volume}
            aria-label="Volume"
            onChange={(e) => set({ volume: Number(e.target.value) })}
          />
        </label>
        <button
          type="button"
          className="timing-song"
          title="The tempo and time signature the song starts with"
          onClick={() => set({ bpm: props.song.tempo, beats: props.song.meter?.beats ?? 4, unit: props.song.meter?.unit ?? 4 })}
        >
          Use song's
        </button>
      </div>
    </div>
  )
}

function clampTempo(bpm: number) {
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, bpm))
}

/**
 * The click itself: a scheduler a little ahead of the audio clock, and a
 * lamp loop a frame at a time that lights each click as it is heard.
 */
function run(
  ctx: AudioContext,
  settings: { current: MetronomeSettings & { sound: ClickSound; volume: number } },
  onHeard: (click: Click, n: number) => void,
): { stop: () => void } {
  const out = ctx.createGain()
  out.connect(ctx.destination)
  const counter = new ClickCounter(ctx.currentTime + LEAD_IN)
  const pending: Click[] = []
  let heard = 0

  const schedule = () => {
    const s = settings.current
    out.gain.value = s.volume
    const ahead = document.hidden ? AHEAD_HIDDEN : AHEAD
    for (const click of counter.until(ctx.currentTime + ahead, s)) {
      sound(ctx, out, click, s.sound)
      pending.push(click)
    }
  }
  schedule()
  const timer = window.setInterval(schedule, LOOK_MS)

  // What is coming out of the speakers now, on the audio clock: the context's
  // own answer where it has one, which takes the output latency into account.
  const nowHeard = () => {
    const stamp = ctx.getOutputTimestamp?.()
    if (stamp?.contextTime !== undefined && stamp.performanceTime !== undefined) {
      return stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000
    }
    return ctx.currentTime - (ctx.outputLatency || 0)
  }
  let frame = requestAnimationFrame(function light() {
    const now = nowHeard()
    let last: Click | null = null
    while (pending.length && pending[0].time <= now) last = pending.shift()!
    if (last) onHeard(last, ++heard)
    frame = requestAnimationFrame(light)
  })

  return {
    stop() {
      window.clearInterval(timer)
      cancelAnimationFrame(frame)
      // Anything already scheduled is cut rather than left to sound.
      out.gain.cancelScheduledValues(ctx.currentTime)
      out.gain.setValueAtTime(0, ctx.currentTime)
      setTimeout(() => out.disconnect(), 300)
    },
  }
}

/** One click: a short sine with a fast decay, pitched and weighted by its kind. */
function sound(ctx: AudioContext, out: AudioNode, click: Click, kind: ClickSound) {
  const [hz, length, level] = CLICK_SOUNDS[kind][click.kind]
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = kind === 'wood' ? 'triangle' : 'sine'
  osc.frequency.value = hz
  const t = click.time
  env.gain.setValueAtTime(0, t)
  env.gain.linearRampToValueAtTime(level, t + 0.001)
  env.gain.exponentialRampToValueAtTime(0.0001, t + length)
  osc.connect(env)
  env.connect(out)
  osc.start(t)
  osc.stop(t + length + 0.01)
  osc.onended = () => env.disconnect()
}
