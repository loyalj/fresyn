import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CATEGORIES, LIBRARY, type Category, type Template } from '../patch/library'
import {
  buildMyPatch,
  deleteMyPatch,
  loadFavourites,
  loadMyPatches,
  loadRecent,
  noteRecent,
  toggleFavourite,
  type MyPatch,
} from '../patch/myLibrary'

interface Props {
  onPick: (template: Template) => void
  onClose: () => void
  /**
   * Put the rack on the bench onto the My patches shelf. Returns the name it
   * was saved under, or null when it could not be.
   */
  onSave: () => string | null
}

/** The shelves this browser keeps, above the ones the app ships with. */
type Personal = 'favourites' | 'recent' | 'mine'
type Shelf = Personal | Category

const PERSONAL: { id: Personal; name: string }[] = [
  { id: 'favourites', name: '★ Favourites' },
  { id: 'recent', name: 'Recent' },
  { id: 'mine', name: 'My patches' },
]

/**
 * The shelf last looked at, for as long as the page is open. Somebody picking
 * a second bass should not have to walk back past the tutorials to find it.
 */
let lastShelf: Shelf = 'tutorial'

/** One row: a shipped template or a saved rack, looked at the same way. */
interface Item {
  template: Template
  badge: string
  /** Set on a rack you saved, which can be deleted from here. */
  mine?: MyPatch
}

/**
 * What the badge on a row says: which tutorial, or for an instrument how it
 * plays -- chords, one line at a time, or a single hit. Worked out once, from
 * the racks themselves, rather than written beside each one where it could
 * drift from what the rack does.
 */
const badges = new Map<string, string>()
function badgeOf(t: Template): string {
  const known = badges.get(t.id)
  if (known) return known
  let badge: string
  if (t.category === 'tutorial') badge = t.tutorial ? `Tutorial ${t.tutorial}` : 'Start here'
  else {
    const { patch, values } = t.build()
    const keys = patch.modules.find((m) => m.type === 'keys')
    const voices = keys ? (values[`${keys.id}.voices`] ?? 1) : 0
    badge = !keys ? 'Hit' : voices > 1 ? `${voices} voices` : 'Mono'
  }
  badges.set(t.id, badge)
  return badge
}

