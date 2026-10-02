import { useEffect, useRef, useState } from 'react'
import { loadPrefs, savePrefs, type PitchPrefs } from '../../patch/storage'
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
import { NumberField } from '../NumberField'

const HARMONICS = 12
/** How long the play button sounds a pitch, in seconds. */
const TONE_S = 1.2

function initial(): PitchPrefs {
  return { input: 'A4', a4: DEFAULT_A4, transpose: 7, ...loadPrefs().pitch }
}

const cents = (c: number) => (c === 0 ? '' : ` ${c > 0 ? '+' : '−'}${Math.abs(c)}¢`)

/**
 * The Notes & frequencies utility: a note to its frequency and back.
 *
 * Type a note, a MIDI number or a frequency, and it says all three -- a
 * frequency as the nearest note and how far off it is, which is how a knob
 * set in hertz is tuned to the song. Around that: the twelve notes of its
 * octave, its harmonics with the note each one is nearest (what a Resonator
 * or a Formant brings out), and a transposition, as the ratio a Sampler's
 * Speed plays at. The reference A is adjustable for music tuned elsewhere.
 * Any value copies with a click; the button beside the answer plays it.
 */
export function PitchUtility({ audio }: UtilityProps) {
  const [state, setState] = useState<PitchPrefs>(initial)
  useEffect(() => savePrefs({ pitch: state }), [state])
  const set = (change: Partial<PitchPrefs>) => setState((s) => ({ ...s, ...change }))
  const [draft, setDraft] = useState<string | null>(null)

  const pitch = parsePitch(state.input, state.a4)
  const note = pitch ? nearest(pitch.midi) : null
  const octaveStart = note ? Math.floor(note.midi / 12) * 12 : 0
  const moved = pitch ? pitch.midi + state.transpose : 0

  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
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
  const value = (text: string, what: string, className = '') => (
    <button type="button" className={`timing-copy ${className}`} title={`${what}: ${text}. Click to copy.`} onClick={() => copy(text, what)}>
      {text}
    </button>
  )

  const play = async (hz: number) => {
    const ctx = await audio()
    if (!ctx) return
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.frequency.value = hz
    const t = ctx.currentTime + 0.02
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(0.25, t + 0.02)
    env.gain.setValueAtTime(0.25, t + TONE_S - 0.15)
    env.gain.linearRampToValueAtTime(0, t + TONE_S)
    osc.connect(env)
    env.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + TONE_S + 0.02)
    osc.onended = () => env.disconnect()
  }

  const commit = (text: string) => {
    setDraft(null)
    if (parsePitch(text, state.a4)) set({ input: text.trim() })
  }

  return (
    <div className="pitch">
      <div className="timing-row">
        <label className="timing-field pitch-input">
          <span>Note or frequency</span>
          <input
            type="text"
            value={draft ?? state.input}
            className={draft !== null && !parsePitch(draft, state.a4) ? 'invalid' : ''}
            placeholder="A4, C#3, 261.6 Hz, MIDI 60"
            aria-label="A note, a MIDI number or a frequency"
            title="A note (A4, C#3, Bb2), a MIDI number (60), or a frequency (440 Hz, 1.2 kHz)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value)
              else if (e.key === 'Escape' && draft !== null) {
                e.stopPropagation()
                setDraft(null)
              }
            }}
            onBlur={(e) => {
              if (draft !== null) commit(e.currentTarget.value)
            }}
          />
        </label>
        <label className="timing-field">
          <span>A4 is</span>
          <NumberField value={state.a4} min={A4_MIN} max={A4_MAX} step={0.1} label="Reference A, in hertz" onChange={(a4) => set({ a4 })} />
        </label>
      </div>

      {pitch && note && (
        <>
          <div className="pitch-answer">
            <div className="pitch-main">
              <strong>
                {note.name}
                <span className="pitch-cents">{cents(note.cents)}</span>
              </strong>
              <button type="button" className="pitch-play" aria-label={`Play ${formatHz(pitch.hz)} Hz`} title="Play it" onClick={() => void play(pitch.hz)}>
                ▶
              </button>
            </div>
            <dl className="pitch-facts">
              <dt>Frequency</dt>
              <dd>{value(formatHz(pitch.hz), 'Hz')} Hz</dd>
              <dt>MIDI</dt>
              <dd>{value(String(Number(pitch.midi.toFixed(2))), 'MIDI note')}</dd>
              <dt>Period</dt>
              <dd>{value(String(Number((1000 / pitch.hz).toFixed(4))), 'period in ms')} ms</dd>
              <dt>In tune</dt>
              <dd>
                {value(formatHz(midiToHz(note.midi, state.a4)), `${note.name} in Hz`)} Hz
              </dd>
            </dl>
          </div>

          <div className="pitch-section">
            <h3>Octave {Math.floor(note.midi / 12) - 1}</h3>
            <div className="pitch-octave">
              {Array.from({ length: 12 }, (_, k) => {
                const m = octaveStart + k
                const hz = midiToHz(m, state.a4)
                return (
                  <button
                    key={m}
                    type="button"
                    className={`pitch-key${m === note.midi ? ' on' : ''}${midiName(m).includes('#') ? ' black' : ''}`}
                    title={`${midiName(m)}: ${formatHz(hz)} Hz. Click to look at it.`}
                    onClick={() => set({ input: midiName(m) })}
                  >
                    <span>{midiName(m)}</span>
                    <span className="timing-dim">{formatHz(hz)}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="pitch-section">
            <h3>Transpose</h3>
            <div className="pitch-transpose">
              <NumberField value={state.transpose} min={-48} max={48} label="Semitones" onChange={(transpose) => set({ transpose })} />
              <span className="timing-dim">semitones</span>
              <span>→ {midiName(moved)}{cents(nearest(moved).cents)}</span>
              {value(formatHz(midiToHz(moved, state.a4)), 'transposed Hz')}
              <span className="timing-dim">Hz · Speed ×</span>
              {value(String(Number(semitoneRatio(state.transpose).toFixed(5))), 'speed ratio')}
            </div>
          </div>

          <div className="pitch-section">
            <h3>Harmonics</h3>
            <table className="timing-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Hz</th>
                  <th scope="col">Nearest note</th>
                </tr>
              </thead>
              <tbody>
                {harmonics(pitch.hz, HARMONICS, state.a4).map((h) => (
                  <tr key={h.n}>
                    <th scope="row">{h.n}</th>
                    <td className="timing-num">{value(formatHz(h.hz), `harmonic ${h.n}`)}</td>
                    <td className="timing-num">
                      {h.name}
                      <span className="timing-dim">{cents(h.cents)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!pitch && <p className="timing-dim">Not a note or a frequency this can read.</p>}
      <p className="timing-dim timing-status" aria-live="polite">
        {copied ?? 'Click a value to copy it.'}
      </p>
    </div>
  )
}
