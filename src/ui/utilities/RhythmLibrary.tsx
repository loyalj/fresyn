import { useMemo, useRef, useState } from 'react'
import { parsePattern } from '../../utilities/euclid'
import { RHYTHM_CATEGORIES, searchText, type LibraryRhythm, type RhythmCategory } from '../../utilities/rhythmLibrary'
import { euclidLabel, RHYTHM_LIBRARY } from '../../utilities/rhythms'

type Shelf = 'all' | 'favourites' | 'recent' | RhythmCategory
type Kind = 'all' | 'timeline' | 'groove'

interface Props {
  favourites: readonly string[]
  recent: readonly string[]
  onFavourite: (id: string) => void
  /** The rhythm being heard, or null. */
  previewing: string | null
  onPreview: (r: LibraryRhythm) => void
  /** Its lanes added to the ones there are. */
  onAdd: (r: LibraryRhythm) => void
  /** Its lanes in place of the ones there are. */
  onLoad: (r: LibraryRhythm) => void
  /** How many more lanes there is room for. */
  room: number
}

const CATEGORY_NAME = new Map(RHYTHM_CATEGORIES.map((c) => [c.id, c.name]))
const LABELS = new Map(RHYTHM_LIBRARY.map((r) => [r.id, euclidLabel(r)]))
const TEXT = new Map(RHYTHM_LIBRARY.map((r) => [r.id, searchText(r, CATEGORY_NAME.get(r.category) ?? '', LABELS.get(r.id) ?? null)]))
const BY_ID = new Map(RHYTHM_LIBRARY.map((r) => [r.id, r]))

/**
 * The shelf and the kind last looked at, for as long as the page is open:
 * closing the drawer to write something and opening it again should not walk
 * back to the start.
 */
let lastShelf: Shelf = 'all'
let lastKind: Kind = 'all'

/**
 * The Rhythm utility's library: every timeline and groove it knows, to hear
 * and to start from.
 *
 * Each row draws its rhythm, so it can be read before it is heard: a
 * timeline as one strip, a groove as a strip per drum, all to the same scale
 * of time. ▶ (or Space on the row picked out) plays it on the drum track;
 * **+ Lane** adds a timeline as a lane, **Load** puts a groove in place of
 * the lanes, and **+** adds a groove's lanes to the ones there are. Search
 * looks through names, places, meters and Euclidean counts.
 */
