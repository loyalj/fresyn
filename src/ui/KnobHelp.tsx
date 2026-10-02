import { createContext, memo, useContext, useEffect, useRef, useState } from 'react'
import tables from '../../MANUAL.md?knob-help'
import { helpFor, type KnobHelp } from '../patch/knobHelp'

/**
 * Every knob's help, read out of the manual when the app is built rather
 * than when it loads -- the page carries the tables and not the manual.
 */
const HELP: KnobHelp = new Map(tables.map(([module, knobs]) => [module, new Map(knobs)]))

/** Whether help shows at all: the View menu's switch, for those who know the rack. */
export const KnobHelpOn = createContext(true)
/** The module a knob belongs to, as the manual heads its section. Set by each panel. */
export const KnobHelpModule = createContext<string | null>(null)

/** How long a pointer rests on a knob before its help shows. */
const DELAY_MS = 700

interface Tip {
  text: string
  label: string
  /** The knob's box on the page, to put the card beside. */
  rect: DOMRect
}

type Listener = (tip: Tip | null) => void
const listeners = new Set<Listener>()
let timer: ReturnType<typeof setTimeout> | undefined
function show(tip: Tip | null) {
  for (const l of listeners) l(tip)
}
function hide() {
  clearTimeout(timer)
  show(null)
}

/**
 * Props for a knob or a switch that shows its help when the pointer rests on
 * it. Nothing at all when help is switched off, on a control outside a module
 * panel, or on one the manual does not describe -- so there is never an empty
 * card, and a power user with it off pays for nothing.
 *
 * Pressing hides it straight away: once a knob is being turned, the value is
 * what is being read, and a card over the next knob along would be in the way.
 */
export function useKnobHelp(label: string) {
  const on = useContext(KnobHelpOn)
  const module = useContext(KnobHelpModule)
  const text = on && module ? helpFor(HELP, module, label) : null
  if (!text) return {}
  return {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.buttons) return
      const el = e.currentTarget
      clearTimeout(timer)
      timer = setTimeout(() => show({ text, label, rect: el.getBoundingClientRect() }), DELAY_MS)
    },
    onPointerLeave: hide,
    onPointerDown: hide,
  }
}

/**
 * The one card every knob shares, drawn once at the top of the page. It
 * never takes the pointer, so it cannot get between a hand and the knob next
 * to the one it is describing. Memoized, having no props: it redraws for its
 * own tip, never because the app did.
 */
export const KnobHelpCard = memo(function KnobHelpCard() {
  const [tip, setTip] = useState<Tip | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })

  useEffect(() => {
    listeners.add(setTip)
    // Anything that moves the page moves the knob out from under its card.
    const away = () => hide()
    window.addEventListener('scroll', away, true)
    window.addEventListener('keydown', away, true)
    return () => {
      listeners.delete(setTip)
      window.removeEventListener('scroll', away, true)
      window.removeEventListener('keydown', away, true)
    }
  }, [])

  // Under the knob, centred on it, and kept on the screen; above it when
  // there is no room below.
  useEffect(() => {
    if (!tip || !card.current) return
    const w = card.current.offsetWidth
    const h = card.current.offsetHeight
    const left = Math.max(8, Math.min(tip.rect.left + tip.rect.width / 2 - w / 2, window.innerWidth - w - 8))
    const below = tip.rect.bottom + 8
    const top = below + h > window.innerHeight - 8 ? tip.rect.top - h - 8 : below
    setPos({ left, top })
  }, [tip])

  if (!tip) return null
  return (
    <div ref={card} className="knob-help" role="tooltip" style={{ left: pos.left, top: pos.top }}>
      <span className="knob-help-label">{tip.label}</span>
      {tip.text}
    </div>
  )
})
