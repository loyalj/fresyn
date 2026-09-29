import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  canChooseOutput,
  type AudioEngine,
  type AudioMeasure,
  type AudioSettings,
  type EngineStatus,
  type LatencyMode,
} from '../audio/AudioEngine'
import type { Transport } from '../audio/Transport'
import { loadPrefs, savePrefs } from '../patch/storage'

interface Props {
  engine: AudioEngine
  transport: Transport
  /** Passed in so the readout follows a rebuild as it happens. */
  status: EngineStatus
  onClose: () => void
}

const LATENCIES: { id: LatencyMode; name: string }[] = [
  { id: 'low', name: 'Low — for playing' },
  { id: 'balanced', name: 'Balanced' },
  { id: 'safe', name: 'Safe — for heavy songs' },
]

const RATES = [44100, 48000, 88200, 96000]

/** Where a custom buffer starts, and the bounds a typed one is held to. */
const CUSTOM_MS = 20
const MIN_MS = 3
const MAX_MS = 500

/** The pseudo-devices Chrome lists beside the real ones. Empty is our default. */
const ALIASES = new Set(['default', 'communications', ''])

const ms = (s: number) => `${Math.round(s * 1000)} ms`

/**
 * How this browser opens the sound card: which output, how much buffering,
 * at what rate. It is this machine's, so it is kept with the other
 * preferences and never in a project.
 *
 * Built like the library dialog, and for the same reason: every key is
 * captured on the window ahead of whatever holds focus, so `App` stands its
 * bindings down while this is open.
 */