export function RhythmLibrary({ favourites, recent, onFavourite, previewing, onPreview, onAdd, onLoad, room }: Props) {
  const [shelf, setShelfState] = useState<Shelf>(lastShelf)
  const [kind, setKindState] = useState<Kind>(lastKind)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const setShelf = (s: Shelf) => {
    lastShelf = s
    setShelfState(s)
  }
  const setKind = (k: Kind) => {
    lastKind = k
    setKindState(k)
  }

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const pool =
      shelf === 'favourites'
        ? favourites.flatMap((id) => BY_ID.get(id) ?? [])
        : shelf === 'recent'
          ? recent.flatMap((id) => BY_ID.get(id) ?? [])
          : RHYTHM_LIBRARY.filter((r) => shelf === 'all' || r.category === shelf)
    return pool.filter((r) => (kind === 'all' || r.kind === kind) && words.every((w) => TEXT.get(r.id)!.includes(w)))
  }, [shelf, kind, query, favourites, recent])

  const current = shown.find((r) => r.id === active) ?? null
  const fits = (r: LibraryRhythm) => r.lanes.length <= room

  const apply = (r: LibraryRhythm) => (r.kind === 'timeline' ? fits(r) && onAdd(r) : onLoad(r))

  const move = (by: number) => {
    if (!shown.length) return
    const at = shown.findIndex((r) => r.id === active)
    const next = shown[Math.max(0, Math.min(shown.length - 1, at < 0 ? 0 : at + by))]
    setActive(next.id)
    document.getElementById(`rhythm-entry-${next.id}`)?.scrollIntoView({ block: 'nearest' })
  }

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      move(e.key === 'PageDown' ? 8 : -8)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      move(e.key === 'End' ? shown.length : -shown.length)
    } else if (e.key === ' ' && current) {
      e.preventDefault()
      onPreview(current)
    } else if (e.key === 'Enter' && current) {
      e.preventDefault()
      apply(current)
    }
  }

  const chip = (id: Shelf, name: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={shelf === id}
      className={`rhythm-chip${shelf === id ? ' on' : ''}`}
      onClick={() => setShelf(id)}
    >
      {name}
    </button>
  )

  return (
    <div className="rhythm-library">
      <div className="rhythm-library-bar">
        <input
          type="search"
          className="rhythm-search"
          value={query}
          placeholder={`Search ${RHYTHM_LIBRARY.length} rhythms: a name, a place, 7/8, E(3,8)…`}
          aria-label="Search the rhythm library"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              list.current?.focus()
              if (!current) move(0)
            }
          }}
        />
        <div className="rhythm-kinds" role="radiogroup" aria-label="Show">
          {(['all', 'timeline', 'groove'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : k === 'timeline' ? 'Timelines' : 'Grooves'}
            </button>
          ))}
        </div>
      </div>

      <div className="rhythm-shelves" role="tablist" aria-label="Shelves">
        {chip('favourites', '★')}
        {chip('recent', 'Recent')}
        {chip('all', 'All')}
        {RHYTHM_CATEGORIES.map((c) => chip(c.id, c.name))}
      </div>

      <div
        ref={list}
        className="rhythm-library-list"
        role="listbox"
        tabIndex={0}
        aria-label="Rhythms"
        aria-activedescendant={current ? `rhythm-entry-${current.id}` : undefined}
        onKeyDown={onListKey}
        onFocus={() => !current && shown.length && setActive(shown[0].id)}
      >
        {shown.map((r) => {
          const label = LABELS.get(r.id)
          const starred = favourites.includes(r.id)
          return (
            <div
              key={r.id}
              id={`rhythm-entry-${r.id}`}
              role="option"
              aria-selected={r.id === active}
              className={`rhythm-entry${r.id === active ? ' active' : ''}`}
              title={r.description}
              onClick={() => setActive(r.id)}
              onDoubleClick={() => apply(r)}
            >
              <button
                type="button"
                className={`rhythm-hit${previewing === r.id ? ' on' : ''}`}
                aria-label={`${previewing === r.id ? 'Stop' : 'Hear'} ${r.name}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  setActive(r.id)
                  onPreview(r)
                }}
              >
                {previewing === r.id ? '■' : '▶'}
              </button>
              <div className="rhythm-entry-text">
                <div className="rhythm-entry-name">
                  <span>{r.name}</span>
                  {label && <span className="rhythm-badge">{label}</span>}
                </div>
                <div className="rhythm-entry-meta">
                  {r.origin} · {r.meter}
                  {r.kind === 'groove' ? ` · ${r.lanes.length} drums` : ''}
                </div>
              </div>
              <Strips rhythm={r} />
              <button
                type="button"
                className={`rhythm-star${starred ? ' on' : ''}`}
                aria-pressed={starred}
                aria-label={`${starred ? 'Unfavourite' : 'Favourite'} ${r.name}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  onFavourite(r.id)
                }}
              >
                ★
              </button>
              <span className="rhythm-entry-actions">
                {r.kind === 'groove' && (
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={!fits(r)}
                    title={fits(r) ? 'Add its drums to your lanes' : 'Not enough room for its lanes'}
                    aria-label={`Add ${r.name}'s lanes`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onAdd(r)
                    }}
                  >
                    +
                  </button>
                )}
                <button
                  type="button"
                  tabIndex={-1}
                  className="rhythm-apply"
                  disabled={r.kind === 'timeline' && !fits(r)}
                  title={r.kind === 'timeline' ? 'Add it as a lane' : 'Put its drums in place of your lanes'}
                  onClick={(e) => {
                    e.stopPropagation()
                    apply(r)
                  }}
                >
                  {r.kind === 'timeline' ? '+ Lane' : 'Load'}
                </button>
              </span>
            </div>
          )
        })}
        {shown.length === 0 && (
          <p className="timing-dim rhythm-library-empty">
            {shelf === 'favourites' && !favourites.length
              ? 'No favourites yet: ★ a rhythm to keep it here.'
              : shelf === 'recent' && !recent.length
                ? 'Nothing used yet.'
                : 'Nothing matches.'}
          </p>
        )}
      </div>

      <p className="timing-dim rhythm-library-detail" aria-live="polite">
        {current ? current.description : `${shown.length} of ${RHYTHM_LIBRARY.length}. ↑↓ to move, Space to hear, Enter to use.`}
      </p>
    </div>
  )
}

/** A rhythm drawn small: a strip per lane, each as long as its cycle lasts against the longest. */
function Strips({ rhythm }: { rhythm: LibraryRhythm }) {
  const lasts = rhythm.lanes.map((l) => l.pattern.length / (l.perBeat ?? rhythm.perBeat))
  const longest = Math.max(...lasts)
  return (
    <div className={`rhythm-mini${rhythm.lanes.length > 1 ? ' stacked' : ''}`} aria-hidden="true">
      {rhythm.lanes.map((l, i) => (
        <div key={i} className="rhythm-mini-lane" style={{ width: `${(lasts[i] / longest) * 100}%` }}>
          {parsePattern(l.pattern).map((s, k) => (
            <span key={k} className={s.accent ? 'accent' : s.ghost ? 'ghost' : s.hit ? 'hit' : ''} />
          ))}
        </div>
      ))}
    </div>
  )
}
