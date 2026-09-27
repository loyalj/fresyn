import { memo, useEffect, useState } from 'react'

export interface RackIndexEntry {
  id: string
  name: string
  bypassed: boolean
}

interface Props {
  /** Every track, each with the patch on it, for the switcher in the title. */
  tracks: readonly { id: string; name: string }[]
  /** The track whose patch the rack is showing. */
  trackId: string
  onSelectTrack: (id: string) => void
  entries: readonly RackIndexEntry[]
  picked: ReadonlySet<string>
  onJump: (id: string) => void
  /** Which side of the rack is showing, and turning it round. */
  flipped: boolean
  onFlip: () => void
}

/**
 * Every unit in the rack by name, on a card in the margin beside it.
 *
 * The same job the header's Jump menu does -- getting to a unit in a long
 * rack without scrolling to look for it -- but always open, which buys the
 * one thing a menu cannot: the units on screen right now are lit, so the
 * list doubles as a map of where in the rack you are.
 *
 * Only where the window leaves a margin wide enough to hold it; below that
 * the stylesheet hides it and the Jump menu comes back.
 */
export const RackIndex = memo(function RackIndex({
  tracks,
  trackId,
  onSelectTrack,
  entries,
  picked,
  onJump,
  flipped,
  onFlip,
}: Props) {
  const inView = useInView(entries.map((e) => e.id).join(' '))

  return (
    <nav className="rack-index-card" aria-label="Units in this rack">
      <div className="rack-index-head">
        {/* Named for the patch on the bench, and the way to put another
            one there: the same switch as picking a track in the dock, without
            opening the dock to do it. */}
        <select
          className="rack-index-title"
          value={trackId}
          // The focus stays here. It used to be thrown to the page after a
          // pick, which also meant the arrow keys could only ever move one
          // track: a closed select changes on each arrow, and the first
          // change blurred it.
          onChange={(e) => onSelectTrack(e.target.value)}
          aria-label="Patch in the rack"
          title="Switch the rack to another track's patch"
        >
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name || 'Untitled'}
            </option>
          ))}
        </select>
        {/* Turning the rack round belongs with the rack rather than with the
            app's menus: it is the control the rack is worked with, and here
            it sits beside the name of what it turns. F and View > Back
            panel still do it where the card is not shown. */}
        <button
          className="flip-button"
          onClick={onFlip}
          title="Turn the rack around (F)"
          aria-pressed={flipped}
          type="button"
        >
          {flipped ? 'Front' : 'Back'}
        </button>
      </div>
      <ul className="rack-index-list">
        {entries.map((e) => (
          <li key={e.id}>
            <button
              className={`rack-index-row${inView.has(e.id) ? ' in-view' : ''}${
                picked.has(e.id) ? ' picked' : ''
              }${e.bypassed ? ' bypassed' : ''}`}
              onClick={() => onJump(e.id)}
              title={`Jump to ${e.id}`}
              type="button"
            >
              <span className={`led ${inView.has(e.id) ? 'on' : ''}`} />
              <span className="rack-index-name">{e.name}</span>
              <span className="rack-index-id">{e.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
})

/**
 * Which units are on screen. Watched rather than worked out on scroll, so
 * the list costs nothing while the page is still. `key` changes whenever the
 * rack's units do, which is when there are new panels to watch.
 */
function useInView(key: string) {
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const visible = new Set<string>()
    const observer = new IntersectionObserver((changes) => {
      for (const c of changes) {
        const id = (c.target as HTMLElement).dataset.module
        if (!id) continue
        if (c.isIntersecting) visible.add(id)
        else visible.delete(id)
      }
      setShown(new Set(visible))
      // The head panel covers the top of the window, so a unit only under it
      // is not one you can see.
    }, { rootMargin: '-60px 0px 0px 0px' })
    document.querySelectorAll<HTMLElement>('.unit-flip[data-module]').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [key])

  return shown
}