export function AudioSettingsDialog({ engine, transport, status, onClose }: Props) {
  const [settings, setSettings] = useState<AudioSettings>(() => loadPrefs().audio ?? {})
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [measure, setMeasure] = useState<AudioMeasure | null>(() => engine.measure())
  const [problem, setProblem] = useState<string | null>(null)
  const custom = typeof settings.latency === 'number'
  const [draftMs, setDraftMs] = useState(String(custom ? settings.latency : CUSTOM_MS))
  const sheet = useRef<HTMLDivElement>(null)

  const apply = (next: AudioSettings) => {
    // A new context counts its samples from 0 again; a song still playing
    // would be scheduled against a clock that no longer exists.
    if (engine.wouldRebuild(next)) transport.stop()
    setSettings(next)
    savePrefs({ audio: next })
    setProblem(null)
    void engine.configure(next).then(setProblem)
  }

  const listOutputs = useCallback(async () => {
    if (!canChooseOutput || !navigator.mediaDevices?.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setOutputs(all.filter((d) => d.kind === 'audiooutput' && !ALIASES.has(d.deviceId)))
    } catch {
      setOutputs([])
    }
  }, [])

  useEffect(() => {
    void listOutputs()
    const devices = navigator.mediaDevices
    if (!canChooseOutput || !devices) return
    devices.addEventListener('devicechange', listOutputs)
    return () => devices.removeEventListener('devicechange', listOutputs)
  }, [listOutputs])

  // The output figure settles over the first second or so of a device, and
  // changes when one is swapped, so it is read again rather than once.
  useEffect(() => {
    setMeasure(engine.measure())
    const timer = setInterval(() => setMeasure(engine.measure()), 500)
    return () => clearInterval(timer)
  }, [engine, status])

  /**
   * Browsers keep output names hidden until the page has been allowed a
   * microphone, so that a page cannot fingerprint the hardware for free.
   * Asked only when someone presses for it, and the stream is let go at once.
   */
  const revealNames = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
    } catch {
      setProblem('Without microphone permission the browser keeps the outputs’ names hidden.')
      return
    }
    await listOutputs()
  }

  const commitCustom = () => {
    const typed = Number(draftMs)
    if (!Number.isFinite(typed)) {
      setDraftMs(String(custom ? settings.latency : CUSTOM_MS))
      return
    }
    const clamped = Math.min(MAX_MS, Math.max(MIN_MS, Math.round(typed)))
    setDraftMs(String(clamped))
    if (settings.latency !== clamped) apply({ ...settings, latency: clamped })
  }

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheet.current?.querySelector<HTMLElement>('select, input, button:not(.sheet-close)')?.focus()
    return () => restore?.focus()
  }, [])

  // Captured, because the app's own input layer is standing down and nothing
  // else would hear Escape.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Tab' && sheet.current) {
        // A dialog keeps the keyboard until it is dismissed.
        const stops = [...sheet.current.querySelectorAll<HTMLElement>('select, input, button')].filter(
          (el) => !(el as HTMLButtonElement).disabled,
        )
        if (stops.length === 0) return
        const i = stops.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey ? (i <= 0 ? stops.length - 1 : i - 1) : i === stops.length - 1 ? 0 : i + 1
        e.preventDefault()
        stops[next].focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [onClose])

  const device = settings.device ?? ''
  const unnamed = outputs.length > 0 && outputs.every((d) => d.label === '')
  const missing = device !== '' && !outputs.some((d) => d.deviceId === device)
  const latencyValue = custom ? 'custom' : (settings.latency ?? 'low')

  return createPortal(
    <div
      className="sheet-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={sheet} className="sheet audio-sheet" role="dialog" aria-modal="true" aria-labelledby="audio-title">
        <div className="sheet-head">
          <div>
            <h2 id="audio-title">Audio settings</h2>
            <p className="sheet-note">
              How this browser opens your sound card. Kept on this machine, not in the project.
            </p>
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="Close" type="button">
            &times;
          </button>
        </div>

        <div className="audio-body">
          <label className="audio-field">
            <span className="audio-label">Output</span>
            {canChooseOutput ? (
              <select id="audio-output" value={device} onChange={(e) => apply({ ...settings, device: e.target.value })}>
                <option value="">System default</option>
                {outputs.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Output ${i + 1}`}
                  </option>
                ))}
                {missing && (
                  // Unnamed until the browser lists it; not listed when named means unplugged.
                  <option value={device}>{outputs.length > 0 ? 'Saved output (not connected)' : 'Saved output'}</option>
                )}
              </select>
            ) : (
              <span className="audio-hint">
                This browser always plays through the system default. Chrome and Edge can choose an output.
              </span>
            )}
          </label>
          {canChooseOutput && (unnamed || outputs.length === 0) && (
            <p className="audio-hint">
              The browser hides its outputs’ names until the page may use a microphone.{' '}
              <button className="audio-link" type="button" onClick={() => void revealNames()}>
                Show output names
              </button>
            </p>
          )}

          <div className="audio-field">
            <label className="audio-label" htmlFor="audio-latency">
              Buffer
            </label>
            <div className="audio-row">
              <select
                id="audio-latency"
                value={latencyValue}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'custom') {
                    const n = Number(draftMs) || CUSTOM_MS
                    apply({ ...settings, latency: n })
                  } else apply({ ...settings, latency: v as LatencyMode })
                }}
              >
                {LATENCIES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {custom && (
                <label className="audio-ms">
                  <input
                    type="number"
                    min={MIN_MS}
                    max={MAX_MS}
                    step={1}
                    value={draftMs}
                    onChange={(e) => setDraftMs(e.target.value)}
                    onBlur={commitCustom}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitCustom()
                    }}
                    aria-label="Buffer in milliseconds"
                  />
                  ms
                </label>
              )}
            </div>
          </div>

          <label className="audio-field">
            <span className="audio-label">Sample rate</span>
            <select
              id="audio-rate"
              value={settings.sampleRate ?? ''}
              onChange={(e) => {
                const { sampleRate: _, ...rest } = settings
                apply(e.target.value ? { ...rest, sampleRate: Number(e.target.value) } : rest)
              }}
            >
              <option value="">Device default</option>
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {(r / 1000).toFixed(1).replace(/\.0$/, '')} kHz
                </option>
              ))}
            </select>
          </label>

          <p className="audio-hint">
            A smaller buffer makes played notes sound sooner, but a busy song can crackle; a larger
            one is steadier. Changing the buffer or the rate restarts the audio and stops playback.
          </p>

          <div className="audio-readout" aria-live="polite">
            {measure ? (
              <>
                <span className="audio-total">{ms(measure.base + measure.output)}</span>
                <span>
                  from a key to the speaker ({ms(measure.base)} buffer
                  {measure.output > 0 ? ` + ${ms(measure.output)} device` : ', device delay not reported'}) at{' '}
                  {(measure.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz
                </span>
              </>
            ) : (
              <span>
                {status.state === 'starting'
                  ? 'Opening the device…'
                  : 'Not measured yet: the device opens the first time something plays.'}
              </span>
            )}
          </div>

          {problem && <p className="audio-problem">{problem}</p>}
        </div>

        <div className="sheet-foot">
          <span />
          <span className="sheet-keys">Esc to close</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
