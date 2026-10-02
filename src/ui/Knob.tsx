import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  clampValue,
  denormalize,
  formatValue,
  hzFromSemitones,
  normalize,
  parseValue,
  semitonesFrom440,
  snap,
  snapToNote,
  stepFor,
  unitName,
  type ParamSpec,
} from '../patch/param'
import { ContextMenu, type MenuItem } from './Menu'
import { useKnobHelp } from './KnobHelp'

const SIZE = 52
const RADIUS = 20
const START = 135
const SWEEP = 270
/** Pixels of vertical drag for the full range. */
const TRAVEL = 220
/**
 * One wheel notch, as a fraction of the range. The wheel is the coarse
 * adjustment now that Shift is the exact one: a hundred notches crosses the
 * sweep that 220 pixels of drag crosses, which is for finding a value.
 */
const WHEEL_STEP = 0.01
/**
 * One press of Page Up or Page Down, as a fraction of the range: ten of them
 * cross it. The arrows move a wheel notch, and Shift with an arrow moves the
 * last digit of the readout, the same exact step Shift gives the wheel.
 */
const PAGE_STEP = 0.1
/** Shift makes the drag five times finer. */
const FINE = 5
/** What one notch of the wheel reports as, indexed by deltaMode. */
const NOTCH = [100, 3, 1]
/**
 * Slack for deciding whether a value is already sitting on a detent.
 *
 * A value that arrived by arithmetic is a hair off the multiple it means,
 * and without this a knob on 1.00 would step to 1.00 again before it moved.
 */
const ON_DETENT = 1e-6

/**
 * The value a knob last copied, with the unit it was measured in.
 *
 * The unit travels with it because that is what lets a paste be refused: a
 * decay time and a cutoff are both numbers, and dropping one into the other
 * would set a filter to a fifth of a hertz without saying anything about it.
 *
 * It is kept here rather than read back out of the system clipboard because
 * a browser will not hand a page the clipboard without a prompt, and the
 * menu row has to know whether the paste is going to work *before* anybody
 * clicks it. Copy still writes the readout out to the system clipboard as
 * well, so a value can be carried somewhere else; it is only the reading
 * back that stays in here.
 */
let held: { value: number; unit: string; text: string } | null = null

/** The unit a value has to be in before this knob will take it. */
const unitOf = (spec: ParamSpec) => (spec.steps ? '#' : spec.unit)

/**
 * The next multiple of `step` in the given direction.
 *
 * Floor going up and ceiling coming down, rather than rounding, so a knob
 * left at 0.996 steps up to 1.00 instead of stepping over it to 1.01. One
 * notch therefore always both moves the value and tidies it.
 */
function nudge(value: number, step: number, dir: number) {
  const q = value / step
  const from = dir > 0 ? Math.floor(q + ON_DETENT) : Math.ceil(q - ON_DETENT)
  return snap((from + dir) * step, step)
}

interface Props {
  spec: ParamSpec
  value: number
  onChange: (value: number) => void
  /**
   * Detent size. The knob still turns smoothly; only the value it reports
   * lands on multiples of this, which is what a knob counting whole takes
   * needs. Rounding in the caller instead would fight the wheel: the value
   * coming back would not be the one the knob sent, and the wheel drops its
   * position whenever that happens.
   */
  step?: number
  /** Overrides the readout, for knobs that are not module parameters. */
  format?: (value: number) => string
}

/**
 * One knob. Memoized, so the knobs beside one being turned are left alone:
 * the unit hands each one a handler that stays the same (see `Control`).
 */
