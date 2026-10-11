import { useEffect, useRef, useState } from 'react'
import { loadPrefs, savePrefs, type MetronomePrefs } from '../../patch/storage'
import { TEMPO_MAX, TEMPO_MIN } from '../../song/types'
import type { UtilityProps } from '../../utilities'
import { CLICK_SOUNDS, ClickCounter, type Click, type ClickSound, type MetronomeSettings } from '../../utilities/metronome'
import { TapTempo } from '../../utilities/timing'
import type { ParamSpec } from '../../patch/param'
import { Knob } from '../Knob'
import { JogWheel } from '../bench/JogWheel'
import { Segments } from '../bench/Segments'
import { SlideSwitch } from '../bench/SlideSwitch'
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
/** The Clicks selector's positions: clicks a beat, its name, and the mark the glass shows for it. */
const SUBDIVISIONS = [
  [1, 'Beats', '♩'],
  [2, '2 per beat', '♫'],
  [3, 'Triplets', '♫³'],
  [4, '4 per beat', '♬'],
] as const
const SOUNDS = [
  ['click', 'Click'],
  ['wood', 'Wood'],
  ['beep', 'Beep'],
] as const satisfies readonly (readonly [ClickSound, string])[]

const BEATS: ParamSpec = { id: 'beats', label: 'Beats', min: 1, max: 32, default: 4, unit: '#', curve: 'lin' }
const NOTE: ParamSpec = { id: 'unit', label: 'Note', min: 0, max: UNITS.length - 1, default: 2, unit: '', curve: 'lin', steps: UNITS.map(String) }
const CLICKS: ParamSpec = { id: 'clicks', label: 'Clicks', min: 0, max: SUBDIVISIONS.length - 1, default: 0, unit: '', curve: 'lin', steps: SUBDIVISIONS.map(([, name]) => name) }
const VOLUME: ParamSpec = { id: 'volume', label: 'Volume', min: 0, max: 1, default: 0.7, unit: '', curve: 'lin' }

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
  /** The tempo being typed into the glass, or null while it is only shown. */
  const [entry, setEntry] = useState<string | null>(null)
  const commitEntry = (text: string) => {
    const bpm = Number(text.trim())
    setEntry(null)
    if (text.trim() !== '' && Number.isFinite(bpm)) set({ bpm: clampTempo(Math.round(bpm * 10) / 10) })
  }

  const subdivision = Math.max(0, SUBDIVISIONS.findIndex(([n]) => n === state.subdivision))
  const unitAt = Math.max(0, UNITS.indexOf(state.unit))
  const bpmText = state.bpm.toFixed(1)

  return (
    <div className="metronome">
      {/* The beat lamps, on the case over the glass: one a beat, the first a
          colour of its own while it is accented. */}
      <div className="metro-leds" aria-hidden="true">
        {Array.from({ length: state.beats }, (_, b) => (
          <span
            key={b}
            className={`metronome-lamp${lit && lit.beat === b ? (lit.kind === 'sub' ? ' sub' : ' on') : ''}${b === 0 && state.accent ? ' first' : ''}`}
            data-n={lit && lit.beat === b ? lit.n % 2 : undefined}
          />
        ))}
      </div>

      <div className="bench-glass lcd metro-lcd">
        <div className="metro-lcd-main">
          <div className="metro-lcd-beat">
            <Segments text={lit ? String(lit.beat + 1) : ''} digits={2} size={30} points={false} />
            <span className="annun on">Beat</span>
          </div>

          <div className="metro-lcd-tempo">
            {entry === null ? (
              <button
                type="button"
                className="glass-read metronome-bpm"
                title="The tempo, in quarter notes a minute. Click to type it."
                onClick={() => setEntry(bpmText)}
              >
                <Segments text={bpmText} digits={4} size={46} />
              </button>
            ) : (
              <input
                className="metronome-bpm-entry"
                autoFocus
                value={entry}
                aria-label="Tempo, quarter notes a minute"
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setEntry(e.target.value)}
                onBlur={(e) => commitEntry(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEntry(e.currentTarget.value)
                  else if (e.key === 'Escape') {
                    e.stopPropagation()
                    setEntry(null)
                  }
                }}
              />
            )}
            <span className="annun on">BPM</span>
          </div>

          <div className="metro-lcd-time" aria-label={`Time signature ${state.beats}/${state.unit}`}>
            <span className="metro-lcd-sig" aria-hidden="true">
              <Segments text={String(state.beats)} size={22} points={false} spoken={false} />
              <i className="metro-lcd-slash" />
              <Segments text={String(state.unit)} size={22} points={false} spoken={false} />
            </span>
            <span className="annun on">Time</span>
          </div>
        </div>

        {/* The status line along the foot of the glass: every mark printed,
            the ones that apply dark. */}
        <div className="metro-lcd-status" aria-hidden="true">
          <span className="metro-lcd-marks">
            {SUBDIVISIONS.map(([n, name, mark]) => (
              <span key={n} className={`annun mark${n === state.subdivision ? ' on' : ''}`} title={name}>
                {mark}
              </span>
            ))}
          </span>
          <span className="metro-lcd-marks">
            {SOUNDS.map(([id, name]) => (
              <span key={id} className={`annun${id === state.sound ? ' on' : ''}`}>
                {name}
              </span>
            ))}
          </span>
          <span className={`annun${state.accent ? ' on' : ''}`}>Accent</span>
          <span className={`annun${running ? ' on' : ''}`}>▶ Run</span>
        </div>
      </div>

      <div className="metro-jog">
        <JogWheel
          label="Tempo"
          value={state.bpm}
          min={TEMPO_MIN}
          max={TEMPO_MAX}
          step={1}
          coarse={5}
          valueText={`${bpmText} BPM`}
          onChange={(bpm) => set({ bpm })}
        />
        <span className="bench-legend">Tempo</span>
      </div>

      <div className="metro-panel">
        <Knob spec={BEATS} value={state.beats} step={1} format={(v) => String(Math.round(v))} onChange={(beats) => set({ beats: Math.round(beats) })} />
        <Knob spec={NOTE} value={unitAt} step={1} onChange={(i) => set({ unit: UNITS[Math.round(i)] })} />
        <Knob spec={CLICKS} value={subdivision} step={1} onChange={(i) => set({ subdivision: SUBDIVISIONS[Math.round(i)][0] })} />
        <div className="metro-sound">
          <SlideSwitch label="Sound" options={SOUNDS} value={state.sound} onChange={(sound) => set({ sound })} />
          <span className="bench-legend">Sound</span>
        </div>
        <Knob spec={VOLUME} value={state.volume} format={(v) => `${Math.round(v * 100)}%`} onChange={(volume) => set({ volume })} />
        <div className="metro-latches">
          <button
            type="button"
            className={`bench-button small metro-accent${state.accent ? ' on' : ''}`}
            aria-pressed={state.accent}
            title="A different click on the first beat of each bar"
            onClick={() => set({ accent: !state.accent })}
          >
            <span className="bench-lamp" />
            Accent
          </button>
          <button
            type="button"
            className="bench-button small metro-song"
            title="The tempo and time signature the song starts with"
            onClick={() => set({ bpm: props.song.tempo, beats: props.song.meter?.beats ?? 4, unit: props.song.meter?.unit ?? 4 })}
          >
            From song
          </button>
        </div>
      </div>

      <div className="metro-transport">
        <button
          type="button"
          className={`bench-button metronome-go${running ? ' on' : ''}`}
          aria-pressed={running}
          onClick={toggle}
          title="Start or stop (Space, while this panel has the focus)"
        >
          <span className="bench-lamp" />
          <span className="metronome-go-text">{running ? 'Stop' : waking ? 'Starting…' : 'Start'}</span>
        </button>
        <button
          type="button"
          className="metro-tap"
          title="Tap the tempo in: three taps or more"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            const r = tapper.current.tap(e.timeStamp / 1000)
            if (r && r.taps >= 3) set({ bpm: clampTempo(Math.round(r.bpm * 10) / 10) })
          }}
        >
          Tap
        </button>
      </div>

      {failed && <p className="metronome-note">The audio device would not start: see Edit, Audio settings.</p>}
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