/** A saved rack, dressed as a template so everything downstream treats it as one. */
function itemOfMine(p: MyPatch): Item {
  const when = new Date(p.savedAt)
  return {
    template: {
      id: p.id,
      name: p.name,
      // Not a shelf it sits on -- the dialog files these itself -- but a
      // template has to name one, and nothing downstream reads it.
      category: 'tutorial',
      description: `Saved ${when.toLocaleDateString()} at ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      build: () => buildMyPatch(p),
    },
    badge: 'Mine',
    mine: p,
  }
}

/**
 * The shelves of racks to start from.
 *
 * Built here rather than borrowed, for the same reason the menu bar is: every
 * key in this app is captured on the window ahead of whatever holds focus, so
 * anything that wants the keyboard has to be something the rack knows to
 * stand down for. `App` raises that flag while this is open.
 *
 * Focus is real focus on the row buttons rather than an
 * `aria-activedescendant` pointer, which is the same choice the menu makes:
 * the browser then scrolls the row into view and announces it without this
 * component doing either. The shelves down the side are moved between with
 * the left and right arrows, so the hands never leave the arrow keys; a
 * click on one does the same.
 */
export function LibraryDialog({ onPick, onClose, onSave }: Props) {
  const [shelf, setShelf] = useState<Shelf>(lastShelf)
  const [at, setAt] = useState(0)
  const [mine, setMine] = useState(loadMyPatches)
  const [favourites, setFavourites] = useState(loadFavourites)
  const recent = useMemo(loadRecent, [])
  /** The row whose delete has been pressed once and is waiting to be confirmed. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const rows = useRef<(HTMLButtonElement | null)[]>([])
  /** Whatever had focus before this opened, to hand it back on the way out. */
  const restore = useRef<HTMLElement | null>(null)
  /** Set when a shelf change should put the focus on its first row. */
  const refocus = useRef(false)

  /** Everything the dialog can show, by id: shipped and saved alike. */
  const byId = useMemo(() => {
    const map = new Map<string, Item>()
    for (const t of LIBRARY) map.set(t.id, { template: t, badge: badgeOf(t) })
    for (const p of mine) map.set(p.id, itemOfMine(p))
    return map
  }, [mine])

  const shelves = useMemo(
    () => [
      ...PERSONAL.map((s) => ({
        ...s,
        count:
          s.id === 'mine' ? mine.length : (s.id === 'favourites' ? favourites : recent).filter((id) => byId.has(id)).length,
      })),
      ...CATEGORIES.map((c) => ({ ...c, count: LIBRARY.filter((t) => t.category === c.id).length })),
    ],
    [mine, favourites, recent, byId],
  )

  const shown = useMemo<Item[]>(() => {
    if (shelf === 'mine') return mine.map(itemOfMine)
    if (shelf === 'favourites' || shelf === 'recent') {
      return (shelf === 'favourites' ? favourites : recent).flatMap((id) => byId.get(id) ?? [])
    }
    return LIBRARY.filter((t) => t.category === shelf).map((t) => byId.get(t.id)!)
  }, [shelf, mine, favourites, recent, byId])

  useEffect(() => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    rows.current[0]?.focus()
    return () => restore.current?.focus()
  }, [])

  useEffect(() => {
    lastShelf = shelf
    setConfirming(null)
    if (!refocus.current) return
    refocus.current = false
    rows.current[0]?.focus()
  }, [shelf])

  const goShelf = (to: Shelf) => {
    if (to === shelf) return
    refocus.current = true
    setShelf(to)
    setAt(0)
  }

  const pick = (item: Item) => {
    noteRecent(item.template.id)
    onPick(item.template)
  }

  const star = (id: string) => setFavourites(toggleFavourite(id))

  const remove = (id: string) => {
    if (confirming !== id) {
      setConfirming(id)
      return
    }
    deleteMyPatch(id)
    setConfirming(null)
    setMine(loadMyPatches())
    setFavourites(loadFavourites())
    setAt((i) => Math.max(0, Math.min(i, mine.length - 2)))
  }

  const save = () => {
    if (onSave() === null) return
    setMine(loadMyPatches())
    refocus.current = true
    setShelf('mine')
    setAt(0)
  }

  // Captured, because the app's own input layer is suspended while this is
  // open and nothing else is listening: without this, Escape would reach the
  // page and do nothing at all.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const last = shown.length - 1
      const go = (to: number) => {
        e.preventDefault()
        const next = to < 0 ? last : to > last ? 0 : to
        setAt(next)
        rows.current[next]?.focus()
      }
      const shift = (by: number) => {
        e.preventDefault()
        const i = shelves.findIndex((c) => c.id === shelf)
        const n = shelves.length
        goShelf(shelves[(i + by + n) % n].id)
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') go(at + 1)
      else if (e.key === 'ArrowUp') go(at - 1)
      else if (e.key === 'ArrowRight') shift(1)
      else if (e.key === 'ArrowLeft') shift(-1)
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(last)
      else if (e.key.toLowerCase() === 'f' && shown[at]) {
        // F stars the row the keyboard is on, the one mouse-free way to it.
        e.preventDefault()
        star(shown[at].template.id)
      } else if (e.key === 'Tab') {
        // A dialog keeps the keyboard until it is dismissed. Tabbing out of it
        // would leave a modal sheet up with the focus somewhere underneath.
        e.preventDefault()
        go(e.shiftKey ? at - 1 : at + 1)
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
    // goShelf and star are rebuilt each render and read only what is here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, shelf, shown, shelves, onClose])

  const shelfName = shelves.find((c) => c.id === shelf)?.name ?? ''
  const empty =
    shelf === 'mine'
      ? 'Nothing saved yet. "Save this rack here" below puts the rack on the bench on this shelf.'
      : shelf === 'favourites'
        ? 'Nothing starred yet. The ☆ on any rack, or F, puts it here.'
        : shelf === 'recent'
          ? 'Racks you open from the library appear here.'
          : ''

  return createPortal(
    <div
      className="sheet-backdrop"
      // Clicking away is the other way out, and the same one every dialog has.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sheet sheet-wide" role="dialog" aria-modal="true" aria-labelledby="library-title">
        <div className="sheet-head">
          <div>
            <h2 id="library-title">Patch library</h2>
            {/* Said here rather than discovered later. A library that looked
                like a file list would have people expecting their work back
                out of it. */}
            <p className="sheet-note">
              Racks to start from. Choosing one replaces what is on the bench with a copy. Your own
              racks can be kept here too, in this browser — a saved file is still how one travels.
            </p>
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="Close" type="button">
            &times;
          </button>
        </div>

        <div className="library-body">
          <div className="library-shelves" role="tablist" aria-orientation="vertical" aria-label="Shelves">
            {shelves.map((c, i) => (
              <button
                key={c.id}
                className={`library-shelf${c.id === shelf ? ' at' : ''}${i === PERSONAL.length - 1 ? ' last-personal' : ''}`}
                role="tab"
                aria-selected={c.id === shelf}
                aria-controls="library-list"
                // Reached by the arrows, like everything else here; a Tab stop
                // of their own would split the keyboard between two lists.
                tabIndex={-1}
                onClick={() => goShelf(c.id)}
                type="button"
              >
                <span>{c.name}</span>
                <span className="library-count">{c.count}</span>
              </button>
            ))}
          </div>

          <ul className="library" id="library-list" role="tabpanel" aria-label={shelfName}>
            {shown.length === 0 && <li className="library-empty">{empty}</li>}
            {shown.map((item, i) => {
              const id = item.template.id
              const starred = favourites.includes(id)
              return (
                <li key={id} className="library-item">
                  <button
                    className={`library-row${i === at ? ' at' : ''}`}
                    ref={(el) => {
                      rows.current[i] = el
                    }}
                    onClick={() => pick(item)}
                    onPointerEnter={() => setAt(i)}
                    tabIndex={i === at ? 0 : -1}
                    type="button"
                  >
                    <span className="library-name">{item.template.name}</span>
                    <span className="library-tutorial">{item.badge}</span>
                    <span className="library-description">{item.template.description}</span>
                    {item.template.teaches && <span className="library-teaches">{item.template.teaches}</span>}
                    {item.template.tip && <span className="library-tip">{item.template.tip}</span>}
                  </button>
                  {/* Beside the row rather than in it: a button inside a button
                      is not a thing a browser will let be clicked on its own. */}
                  <div className="library-actions">
                    <button
                      className={`library-star${starred ? ' on' : ''}`}
                      onClick={() => star(id)}
                      title={starred ? 'Take off Favourites' : 'Add to Favourites (F)'}
                      aria-label={starred ? `Take ${item.template.name} off Favourites` : `Add ${item.template.name} to Favourites`}
                      aria-pressed={starred}
                      tabIndex={-1}
                      type="button"
                    >
                      {starred ? '★' : '☆'}
                    </button>
                    {item.mine && (
                      <button
                        className={`library-delete${confirming === id ? ' confirm' : ''}`}
                        onClick={() => remove(id)}
                        onPointerLeave={() => confirming === id && setConfirming(null)}
                        title="Delete from My patches"
                        aria-label={`Delete ${item.template.name}`}
                        tabIndex={-1}
                        type="button"
                      >
                        {confirming === id ? 'Delete?' : '×'}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="sheet-foot">
          <button className="dock-toggle" onClick={save} type="button" title="Keep the rack on the bench on the My patches shelf, under the track's name">
            Save this rack here
          </button>
          <span className="sheet-keys">↑↓ rack · ←→ shelf · F star · Enter to load · Esc to close</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
