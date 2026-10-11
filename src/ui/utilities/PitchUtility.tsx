import { useEffect, useRef, useState } from 'react'
import { loadPrefs, savePrefs, type PitchPrefs } from '../../patch/storage'
import type { ParamSpec } from '../../patch/param'
import type { UtilityProps } from '../../utilities'
import {
  A4_MAX,
  A4_MIN,
  DEFAULT_A4,
  formatHz,
  harmonics,
  midiToHz,
  nearest,
  parsePitch,
  semitoneRatio,
} from '../../utilities/pitch'
import { midiName } from '../../song/tuning'
import { Knob } from '../Knob'
import { Segments } from '../bench/Segments'
import { LedLadder } from '../bench/LedLadder'

const HARMONICS = 12
/** The shortest a key sounds, in seconds, however quickly it is let go. */
const TAP_S = 0.15
/** How long a key pressed from the keyboard sounds, since it has no release to wait for. */
const KEY_S = 1.2

const REF: ParamSpec = { id: 'a4', label: 'Ref A4', min: A4_MIN, max: A4_MAX, default: DEFAULT_A4, unit: 'Hz', curve: 'lin' }
const TRANSPOSE: ParamSpec = { id: 'transpose', label: 'Transpose', min: -48, max: 48, default: 0, unit: 'st', curve: 'lin' }
/** MIDI's octaves, C-1 to G9. */
const OCTAVE: ParamSpec = { id: 'octave', label: 'Octave', min: -1, max: 9, default: 4, unit: 'oct', curve: 'lin' }
/**
 * The main knob, over the whole MIDI range and in semitones, so equal turns
 * are equal intervals. It lands anywhere, cents and all, as a tuner's
 * reference does; typing into its readout is how an exact pitch goes in.
 */