export const Knob = memo(function Knob({ spec, value, onChange, step, format }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ y: number; t: number } | null>(null)
  const t = normalize(spec, value)
  const readout = format ? format(value) : formatValue(spec, value)

  /** Where the right-click landed, or null when no menu is showing. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  /** The readout, being typed into. Null the rest of the time. */
  const [entry, setEntry] = useState<string | null>(null)
  const [rejected, setRejected] = useState(false)

  const quantize = useCallback(
    (v: number) => (step ? Math.round(v / step) * step : v),
    [step],
  )
  const emit = useCallback((v: number) => onChange(quantize(v)), [onChange, quantize])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Left button only. The right one is opening the menu, and a knob that
      // took a turn from it as well would move under the menu it just opened.
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { y: e.clientY, t: normalize(spec, value) }
    },
    [spec, value],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = drag.current
      if (!d) return
      // Shift drops to fine resolution; without it the exponential params are
      // impossible to place by hand.
      const scale = e.shiftKey ? FINE : 1
      const next = d.t + (d.y - e.clientY) / (TRAVEL * scale)
      const turned = denormalize(spec, next)
      // Alt lands on whole semitones, which is the only way two oscillators
      // get tuned to an interval by hand: a fifth is seven of them, and seven
      // semitones at 110 Hz is a distance of 55 Hz that is 220 Hz at the top
      // of the same knob.
      emit(spec.tuned && e.altKey ? snapToNote(spec, turned) : turned)
    },
    [spec, emit],
  )

  const endDrag = useCallback(() => {
    drag.current = null
  }, [])

  // --- wheel ---------------------------------------------------------
  // The handler is registered once and reads the current props through a
  // ref, because `onChange` is a fresh closure on every render of the rack.
  const latest = useRef({ spec, value, emit, step })
  /**
   * Where the wheel believes the knob is, and the last value it sent.
   *
   * A burst of wheel events outruns React: the second one fires before the
   * first has re-rendered, so reading the position back off props would see
   * the value from before the previous notch and the knob would stall. The
   * wheel keeps its own position instead, and drops it the moment a value
   * arrives that it did not send -- an undo, a patch load, or the same knob
   * being dragged.
   */
  const wheelT = useRef<number | null>(null)
  const sent = useRef<number | null>(null)
  /**
   * Part-notches of Shift-wheeling not yet spent.
   *
   * A mouse delivers a whole notch at a time and never touches this, but a
   * trackpad sends a stream of small deltas, and one detent per delta would
   * run a knob across its range in a flick.
   */
  const spare = useRef(0)

  useEffect(() => {
    latest.current = { spec, value, emit, step }
    if (value !== sent.current) wheelT.current = null
  })

  useEffect(() => {
    const el = svgRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      // The page must not scroll out from under a knob being tuned. React
      // registers wheel passively at the root, where preventDefault does
      // nothing, so this listener is attached by hand and is not passive.
      // It is on the knob alone, so everywhere else still scrolls.
      e.preventDefault()

      const { spec: s, value: v, emit: send, step: detent } = latest.current
      const notches = e.deltaY / (NOTCH[e.deltaMode] ?? NOTCH[0])

      // Alt is the exact adjustment for a knob measured in notes: one notch
      // is one semitone, tidied onto the note it is nearest on the way, the
      // same way Shift tidies onto the last digit of a readout below.
      if (s.tuned && e.altKey) {
        spare.current += notches
        const whole = Math.trunc(spare.current)
        if (!whole) return
        spare.current -= whole
        const dir = whole > 0 ? -1 : 1
        let semitones = semitonesFrom440(v)
        for (let i = Math.abs(whole); i > 0; i--) semitones = nudge(semitones, 1, dir)
        const emitted = clampValue(s, hzFromSemitones(semitones))
        wheelT.current = null
        sent.current = emitted
        send(emitted)
        return
      }

      // Shift is the exact adjustment: one notch moves the last digit the
      // readout shows, and lands on a multiple of it. A step proportional to
      // the range cannot reach a round number, which is the whole use for
      // this -- an FM amount has to be 1.00 to track the keyboard, and 0.99
      // is no good at all.
      if (e.shiftKey) {
        spare.current += notches
        const whole = Math.trunc(spare.current)
        if (!whole) return
        spare.current -= whole
        // Wheel up is more, the way dragging up is more.
        const dir = whole > 0 ? -1 : 1
        const size = detent ?? stepFor(s, v)
        let next = v
        for (let i = Math.abs(whole); i > 0; i--) next = nudge(next, size, dir)
        const emitted = clampValue(s, next)
        // Whatever the coarse wheel thought is no longer where the knob is.
        wheelT.current = null
        sent.current = emitted
        send(emitted)
        return
      }

      spare.current = 0
      const next = (wheelT.current ?? normalize(s, v)) - notches * WHEEL_STEP
      const clamped = next < 0 ? 0 : next > 1 ? 1 : next

      // The position is kept unrounded and the report is rounded off it, so
      // a detented knob keeps creeping towards its next notch instead of
      // sticking wherever the rounding put it back.
      wheelT.current = clamped
      const emitted = quantize(denormalize(s, clamped))
      sent.current = emitted
      send(emitted)
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [quantize])

  // --- copy, paste and typing ----------------------------------------
  const copy = useCallback(() => {
    held = { value, unit: unitOf(spec), text: readout }
    // Best effort, and deliberately not awaited: the copy inside the rack has
    // already happened, and a browser that refuses the clipboard must not
    // take the paste between knobs down with it.
    void navigator.clipboard?.writeText(readout).catch(() => {})
  }, [spec, value, readout])

  /** Apply typed text, or refuse it and stay open. True when it took. */
  const commit = useCallback(
    (text: string) => {
      const parsed = parseValue(spec, text)
      if (!parsed.ok) {
        setRejected(true)
        return false
      }
      setEntry(null)
      setRejected(false)
      // Straight to `onChange` rather than through `emit`: a typed value is
      // exact, and the detent is there to tame a turning knob, not to move a
      // number somebody just spelled out.
      onChange(parsed.value)
      return true
    },
    [spec, onChange],
  )

  const startEntry = useCallback(() => {
    setRejected(false)
    setEntry(readout)
  }, [readout])

  // --- keyboard --------------------------------------------------------
  /**
   * The knob from the keyboard, with the keys a slider is expected to have.
   *
   * The steps are the wheel's: an arrow is one coarse notch, Shift with an
   * arrow is one exact one, so a value found with one is found the same way
   * with the other. Up and right are more, as dragging up is more.
   *
   * A coarse step that lands back on the value it left is pushed on to the
   * next detent instead. Without that a knob counting whole takes, whose
   * detent is wider than a notch near the bottom of its range, would never
   * move from the keyboard at all.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const up = e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'PageUp'
      const down = e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'PageDown'
      let next: number
      if (e.key === 'Home') next = spec.min
      else if (e.key === 'End') next = spec.max
      else if (up || down) {
        const dir = up ? 1 : -1
        const page = e.key === 'PageUp' || e.key === 'PageDown'
        if (e.shiftKey && !page) {
          next = clampValue(spec, nudge(value, step ?? stepFor(spec, value), dir))
        } else {
          const t0 = normalize(spec, value) + dir * (page ? PAGE_STEP : WHEEL_STEP)
          next = quantize(denormalize(spec, t0 < 0 ? 0 : t0 > 1 ? 1 : t0))
          if (next === value) next = clampValue(spec, nudge(value, step ?? stepFor(spec, value), dir))
        }
      } else if (e.key === 'Enter') {
        // The readout is where a value is typed; Enter on the knob opens it,
        // as a click on the number does.
        e.preventDefault()
        startEntry()
        return
      } else return
      e.preventDefault()
      if (next !== value) emit(next)
    },
    [spec, value, step, quantize, emit, startEntry],
  )

  const menuItems = (): MenuItem[] => {
    const takeable = held && held.unit === unitOf(spec) ? held : null
    return [
      { kind: 'action', label: 'Copy', shortcut: readout, onSelect: copy },
      {
        kind: 'action',
        label: 'Paste',
        // The row says what it would paste, or why it will not: a greyed
        // Paste with no reason on it reads as a bug in the menu.
        shortcut: takeable ? takeable.text : held ? `needs ${unitName(spec)}` : '',
        disabled: !takeable,
        onSelect: () => takeable && onChange(clampValue(spec, takeable.value)),
      },
      { kind: 'separator' },
      { kind: 'action', label: 'Enter value…', onSelect: startEntry },
      {
        kind: 'action',
        label: 'Reset',
        shortcut: 'Double-click',
        onSelect: () => emit(spec.default),
      },
    ]
  }

  const angle = (START + SWEEP * t) * (Math.PI / 180)
  const cx = SIZE / 2
  const cy = SIZE / 2

  // A bipolar control fills from its centre detent outwards, so that a pan at
  // zero reads as centred rather than as half-open.
  const bipolar = spec.min < 0 && spec.max > 0
  const originT = bipolar ? normalize(spec, 0) : 0
  const help = useKnobHelp(spec.label)

  return (
    <div
      className="knob"
      {...help}
      onContextMenu={(e) => {
        // A field being typed into keeps the browser's own menu, which is
        // where its paste lives.
        if (e.target instanceof HTMLElement && e.target.closest('input')) return
        e.preventDefault()
        setMenuAt({ x: e.clientX, y: e.clientY })
      }}
    >
      <svg
        ref={svgRef}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => emit(spec.default)}
        onKeyDown={onKeyDown}
        // In the tab order, like any slider: a knob reached only by a pointer
        // is a knob a keyboard cannot set.
        tabIndex={0}
        role="slider"
        aria-label={spec.label}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuetext={readout}
      >
        <path d={arc(cx, cy, RADIUS, START, START + SWEEP)} className="knob-track" />
        <path
          d={arc(cx, cy, RADIUS, START + SWEEP * originT, START + SWEEP * t)}
          className="knob-value"
        />
        <circle cx={cx} cy={cy} r={RADIUS - 5} className="knob-cap" />
        <line
          x1={cx + Math.cos(angle) * 5}
          y1={cy + Math.sin(angle) * 5}
          x2={cx + Math.cos(angle) * (RADIUS - 6)}
          y2={cy + Math.sin(angle) * (RADIUS - 6)}
          className="knob-pointer"
        />
      </svg>
      <span className="knob-label">{spec.label}</span>

      {entry === null ? (
        // The readout is the value, so it is also where the value is said:
        // clicking the number opens it for typing, rather than sending
        // anybody hunting for a field somewhere else on the panel.
        <button type="button" className="knob-readout" onClick={startEntry}>
          {readout}
        </button>
      ) : (
        <input
          className={`knob-readout knob-entry${rejected ? ' bad' : ''}`}
          value={entry}
          autoFocus
          spellCheck={false}
          aria-label={`${spec.label}, as ${unitName(spec)}`}
          aria-invalid={rejected}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setEntry(e.target.value)
            setRejected(false)
          }}
          onKeyDown={(e) => {
            // The rack's own bindings stand aside for a field, but the panels
            // and lists around this one are ordinary React handlers, so the
            // keystrokes stop here.
            e.stopPropagation()
            if (e.key === 'Enter') commit(e.currentTarget.value)
            else if (e.key === 'Escape') {
              setEntry(null)
              setRejected(false)
            }
          }}
          // Clicking away is not a way of saying "yes, that": anything that
          // could not be read is dropped rather than half-applied.
          onBlur={(e) => {
            if (!commit(e.currentTarget.value)) {
              setEntry(null)
              setRejected(false)
            }
          }}
        />
      )}

      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={menuItems()}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  )
})

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  if (Math.abs(to - from) < 0.01) return ''
  // Always sweep the short way round; a bipolar knob below centre draws
  // backwards, and an arc reads the same whichever end it starts from.
  const a0 = Math.min(from, to) * (Math.PI / 180)
  const a1 = Math.max(from, to) * (Math.PI / 180)
  const large = Math.abs(to - from) > 180 ? 1 : 0
  return [
    'M', cx + Math.cos(a0) * r, cy + Math.sin(a0) * r,
    'A', r, r, 0, large, 1, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r,
  ].join(' ')
}
