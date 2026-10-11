import { useEffect, useMemo, useRef, useState } from 'react'
import { compileExpr } from '../dsp/Expr'
import { DEFAULT_FORMULA, MODE_BYTEBEAT } from '../dsp/modules/Expression'
import type { ModuleDef } from '../patch/types'
import { useEngine, useEngineId } from './EngineContext'
import { drawExpr, horizontalOf, type ExprView } from './exprDraw'
import { useAppearance } from './ThemeContext'
import { useFace } from './useFace'

interface Props {
  def: ModuleDef
  moduleId: string
  /** The formula as the patch has it; absent is the starting one. */
  text?: string
  onText?: (text: string) => void
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
}

const KNOBS = ['mode', 'a', 'b', 'rate']

/**
 * The Expression's panel: the formula, typed, and drawn on a grid as a
 * graphing calculator would.
 *
 * The field compiles as it is typed, so a mistake is named while it is being
 * made, and the graph follows the draft -- but the rack only hears a formula
 * once Enter or leaving the field hands it over, and only one that
 * compiles. Esc puts the field back. The dot on the graph is the formula
 * now, from the audio thread about thirty times a second; the curve is the
 * same program run here, so it cannot disagree with what is heard.
 */
export function ExprFace({ def, moduleId, text, onText, valueOf, onChange }: Props) {
  const engine = useEngine()
  const engineId = useEngineId(moduleId)
  const appearance = useAppearance()
  const { read, control } = useFace(def, valueOf, onChange)
  const committed = text?.trim() ? text : DEFAULT_FORMULA
  const [draft, setDraft] = useState(committed)
  // A formula changed from elsewhere -- undo, a pasted unit -- replaces the
  // draft, unless it is the draft that was just handed over.
  useEffect(() => setDraft(committed), [committed])

  const compiled = useMemo(() => compileExpr(draft), [draft])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dirty = useRef(true)
  const view = useRef<ExprView>({
    program: null,
    bytebeat: false,
    a: 1,
    b: 0,
    live: null,
    // Replaced from the stylesheet on mount and on every theme change.
    colors: { line: '#f0a641', grid: '#2c2f37', axis: '#3d424c', text: '#8b919c', dot: '#ffffff' },
  })

  const bytebeat = Math.round(read('mode')) === MODE_BYTEBEAT
  // The draft while it compiles; otherwise what the rack is running.
  const shown = compiled.ok ? compiled.program : (() => {
    const c = compileExpr(committed)
    return c.ok ? c.program : null
  })()
  view.current.program = shown
  view.current.bytebeat = bytebeat
  view.current.a = read('a')
  view.current.b = read('b')
  dirty.current = true

  useEffect(() => {
    if (!engine) return
    return engine.onLevels((levels) => {
      const next = levels[engineId]
      if (!next || next.length < 4) return
      view.current.live = { x: next[0], y: next[1], t: next[2], out: next[3] }
      dirty.current = true
    })
  }, [engine, engineId])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const style = getComputedStyle(canvas)
    const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
    const c = view.current.colors
    c.line = pick('--expr-line', c.line)
    c.grid = pick('--expr-grid', c.grid)
    c.axis = pick('--expr-axis', c.axis)
    c.text = pick('--expr-text', c.text)
    c.dot = pick('--expr-dot', c.dot)
    dirty.current = true
  }, [appearance])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    const tick = () => {
      if (dirty.current) {
        dirty.current = false
        drawExpr(canvas, view.current)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const commit = () => {
    if (!compiled.ok || draft === committed) return
    // The starting formula is stored as nothing, so a module left on it
    // reads the same as one never touched.
    onText?.(draft.trim() === DEFAULT_FORMULA ? '' : draft)
  }

  const along = horizontalOf({ program: shown, bytebeat })
  const pending = compiled.ok && draft !== committed

  return (
    <div className="expr-face">
      <div className="expr-entry">
        <span className="expr-prompt" aria-hidden="true">
          {along === 'x' && !bytebeat ? 'y =' : 'f(t) ='}
        </span>
        <input
          className={`expr-formula${compiled.ok ? '' : ' invalid'}${pending ? ' pending' : ''}`}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${moduleId} formula`}
          aria-invalid={!compiled.ok}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(committed)
            }
          }}
        />
      </div>
      <div className={`expr-status${compiled.ok ? '' : ' error'}`} role={compiled.ok ? undefined : 'alert'}>
        {compiled.ok
          ? pending
            ? 'Enter to use it'
            : 'x y t a b · pi tau · sin cos tanh abs min max pow … saw tri sq noise() · & | ^ << >> ?:'
          : compiled.error}
      </div>
      <div className="scope-screen-frame expr-screen-frame">
        <canvas
          ref={canvasRef}
          className="expr-screen"
          data-module={moduleId}
          role="img"
          aria-label={`${moduleId} graph of ${draft}`}
        />
        <span className="scope-legend">{bytebeat ? `t, ${read('rate').toFixed(0)} a second` : along === 'x' ? 'x from −2 to 2' : 't, last 2 s'}</span>
      </div>
      <div className="controls">{KNOBS.map(control)}</div>
    </div>
  )
}