const TUNE: ParamSpec = { id: 'tune', label: 'Tune', min: 0, max: 127, default: 69, unit: 'note', curve: 'lin' }
const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)} st`

/** The keys of one octave, C to B, and where each black one sits over the whites. */
const WHITE = [0, 2, 4, 5, 7, 9, 11]
const BLACK: [number, number][] = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]]

function initial(): PitchPrefs {
  return { input: 'A4', a4: DEFAULT_A4, transpose: 7, ...loadPrefs().pitch }
}

const centsText = (c: number) => (c === 0 ? 'in tune' : `${c > 0 ? '+' : '−'}${Math.abs(c)}¢`)

/**
 * The Notes & frequencies utility: a note to its frequency and back, as a
 * piece of bench gear -- a tuner and a frequency counter in one case.
 *
 * Turn the Tune knob, or type a note, a MIDI number or a frequency into its
 * readout, and the glass says all of it: the nearest note and how far off it is, on a row of lamps
 * the way an LED tuner shows it; the frequency on the counter; and the MIDI
 * number, the period and the in-tune frequency underneath. Around that: a
 * keyboard of the octave it is in, a Transpose knob that says where a
 * transposition lands and the speed a Sampler plays it at, and the first
 * twelve harmonics as columns of lamps, each leaning the way its nearest
 * note is off. The Ref knob is the calibration trim, for music tuned away
 * from 440. Any reading copies with a click. The keys play while held: the
 * lit one sounds the pitch exactly, any other moves there and sounds its note.
 */
export function PitchUtility({ audio }: UtilityProps) {
  const [state, setState] = useState<PitchPrefs>(initial)
  useEffect(() => savePrefs({ pitch: state }), [state])
  const set = (change: Partial<PitchPrefs>) => setState((s) => ({ ...s, ...change }))
  const [partial, setPartial] = useState(1)
  /** The key being held down, which is the one sounding. */
  const [held, setHeld] = useState<number | null>(null)

  const pitch = parsePitch(state.input, state.a4)
  const note = pitch ? nearest(pitch.midi) : null
  const octaveStart = note ? Math.floor(note.midi / 12) * 12 : 0
  const moved = pitch ? pitch.midi + state.transpose : 0

  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      release()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(`Copied ${text} (${what})`)
    } catch {
      setCopied(`${what}: ${text}`)
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 2500)
  }

  /**
   * The one tone the keyboard plays: started when a key goes down, faded out
   * when it comes up. `down` stays true from the press to the release, and a
   * release that arrives before the audio context does -- a quick tap on the
   * first press -- still gets its short note rather than a stuck one.
   */
  const voice = useRef<{ osc: OscillatorNode; env: GainNode; ctx: AudioContext; from: number } | null>(null)
  const down = useRef(false)

  const release = () => {
    down.current = false
    const v = voice.current
    voice.current = null
    setHeld(null)
    if (!v) return
    const t = Math.max(v.ctx.currentTime, v.from + TAP_S)
    v.env.gain.cancelScheduledValues(t)
    v.env.gain.setValueAtTime(0.25, t)
    v.env.gain.linearRampToValueAtTime(0, t + 0.08)
    v.osc.stop(t + 0.1)
  }

  const sound = async (hz: number, key: number, length?: number) => {
    release()
    down.current = true
    setHeld(key)
    const ctx = await audio()
    if (!ctx) return
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.frequency.value = hz
    const t = ctx.currentTime + 0.02
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(0.25, t + 0.02)
    osc.connect(env)
    env.connect(ctx.destination)
    osc.start(t)
    osc.onended = () => env.disconnect()
    const mine = { osc, env, ctx, from: t }
    voice.current = mine
    // Only this note: a key pressed since has a voice of its own.
    if (length !== undefined) setTimeout(() => voice.current === mine && release(), length * 1000)
    else if (!down.current) release()
  }

  /**
   * A key pressed. The lit key is the pitch being looked at, so it sounds
   * exactly that -- 443 Hz, cents and all -- and leaves it be; any other key
   * moves there and sounds its note in tune.
   */
  const press = (midi: number, length?: number) => {
    if (!pitch || !note) return
    let hz = pitch.hz
    if (midi !== note.midi) {
      set({ input: midiName(midi) })
      hz = midiToHz(midi, state.a4)
    }
    void sound(hz, midi, length)
  }

  /**
   * Where the Tune knob was turned or typed to. A whole note is kept as its
   * name and anything between notes as its frequency, so the Octave knob and
   * the Ref trim treat it as they would have treated it typed.
   */
  const tune = (midi: number) => {
    const next = Number.isInteger(midi) ? midiName(midi) : `${formatHz(midiToHz(midi, state.a4))} Hz`
    if (parsePitch(next, state.a4)) set({ input: next })
  }
  const tuneText = (midi: number) => {
    const n = nearest(midi)
    const c = Math.round(n.cents)
    return c === 0 ? n.name : `${n.name} ${c > 0 ? '+' : '−'}${Math.abs(c)}¢`
  }

  /** The octave the nearest note is in, as the Octave knob shows it. */
  const octaveNow = note ? Math.floor(note.midi / 12) - 1 : OCTAVE.default
  /**
   * The same pitch in another octave. A note stays a note; a frequency that
   * is not one stays a frequency, so 443 Hz goes to 886 Hz rather than to A5.
   */
  const toOctave = (to: number) => {
    const by = Math.round(to) - octaveNow
    if (!pitch || by === 0) return
    const next = Number.isInteger(pitch.midi) ? midiName(pitch.midi + by * 12) : `${formatHz(pitch.hz * 2 ** by)} Hz`
    if (parsePitch(next, state.a4)) set({ input: next })
  }

  const parts = pitch ? harmonics(pitch.hz, HARMONICS, state.a4) : []
  const shown = parts[partial - 1]

  return (
    <div className="pitch">
      <div className="bench-glass vfd pitch-display">
        {pitch && note ? (
          <>
            <div className="pitch-top">
              <button
                type="button"
                className="pitch-main glass-read"
                title={`${note.name}. Click to copy.`}
                onClick={() => copy(note.name, 'note')}
              >
                <NoteReading midi={note.midi} size={58} />
              </button>
              <div className="pitch-tuner">
                <div className="pitch-cents">
                  <span className={`annun${note.cents < 0 ? ' on' : ''}`}>Flat</span>
                  <Segments text={Math.abs(note.cents).toFixed(1)} digits={4} size={22} />
                  <span className="annun on">¢</span>
                  <span className={`annun${note.cents > 0 ? ' on' : ''}`}>Sharp</span>
                  <span className="visually-hidden">{centsText(note.cents)}</span>
                </div>
                <LedLadder cents={note.cents} />
                <div className="glass-scale" aria-hidden="true">
                  <span>−50</span>
                  <span>0</span>
                  <span>+50</span>
                </div>
              </div>
            </div>

            {/* The counter, with the MIDI number, the period and the note in tune
                in the room to its right. Six cells, as the highest note the
                Tune knob reaches is 12543.9 Hz. */}
            <div className="pitch-mid">
              <button
                type="button"
                className="pitch-freq glass-read"
                title={`${formatHz(pitch.hz)} Hz. Click to copy.`}
                onClick={() => copy(formatHz(pitch.hz), 'Hz')}
              >
                <Segments text={formatHz(pitch.hz)} digits={6} size={34} />
                <span className="annun on">Hz</span>
              </button>
              <div className="pitch-mid-facts">
                <Reading label="MIDI" text={String(Number(pitch.midi.toFixed(2)))} what="MIDI note" copy={copy} />
                <Reading label="Period ms" text={String(Number((1000 / pitch.hz).toFixed(4)))} what="period in ms" copy={copy} />
                <Reading
                  label="In tune"
                  text={formatHz(midiToHz(note.midi, state.a4))}
                  what={`${note.name} in Hz`}
                  copy={copy}
                />
              </div>
            </div>

            {/* Along the foot: where a transposition lands -- its note, its
                frequency and the Sampler speed for it. */}
            <div className="pitch-facts">
              <div className="pitch-moved">
                <span className="annun on pitch-moved-legend">Transposed {signed(state.transpose)}</span>
                <button type="button" className="glass-read pitch-moved-note" title={`${midiName(moved)}. Click to copy.`} onClick={() => copy(midiName(moved), 'transposed note')}>
                  <NoteReading midi={nearest(moved).midi} size={22} />
                </button>
                <Reading label="Hz" text={formatHz(midiToHz(moved, state.a4))} what="transposed Hz" copy={copy} quiet size={14} />
                <Reading label="Speed ×" text={String(Number(semitoneRatio(state.transpose).toFixed(5)))} what="speed ratio" copy={copy} quiet size={14} />
              </div>
            </div>
          </>
        ) : (
          <div className="pitch-error">
            <Segments text="Err" size={34} points={false} />
            <span className="annun on">Not a note or a frequency this can read</span>
          </div>
        )}
      </div>

      <div className="pitch-play">
        <div className="bench-row pitch-controls">
          <div className="pitch-tune">
            <Knob
              spec={TUNE}
              value={pitch ? Math.min(TUNE.max, Math.max(TUNE.min, pitch.midi)) : TUNE.default}
              format={tuneText}
              parse={(text) => parsePitch(text, state.a4)?.midi ?? null}
              onChange={tune}
            />
          </div>
          <div className="pitch-ref">
            <Knob spec={REF} value={state.a4} step={0.1} format={(v) => `${Number(v.toFixed(1))} Hz`} onChange={(a4) => set({ a4 })} />
          </div>
          {/* Detented like a range switch: one click is one octave, and the
              keyboard beside it follows it. */}
          <div className="pitch-oct">
            <Knob spec={OCTAVE} value={octaveNow} step={1} format={(v) => String(Math.round(v))} onChange={toOctave} />
          </div>
          <div className="pitch-shift">
            <Knob spec={TRANSPOSE} value={state.transpose} step={1} format={signed} onChange={(transpose) => set({ transpose })} />
          </div>
        </div>
        {pitch && note && (
          <section className="bench-section pitch-octave">
            <div className="pitch-keys">
              {WHITE.map((k, i) => (
                <Key key={k} midi={octaveStart + k} on={octaveStart + k === note.midi} a4={state.a4} style={{ left: `${(i / 7) * 100}%` }} held={held === octaveStart + k} onPress={press} onRelease={release} />
              ))}
              {BLACK.map(([k, after]) => (
                <Key key={k} black midi={octaveStart + k} on={octaveStart + k === note.midi} a4={state.a4} style={{ left: `${(after / 7) * 100}%` }} held={held === octaveStart + k} onPress={press} onRelease={release} />
              ))}
            </div>
          </section>
        )}
      </div>

      {pitch && note && (
        <>
          <section className="bench-section pitch-harmonics-section">
            <div className="bench-glass vfd pitch-harmonics">
              {/* The chosen harmonic's reading across the top, as a meter's
                  readout sits over its scale. */}
              {shown && (
                <div className="pitch-partial-read">
                  <span className="annun on">H{shown.n}</span>
                  <Reading label="Hz" text={formatHz(shown.hz)} what={`harmonic ${shown.n}`} copy={copy} quiet />
                  <button type="button" className="glass-read" title={`${shown.name}. Click to copy.`} onClick={() => copy(shown.name, `harmonic ${shown.n}'s note`)}>
                    <NoteReading midi={shown.midi} size={22} />
                  </button>
                  <span className="annun on">{centsText(shown.cents)}</span>
                </div>
              )}
              <div className="pitch-partials-meter">
                {/* Printed down the side of the glass: which way is sharp,
                    and how far the last lamp is. */}
                <div className="glass-scale vertical" aria-hidden="true">
                  <span>♯ +50</span>
                  <span>0</span>
                  <span>♭ −50</span>
                </div>
                <div className="pitch-partials" role="group" aria-label="Harmonics">
                  {parts.map((h) => (
                    <button
                      key={h.n}
                      type="button"
                      className={`pitch-partial${h.n === partial ? ' on' : ''}`}
                      aria-pressed={h.n === partial}
                      aria-label={`Harmonic ${h.n}: ${formatHz(h.hz)} Hz, ${h.name} ${centsText(h.cents)}`}
                      title={`Harmonic ${h.n}: ${formatHz(h.hz)} Hz, ${h.name} ${centsText(h.cents)}`}
                      onClick={() => setPartial(h.n)}
                    >
                      <LedLadder cents={h.cents} vertical />
                      <span className="pitch-partial-n">{h.n}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {/* Nothing on the case says a copy happened -- the readings say they
          copy when pointed at -- but a screen reader is still told. */}
      <p className="visually-hidden" aria-live="polite">
        {copied ?? ''}
      </p>
    </div>
  )
}

/**
 * A note as a tuner's glass shows it: the letter large, the octave beside it,
 * and the sharp as a lamp of its own above the octave, since a seven-segment
 * cell has no way to draw one.
 */
function NoteReading({ midi, size }: { midi: number; size: number }) {
  const name = midiName(midi)
  const sharp = name.includes('#')
  const letter = name[0]
  const octave = name.slice(sharp ? 2 : 1)
  return (
    <span className="note-reading">
      <span className="visually-hidden">{name}</span>
      <span aria-hidden="true" className="note-reading-glass">
        <Segments text={letter} size={size} points={false} spoken={false} />
        <span className="note-reading-side" style={{ fontSize: size * 0.32 }}>
          <span className={`annun sharp${sharp ? ' on' : ''}`}>♯</span>
          <Segments text={octave} size={size * 0.5} points={false} spoken={false} />
        </span>
      </span>
    </span>
  )
}

interface ReadingProps {
  label: string
  text: string
  what: string
  copy: (text: string, what: string) => void
  /** Set in a smaller glass, with the legend beside the digits rather than under them. */
  quiet?: boolean
  /** The digits' height, where the default does not fit. */
  size?: number
}

/** One number on the glass, with its legend printed on it; a click copies it. */
function Reading({ label, text, what, copy, quiet = false, size }: ReadingProps) {
  return (
    <button
      type="button"
      className={`glass-read reading${quiet ? ' quiet' : ''}`}
      title={`${what}: ${text}. Click to copy.`}
      onClick={() => copy(text, what)}
    >
      {quiet && <span className="annun on">{label}</span>}
      <Segments text={text} size={size ?? (quiet ? 18 : 17)} />
      {!quiet && <span className="annun on">{label}</span>}
    </button>
  )
}

interface KeyProps {
  midi: number
  black?: boolean
  /** The note being looked at, which has the lamp. */
  on: boolean
  /** Being held down, and sounding. */
  held: boolean
  a4: number
  style: React.CSSProperties
  /** Down: sounds until `onRelease`, or for `length` seconds when there is no release to wait for. */
  onPress: (midi: number, length?: number) => void
  onRelease: () => void
}

/**
 * One key: it sounds while it is held, as a key does. From the keyboard,
 * Enter or Space plays it for a moment instead, since a key held down on a
 * computer keyboard repeats rather than holds.
 */
function Key({ midi, black = false, on, held, a4, style, onPress, onRelease }: KeyProps) {
  const name = midiName(midi)
  return (
    <button
      type="button"
      className={`pitch-key${black ? ' black' : ''}${on ? ' on' : ''}${held ? ' held' : ''}`}
      data-note={name}
      style={style}
      aria-label={`${name}, ${formatHz(midiToHz(midi, a4))} Hz`}
      aria-pressed={on}
      title={on ? `${name}: plays the pitch above exactly` : `${name}: ${formatHz(midiToHz(midi, a4))} Hz`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        onPress(midi)
      }}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          // Not the rack's: Space is its transport everywhere else.
          e.preventDefault()
          e.stopPropagation()
          onPress(midi, KEY_S)
        }
      }}
    >
      {!black && <span className="pitch-key-name">{name[0]}</span>}
    </button>
  )
}
