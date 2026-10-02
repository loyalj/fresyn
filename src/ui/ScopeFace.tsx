import { useEffect, useRef } from 'react'
import { SCOPE_CAPTURE } from '../dsp/modules/Scope'
import type { ModuleDef } from '../patch/types'
import { useEngine, useEngineId } from './EngineContext'
import { drawScope, type ScopeView } from './scopeDraw'
import { useAppearance } from './ThemeContext'
import { useFace } from './useFace'

interface Props {
  def: ModuleDef
  moduleId: string
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
}

const KNOBS = ['timebase', 'gain', 'mode']

/**
 * The scope's screen.
 *
 * Frames arrive from the audio thread about thirty times a second and are
 * drawn straight to a canvas, never through React state: a rack-wide re-render
 * at that rate would make every knob in the room feel sticky. The component
 * renders once and the draw loop runs on refs from then on.
 */
export function ScopeFace({ def, moduleId, valueOf, onChange }: Props) {
  const engine = useEngine()
  /** How the engine reports this module: by its id in the track, a pad's included. */
  const engineId = useEngineId(moduleId)
  const appearance = useAppearance()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frame = useRef<Float32Array | null>(null)
  const frameB = useRef<Float32Array | null>(null)
  const dirty = useRef(true)
  const view = useRef<ScopeView>({
    mode: 'wave',
    samples: 1024,
    gain: 1,
    sampleRate: 48000,
    // Replaced from the stylesheet on mount, and again on every theme
    // change; these only stand in for the frame before that happens.
    accent: '#f0a641',
    accentB: '#8b919c',
    grid: '#2c2f37',
    dim: '#3d424c',
  })

  const { read, control } = useFace(def, valueOf, onChange)
  const timebase = read('timebase')
  const gain = read('gain')
  const mode = Math.round(read('mode'))

  // Settings are read through a ref so the draw loop never has to be torn
  // down and rebuilt when a knob moves.
  const sampleRate = engine?.sampleRate ?? 48000
  view.current.mode = mode === 1 ? 'spectrum' : 'wave'
  view.current.gain = gain
  view.current.sampleRate = sampleRate
  view.current.samples = Math.max(
    2,
    Math.min(SCOPE_CAPTURE, Math.round(timebase * sampleRate)),
  )
  dirty.current = true

  useEffect(() => {
    if (!engine) return
    return engine.onScopeFrame((frames) => {
      const next = frames[engineId]
      // B arrives as its own entry, and only while something is patched to
      // it, so a frame without one means the jack is empty rather than quiet.
      // Under the engine's id, like A: inside a Drum Kit's pad the two differ,
      // and B looked up by the module's own id never arrived there.
      const nextB = frames[`${engineId}.b`] ?? null
      if (!next && !nextB) return
      if (next) frame.current = next
      frameB.current = nextB
      dirty.current = true
    })
  }, [engine, engineId])

  // Colours belong in the stylesheet; a canvas cannot read a CSS variable on
  // its own, so they are declared on the element and pulled off here. Reading
  // them per frame would force a style recalc thirty times a second, so this
  // runs once and again whenever the palette underneath it is replaced.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const style = getComputedStyle(canvas)
    const pick = (name: string, fallback: string) =>
      style.getPropertyValue(name).trim() || fallback
    view.current.accent = pick('--scope-line', view.current.accent)
    view.current.accentB = pick('--scope-line-b', view.current.accentB)
    view.current.grid = pick('--scope-grid', view.current.grid)
    view.current.dim = pick('--scope-axis', view.current.dim)
    dirty.current = true
  }, [appearance])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let raf = 0
    const tick = () => {
      // Frames arrive at ~30 Hz, so redrawing on every animation frame would
      // draw each one twice. The flag also covers a knob moving between them.
      if (dirty.current) {
        dirty.current = false
        drawScope(canvas, frame.current, frameB.current, view.current)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="scope-face">
      <div className="scope-screen-frame">
        <canvas
          ref={canvasRef}
          className="scope-screen"
          data-module={moduleId}
          role="img"
          aria-label={`${moduleId} ${view.current.mode}`}
        />
        <span className="scope-legend">
          {view.current.mode === 'spectrum'
            ? `20 Hz - ${(sampleRate / 2000).toFixed(1)} kHz, log`
            : `${(timebase * 1000).toFixed(0)} ms`}
        </span>
      </div>

      <div className="controls">
        {KNOBS.map(control)}
      </div>
    </div>
  )
}
