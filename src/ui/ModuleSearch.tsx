import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MODULE_DEFS, MODULE_GROUPS } from '../patch/defs'

/** One thing the search can offer: a module, and for a cable a jack on it. */
export interface SearchPick {
  type: string
  /** The jack a dropped cable goes into, or comes out of. */
  port?: string
}

interface Entry extends SearchPick {
  label: string
  detail: string
  /** Lower case, everything a query may match against. */
  haystack: string
  /** Where it came in the catalogue, to break ties the way the menu reads. */
  order: number
}

interface Props {
  /**
   * When a cable was dropped on empty rack: which side of it is loose. An
   * output looking for somewhere to go wants modules with inputs, and the
   * other way round. Absent, it is a plain search for a module to add.
   */
  cable?: 'input' | 'output'
  /** Module types not to offer: what a Drum Kit's pad cannot hold, while one is open. */
  exclude?: ReadonlySet<string>
  onPick: (pick: SearchPick) => void
  onClose: () => void
}

/**
 * Find a module by typing.
 *
 * The same box for two jobs. Ctrl+K opens it to add any module, which is
 * quicker than three levels of menu once you know the one you want. A cable
 * let go of over empty rack opens it to finish the cable: every jack that
 * could take it is listed, module by module, so "fil" and Enter is a ladder
 * filter wired to what you were holding.
 *
 * Built like the library dialog and for the same reasons: every key is
 * captured on the window ahead of whatever has focus, so this has to be
 * something the rack stands down for, and it takes the keys it needs itself.
 */
export function ModuleSearch({ cable, exclude, onPick, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const entries = useMemo(() => buildEntries(cable, exclude), [cable, exclude])
  const shown = useMemo(() => filter(entries, query), [entries, query])

  useEffect(() => input.current?.focus(), [])
  useEffect(() => setAt(0), [query])
  useEffect(() => {
    list.current?.querySelector('.search-row.at')?.scrollIntoView({ block: 'nearest' })
  }, [at, shown])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAt((i) => Math.min(shown.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAt((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const pick = shown[at]
        if (pick) onPick({ type: pick.type, port: pick.port })
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [shown, at, onPick, onClose])

  const title = cable ? 'Finish the cable' : 'Add a module'
  return createPortal(
    <div
      className="sheet-backdrop search-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sheet search" role="dialog" aria-modal="true" aria-label={title}>
        <input
          ref={input}
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            cable ? `A module to plug this ${cable === 'output' ? 'output' : 'input'} into…` : 'Search modules…'
          }
          aria-label={title}
          spellCheck={false}
        />
        <ul className="search-list" ref={list} role="listbox" aria-label="Matches">
          {shown.length === 0 && <li className="search-empty">Nothing matches “{query}”</li>}
          {shown.map((e, i) => (
            <li key={`${e.type}.${e.port ?? ''}`}>
              <button
                className={`search-row${i === at ? ' at' : ''}`}
                role="option"
                aria-selected={i === at}
                onPointerEnter={() => setAt(i)}
                onClick={() => onPick({ type: e.type, port: e.port })}
                tabIndex={-1}
                type="button"
              >
                <span className="search-name">{e.label}</span>
                <span className="search-detail">{e.detail}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="sheet-foot">
          <span>{cable ? 'Adds the module next to the cable and plugs it in' : 'Adds it at the top of the rack'}</span>
          <span className="sheet-keys">↑↓ choose · Enter to add · Esc to close</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The names on a module's switches, so a search finds a module by what it can
 * be switched to: "flanger" is the Chorus, "notch" the Multimode Filter.
 */
function modes(def: (typeof MODULE_DEFS)[string]) {
  return def.params.flatMap((p) => p.steps ?? []).join(' ')
}

/**
 * Every module, or for a cable every jack it could go into. A module with
 * several matching jacks is listed once per jack, first jack first, because
 * which jack is the whole question: a filter's In and its CV are different
 * cables.
 */
function buildEntries(cable?: 'input' | 'output', exclude?: ReadonlySet<string>): Entry[] {
  const groupName = new Map(MODULE_GROUPS.map((g) => [g.id, g.name]))
  const out: Entry[] = []
  let order = 0
  for (const g of MODULE_GROUPS) {
    for (const def of Object.values(MODULE_DEFS)) {
      if (def.group !== g.id || exclude?.has(def.type)) continue
      const group = groupName.get(def.group) ?? ''
      if (!cable) {
        out.push({
          type: def.type,
          label: def.name,
          detail: group,
          haystack: `${def.name} ${def.type} ${group} ${modes(def)}`.toLowerCase(),
          order: order++,
        })
        continue
      }
      // The loose end is an output, so it wants an input; and the other way.
      const ports = cable === 'output' ? def.inputs : def.outputs
      for (const p of ports) {
        if (p.hidden) continue
        out.push({
          type: def.type,
          port: p.id,
          label: `${def.name} › ${p.label}`,
          detail: group,
          haystack: `${def.name} ${def.type} ${p.label} ${p.id} ${group} ${modes(def)}`.toLowerCase(),
          order: order++,
        })
      }
    }
  }
  return out
}

/**
 * Everything whose words contain every word typed, best first: a name that
 * starts with the query, then a word in it that does, then anything else, and
 * the catalogue's own order within each.
 */
function filter(entries: Entry[], query: string): Entry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return entries
  const scored: { e: Entry; score: number }[] = []
  for (const e of entries) {
    if (!words.every((w) => e.haystack.includes(w))) continue
    const name = e.label.toLowerCase()
    const first = words[0]
    const score = name.startsWith(first) ? 0 : name.split(/[\s›&]+/).some((w) => w.startsWith(first)) ? 1 : 2
    scored.push({ e, score })
  }
  return scored.sort((a, b) => a.score - b.score || a.e.order - b.e.order).map((s) => s.e)
}
