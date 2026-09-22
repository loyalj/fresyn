import { useEffect, useRef } from 'react'
import { SCOPE_CAPTURE } from '../dsp/modules/Scope'
import type { ModuleDef } from '../patch/types'
import { Control } from './Control'
import { useEngine } from './EngineContext'
import { drawScope, type ScopeView } from './scopeDraw'
import { useAppearance } from './ThemeContext'

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
  const appearance = useAppearance()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frame = useRef<Float32Array | null>(null)
  const dirty = useRef(true)
  const view = useRef<ScopeView>({
    mode: 'wave',
    samples: 1024,
    gain: 1,
    sampleRate: 48000,
    // Replaced from the stylesheet on mount, and again on every theme
    // change; these only stand in for the frame before that happens.
    accent: '#f0a641',
    grid: '#2c2f37',
    dim: '#3d424c',
  })

  const byId = Object.fromEntries(def.params.map((p) => [p.id, p]))
  const timebase = valueOf('timebase') ?? byId.timebase.default
  const gain = valueOf('gain') ?? byId.gain.default
  const mode = Math.round(valueOf('mode') ?? byId.mode.default)

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
      const next = frames[moduleId]
      if (!next) return
      frame.current = next
      dirty.current = true
    })
  }, [engine, moduleId])

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
        drawScope(canvas, frame.current, view.current)
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
        {KNOBS.map((id) => (
          <Control
            key={id}
            spec={byId[id]}
            value={valueOf(id)}
            onChange={(v) => onChange(id, v)}
          />
        ))}
      </div>
    </div>
  )
}
