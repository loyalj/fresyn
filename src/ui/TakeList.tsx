import type { BitDepth } from '../audio/wav'
import { dbOf } from '../audio/waveform'
import { ConfirmButton } from './ConfirmButton'

export interface Take {
  index: number
  seed: number
  seconds: number
  peak: number
  sampleRate: number
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
  envelope: Float32Array
  keep: boolean
  /**
   * The name of the sound it was rendered from, as it was at the time --
   * what its file is called. Kept on the take rather than read off the rack
   * at download, because by then the track may have been renamed, or the
   * rack may be showing another track altogether.
   */
  source: string
  /** The bit depth the render was asked for, which the file is written at. */
  bitDepth: BitDepth
}

interface Props {
  takes: Take[]
  playing: number | null
  onPlay: (index: number) => void
  onToggleKeep: (index: number) => void
  onKeepAll: (keep: boolean) => void
  onExport: () => void
  onDiscard: () => void
}

/**
 * Rendered takes, before they become files.
 *
 * Auditioning here is the whole point: without it a batch has to be
 * downloaded and opened elsewhere before you can tell whether any of it was
 * worth keeping.
 */
export function TakeList({
  takes,
  playing,
  onPlay,
  onToggleKeep,
  onKeepAll,
  onExport,
  onDiscard,
}: Props) {
  if (takes.length === 0) return null
  const kept = takes.filter((t) => t.keep).length

  return (
    <div className="take-panel">
      <div className="take-head">
        <span className="take-title">
          {takes.length} take{takes.length === 1 ? '' : 's'}
        </span>
        <button className="take-link" onClick={() => onKeepAll(true)} type="button">
          keep all
        </button>
        <button className="take-link" onClick={() => onKeepAll(false)} type="button">
          keep none
        </button>
      </div>

      <div className="take-rows">
        {takes.map((take) => (
          <div
            key={take.index}
            className={`take${take.keep ? ' kept' : ''}${playing === take.index ? ' playing' : ''}`}
          >
            <label className="take-keep" title={take.keep ? 'Will be downloaded' : 'Skipped'}>
              <input
                type="checkbox"
                checked={take.keep}
                onChange={() => onToggleKeep(take.index)}
                aria-label={`Keep take ${take.index + 1}`}
              />
              <span className="take-number">{String(take.index + 1).padStart(2, '0')}</span>
            </label>

            <button
              className="take-wave"
              onClick={() => onPlay(take.index)}
              aria-label={`Play take ${take.index + 1}`}
              type="button"
            >
              <Waveform envelope={take.envelope} />
            </button>

            <span className="take-meta">
              {take.seconds.toFixed(2)}s &middot; {formatDb(take.peak)} &middot; seed{' '}
              {take.seed.toString(16)}
            </span>
          </div>
        ))}
      </div>

      <div className="export-actions">
        <button className="export-go" disabled={kept === 0} onClick={onExport} type="button">
          {kept === 0
            ? 'Nothing kept'
            : kept === 1
              ? 'Download 1 take'
              : `Download ${kept} takes`}
        </button>
        {/* Asks first: a batch of takes is minutes of rendering and none
            of it is in undo. */}
        <ConfirmButton className="panel-cancel" ask="Discard all?" onConfirm={onDiscard}>
          Discard
        </ConfirmButton>
      </div>
    </div>
  )
}

const HEIGHT = 32

function Waveform({ envelope }: { envelope: Float32Array }) {
  const width = envelope.length
  const mid = HEIGHT / 2

  // One closed shape mirrored about the centre line, rather than a stroke, so
  // a quiet take still reads as a thin band instead of disappearing.
  let d = `M 0 ${mid}`
  for (let i = 0; i < width; i++) d += ` L ${i} ${(mid - envelope[i] * mid).toFixed(2)}`
  for (let i = width - 1; i >= 0; i--) d += ` L ${i} ${(mid + envelope[i] * mid).toFixed(2)}`
  d += ' Z'

  return (
    <svg
      className="waveform"
      viewBox={`0 0 ${width} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line x1="0" y1={mid} x2={width} y2={mid} className="waveform-axis" />
      <path d={d} />
    </svg>
  )
}

function formatDb(peak: number) {
  const db = dbOf(peak)
  return Number.isFinite(db) ? `${db.toFixed(1)} dB` : 'silent'
}
