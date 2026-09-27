import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModuleDef } from '../patch/types'
import { useSamples } from './SampleContext'
import { useFace } from './useFace'

const CONTROLS = ['start', 'length', 'speed', 'cvAmount', 'fade', 'level', 'loop', 'direction']

/** Columns of peaks drawn across the window, whatever its pixel width. */
const COLUMNS = 240

interface Props {
  def: ModuleDef
  moduleId: string
  /** What this module is pointed at, from the patch rather than the knobs. */
  sample?: { id: string; name: string }
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
  onLoad: (file: File) => void
  onClear: () => void
  faceExtra?: React.ReactNode
}

/**
 * The one panel with an outside.
 *
 * Everything else in this rack is knobs over arithmetic; this one is knobs
 * over a file somebody dropped, so it has three states rather than one --
 * empty, loaded, and naming a file this browser does not have. The third is
 * not an error: a patch shared with somebody else always lands there, and so
 * does one whose storage the browser has reclaimed.
 */
export function SamplerFace({
  def,
  moduleId,
  sample,
  valueOf,
  onChange,
  onLoad,
  onClear,
  faceExtra,
}: Props) {
  const samples = useSamples()
  const { read, control } = useFace(def, valueOf, onChange)
  const [over, setOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Redrawn when audio arrives, which happens after the patch already names
  // it: a file is stored and decoded asynchronously, and a bundle lands a
  // whole rack's worth at once.
  const [, bump] = useState(0)
  useEffect(() => samples?.onChange(() => bump((n) => n + 1)), [samples])

  const loaded = samples?.get(sample?.id) ?? null
  const missing = !!sample && !loaded && (samples?.isMissing(sample.id) ?? false)

  const peaks = useMemo(() => (loaded ? peaksOf(loaded.data.channels[0]) : null), [loaded])

  const start = read('start')
  const length = read('length')
  const regionEnd = start + (1 - start) * length

  const take = (files: FileList | null) => {
    const file = files?.[0]
    if (file) onLoad(file)
  }

  return (
    <div className="sampler-face">
      <div
        className={`sampler-screen${over ? ' over' : ''}${loaded ? ' loaded' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          take(e.dataTransfer.files)
        }}
      >
        {peaks && loaded ? (
          <svg
            className="sampler-wave"
            viewBox={`0 0 ${COLUMNS} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {/* The part that will not be played, behind the part that will. */}
            <rect className="sampler-region" x="0" y="0" width={start * COLUMNS} height="100" />
            <rect
              className="sampler-region"
              x={regionEnd * COLUMNS}
              y="0"
              width={(1 - regionEnd) * COLUMNS}
              height="100"
            />
            <line className="sampler-mid" x1="0" y1="50" x2={COLUMNS} y2="50" vectorEffect="non-scaling-stroke" />
            <path className="sampler-trace" d={peaks} />
          </svg>
        ) : (
          <button
            type="button"
            className="sampler-empty"
            onClick={() => fileRef.current?.click()}
          >
            {missing ? (
              <>
                <span className="sampler-missing">{sample?.name}</span>
                <span>is not in this browser — drop it here to bring it back</span>
              </>
            ) : (
              <>
                <span className="sampler-missing">Drop audio here</span>
                <span>WAV, MP3, OGG or FLAC — or click to choose a file</span>
              </>
            )}
          </button>
        )}

        <input
          ref={fileRef}
          id={`${moduleId}-file`}
          className="sampler-file"
          type="file"
          accept="audio/*,.wav,.mp3,.ogg,.flac"
          onChange={(e) => {
            take(e.target.files)
            // Cleared so dropping the same file twice in a row still fires.
            e.target.value = ''
          }}
        />
      </div>

      <div className="sampler-caption">
        {loaded ? (
          <>
            <button type="button" className="sampler-name" onClick={() => fileRef.current?.click()}>
              {loaded.name}
            </button>
            <span className="sampler-facts">
              {(loaded.data.frames / loaded.data.rate).toFixed(2)} s ·{' '}
              {loaded.data.channels.length > 1 ? 'stereo' : 'mono'}
            </span>
            <button type="button" className="sampler-clear" onClick={onClear}>
              Clear
            </button>
          </>
        ) : (
          <span className="sampler-facts">{missing ? 'Missing audio' : 'No audio loaded'}</span>
        )}
      </div>

      <div className="controls">
        {CONTROLS.map(control)}
        {faceExtra}
      </div>
    </div>
  )
}

/**
 * The waveform as one closed path: the top of every column left to right,
 * then the bottoms coming back.
 *
 * Peaks per column rather than samples, because a second of audio is fifty
 * thousand points and the window is a few hundred pixels wide -- drawing
 * every sample would be slower and would look like noise rather than like
 * the sound.
 */
function peaksOf(channel: Float32Array): string {
  const tops: string[] = []
  const bottoms: string[] = []
  for (let c = 0; c < COLUMNS; c++) {
    const from = Math.floor((c * channel.length) / COLUMNS)
    const to = Math.floor(((c + 1) * channel.length) / COLUMNS)
    let lo = 0
    let hi = 0
    for (let i = from; i < to && i < channel.length; i++) {
      const v = channel[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    // A hair of height on silence, so a quiet passage reads as a line rather
    // than as a gap in the drawing.
    const top = 50 - Math.max(hi * 48, 0.4)
    const bottom = 50 - Math.min(lo * 48, -0.4)
    tops.push(`${c === 0 ? 'M' : 'L'} ${c} ${top.toFixed(2)}`)
    bottoms.push(`L ${c} ${bottom.toFixed(2)}`)
  }
  // Out along the tops, back along the bottoms, closed.
  return `${tops.join(' ')} ${bottoms.reverse().join(' ')} Z`
}
