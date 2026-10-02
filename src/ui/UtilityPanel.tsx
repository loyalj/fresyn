import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { loadPrefs, savePrefs } from '../patch/storage'

interface Props {
  id: string
  title: string
  /** Where it is in the pile of open panels: later ones are drawn on top. */
  layer: number
  onClose: () => void
  /** Pointed at, so it comes to the top of the pile. */
  onRaise: () => void
  children: ReactNode
}

/**
 * What a utility can ask of the panel it is in: the keys it wants for itself
 * while the panel has the focus -- by code, as `data-claims-keys` takes them
 * (see `InputManager`) -- or none.
 */
interface PanelControl {
  claimKeys: (codes: string | null) => void
  /** The panel's own element, for telling whether the focus is in it. */
  element: () => HTMLElement | null
}

const PanelContext = createContext<PanelControl>({ claimKeys: () => {}, element: () => null })

/** The panel a utility is open in; see `PanelControl`. */
export function useUtilityPanel(): PanelControl {
  return useContext(PanelContext)
}

/**
 * A key of the panel's own while it has the focus -- Space to tap a tempo,
 * Space to start a metronome -- taken from the rack, which plays on it
 * everywhere else. Not while a field in the panel is being typed into, which
 * keeps every key; and not at all while `active` is false, so a utility can
 * claim it on one tab and leave it on the others.
 *
 * The press is handled on the key going down, from its own timestamp, and
 * both edges are kept from pressing whatever button has the focus as well.
 */
export function usePanelKey(code: string, onPress: (e: KeyboardEvent) => void, active = true) {
  const panel = useUtilityPanel()
  const handler = useRef(onPress)
  handler.current = onPress
  useEffect(() => {
    if (!active) return
    panel.claimKeys(code)
    const mine = (e: KeyboardEvent) => {
      const target = e.target
      const box = panel.element()
      if (e.code !== code || !box || !(target instanceof Node) || !box.contains(target)) return false
      return !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
    }
    const onDown = (e: KeyboardEvent) => {
      if (!mine(e)) return
      e.preventDefault()
      handler.current(e)
    }
    const onUp = (e: KeyboardEvent) => {
      if (mine(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      panel.claimKeys(null)
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [panel, code, active])
}

/** Kept clear of the window's edge, so a panel can always be caught again. */
const MARGIN = 8
/** How much of the header must stay on screen: enough to grab. */
const GRAB = 48

/**
 * The frame every utility opens in: a panel that floats over the app rather
 * than a dialog in front of it.
 *
 * Nothing is taken away while one is open. The rack still plays, its keys
 * still work -- a field in a panel keeps its own keys, as any field does --
 * and the song goes on, which is the point of a calculator you want beside
 * you while you set a delay. Dragged by its title bar, it stays where it was
 * put, per utility and across reloads; Escape inside it closes it.
 */
export function UtilityPanel({ id, title, layer, onClose, onRaise, children }: Props) {
  const ref = useRef<HTMLElement>(null)
  const [place, setPlace] = useState<{ x: number; y: number } | null>(() => loadPrefs().utilityPlaces?.[id] ?? null)
  const drag = useRef<{ dx: number; dy: number; pointer: number } | null>(null)
  const [claims, setClaims] = useState<string | null>(null)
  const control = useMemo<PanelControl>(() => ({ claimKeys: setClaims, element: () => ref.current }), [])
  /** Where it is as of the last move, which the release saves: state may not have caught up. */
  const latest = useRef(place)
  latest.current = place

  // Where it was left, pulled back on screen if the window is now smaller;
  // or, the first time, the top right, stepped down for each panel already
  // open so two never open exactly on top of each other.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const start = place ?? { x: window.innerWidth - rect.width - 16 - layer * 24, y: 64 + layer * 24 }
    const fitted = fit(start, rect.width)
    if (!place || fitted.x !== place.x || fitted.y !== place.y) setPlace(fitted)
    // Only on arrival: after that it goes where it is dragged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onResize = () => {
      const el = ref.current
      if (!el) return
      setPlace((p) => (p ? fit(p, el.getBoundingClientRect().width) : p))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <section
      ref={ref}
      className="utility-panel"
      role="dialog"
      aria-label={title}
      // Focusable itself, and focused by a click anywhere in it that lands on
      // nothing that takes focus of its own -- the title, the background --
      // so that "the panel has the focus" means what it looks like it means.
      tabIndex={-1}
      data-claims-keys={claims ?? undefined}
      style={{
        left: place?.x ?? 0,
        top: place?.y ?? 0,
        zIndex: `calc(var(--z-utility) + ${layer})`,
        visibility: place ? undefined : 'hidden',
      }}
      onPointerDownCapture={onRaise}
      onPointerDown={(e) => {
        const target = e.target as HTMLElement
        if (!target.closest('input, select, textarea, button, a, [tabindex]:not(.utility-panel)')) ref.current?.focus()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onClose()
      }}
    >
      <header
        className="utility-head"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button') || !place) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { dx: e.clientX - place.x, dy: e.clientY - place.y, pointer: e.pointerId }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          const el = ref.current
          if (!d || d.pointer !== e.pointerId || !el) return
          const next = fit({ x: e.clientX - d.dx, y: e.clientY - d.dy }, el.getBoundingClientRect().width)
          latest.current = next
          setPlace(next)
        }}
        onPointerUp={(e) => {
          if (!drag.current || drag.current.pointer !== e.pointerId) return
          drag.current = null
          const at = latest.current
          if (at) savePrefs({ utilityPlaces: { ...loadPrefs().utilityPlaces, [id]: at } })
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <h2>{title}</h2>
        <button type="button" className="sheet-close" aria-label={`Close ${title}`} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="utility-body">
        <PanelContext.Provider value={control}>{children}</PanelContext.Provider>
      </div>
    </section>
  )
}

/** Somewhere a panel of this width can be seen and caught again. */
function fit(p: { x: number; y: number }, width: number) {
  const maxX = Math.max(MARGIN, window.innerWidth - Math.min(width, GRAB * 3) - MARGIN)
  const maxY = Math.max(MARGIN, window.innerHeight - GRAB)
  return {
    x: Math.round(Math.min(Math.max(p.x, MARGIN - width + GRAB * 3), maxX)),
    y: Math.round(Math.min(Math.max(p.y, MARGIN), maxY)),
  }
}
