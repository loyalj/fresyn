import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FORMATS, formatTakesRate, MP3_RATES, type AudioFormat } from '../audio/encode'
import type { StemMix } from '../audio/renderSong'
import type { WavDepth } from '../audio/wav'
import { loadPrefs, savePrefs } from '../patch/storage'

/** How a bounce is written, remembered between bounces and sessions. */
export interface BounceSettings {
  format: AudioFormat
  sampleRate: number
  /** WAV: 16, 24 or 32 float. FLAC: 16 or 24. */
  bitDepth: WavDepth
  /** 0..10, higher better, for OGG and MP3. */
  quality: number
}

export const DEFAULT_BOUNCE: BounceSettings = { format: 'wav', sampleRate: 48000, bitDepth: 24, quality: 6 }

const RATES = [44100, 48000, 88200, 96000]

/** The qualities offered for each lossy format, with what they come to in a file. */
const QUALITIES: Record<'ogg' | 'mp3', { q: number; name: string }[]> = {
  ogg: [
    { q: 3, name: 'q3 — about 112 kbps' },
    { q: 5, name: 'q5 — about 160 kbps' },
    { q: 6, name: 'q6 — about 192 kbps' },
    { q: 8, name: 'q8 — about 256 kbps' },
    { q: 10, name: 'q10 — about 500 kbps' },
  ],
  mp3: [
    { q: 4, name: 'V6 — about 115 kbps' },
    { q: 6, name: 'V4 — about 165 kbps' },
    { q: 8, name: 'V2 — about 190 kbps' },
    { q: 10, name: 'V0 — about 245 kbps' },
  ],
}

/** What each format is for, in a line. */
const ABOUT: Record<AudioFormat, string> = {
  wav: 'Uncompressed. Every DAW and engine reads it; the biggest file.',
  flac: 'Lossless and about half the size of a WAV. Reads back sample for sample.',
  ogg: 'Small and lossy. What Unity, Godot and most web games stream music from.',
  mp3: 'Small and lossy, and plays anywhere. Written at 44.1 or 48 kHz only.',
}

const khz = (r: number) => `${(r / 1000).toFixed(1).replace(/\.0$/, '')} kHz`

/** The settings as remembered, with anything out of range put right. */
export function loadBounce(): BounceSettings {
  const b = loadPrefs().bounce
  const format = FORMATS.some((f) => f.id === b?.format) ? b!.format : DEFAULT_BOUNCE.format
  return {
    format,
    sampleRate: RATES.includes(b?.sampleRate ?? 0) ? b!.sampleRate : DEFAULT_BOUNCE.sampleRate,
    bitDepth: ([16, 24, 32] as number[]).includes(b?.bitDepth ?? 0) ? (b!.bitDepth as WavDepth) : DEFAULT_BOUNCE.bitDepth,
    quality: Number.isFinite(b?.quality) ? Math.max(0, Math.min(10, b!.quality)) : DEFAULT_BOUNCE.quality,
  }
}

interface Props {
  /** The whole mix, or stems carrying this much of each channel. */
  what: 'song' | StemMix
  onBounce: (settings: BounceSettings) => void
  onClose: () => void
}

const TITLES: Record<Props['what'], string> = {
  song: 'Bounce song',
  channel: 'Bounce stems — channel only',
  sends: 'Bounce stems — channel and sends',
  raw: 'Bounce stems — raw rack output',
}

/**
 * The file a bounce is written as: its format, its rate, and its depth or
 * quality. Built like the Audio settings sheet, and for the same reason:
 * every key is captured on the window, so the app stands its bindings down
 * while this is open.
 */
export function BounceDialog({ what, onBounce, onClose }: Props) {
  const [s, setS] = useState(loadBounce)
  const sheet = useRef<HTMLDivElement>(null)
  const lossy = s.format === 'ogg' || s.format === 'mp3'
  // An MP3 at a rate LAME does not write is brought to the nearest it does.
  const rate = formatTakesRate(s.format, s.sampleRate) ? s.sampleRate : s.sampleRate > 46000 ? 48000 : 44100

  const change = (next: Partial<BounceSettings>) => {
    const merged = { ...s, ...next }
    // A depth FLAC cannot write is brought to the nearest it can.
    if (merged.format === 'flac' && merged.bitDepth === 32) merged.bitDepth = 24
    setS(merged)
  }

  const go = () => {
    const final = { ...s, sampleRate: rate }
    savePrefs({ bounce: final })
    onBounce(final)
  }

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheet.current?.querySelector<HTMLElement>('select')?.focus()
    return () => restore?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        // A focused button -- Cancel included -- presses itself; anywhere
        // else, a dropdown included, Enter bounces.
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        go()
      } else if (e.key === 'Tab' && sheet.current) {
        const stops = [...sheet.current.querySelectorAll<HTMLElement>('select, button')].filter(
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
  })

  const qualities = lossy ? QUALITIES[s.format as 'ogg' | 'mp3'] : []
  // The nearest offered quality to the one remembered.
  const quality = qualities.reduce((a, b) => (Math.abs(b.q - s.quality) < Math.abs(a.q - s.quality) ? b : a), qualities[0] ?? { q: s.quality })

  return createPortal(
    <div
      className="sheet-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={sheet} className="sheet audio-sheet bounce-sheet" role="dialog" aria-modal="true" aria-labelledby="bounce-title">
        <div className="sheet-head">
          <div>
            <h2 id="bounce-title">{TITLES[what]}</h2>
            <p className="sheet-note">
              {what === 'song'
                ? 'The whole arrangement through the desk, faster than realtime, as one file.'
                : 'A file per track that plays, in a zip, numbered in the order of the track list.'}
            </p>
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="Close" type="button">
            &times;
          </button>
        </div>

        <div className="audio-body">
          <label className="audio-field">
            <span className="audio-label">Format</span>
            <select value={s.format} onChange={(e) => change({ format: e.target.value as AudioFormat })} aria-label="Format">
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <p className="audio-hint">{ABOUT[s.format]}</p>

          <label className="audio-field">
            <span className="audio-label">Sample rate</span>
            <select value={rate} onChange={(e) => change({ sampleRate: Number(e.target.value) })} aria-label="Sample rate">
              {RATES.map((r) => (
                <option key={r} value={r} disabled={s.format === 'mp3' && !MP3_RATES.includes(r)}>
                  {khz(r)}
                </option>
              ))}
            </select>
          </label>

          {lossy ? (
            <label className="audio-field">
              <span className="audio-label">Quality</span>
              <select value={quality.q} onChange={(e) => change({ quality: Number(e.target.value) })} aria-label="Quality">
                {qualities.map((q) => (
                  <option key={q.q} value={q.q}>
                    {q.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="audio-field">
              <span className="audio-label">Bit depth</span>
              <select value={s.bitDepth} onChange={(e) => change({ bitDepth: Number(e.target.value) as WavDepth })} aria-label="Bit depth">
                <option value={16}>16-bit</option>
                <option value={24}>24-bit</option>
                {s.format === 'wav' && <option value={32}>32-bit float</option>}
              </select>
            </label>
          )}
        </div>

        <div className="sheet-foot">
          <span className="sheet-keys">Enter to bounce · Esc to close</span>
          <span className="bounce-actions">
            <button className="dock-toggle" onClick={onClose} type="button">
              Cancel
            </button>
            <button className="dock-toggle on" onClick={go} type="button">
              Bounce
            </button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
