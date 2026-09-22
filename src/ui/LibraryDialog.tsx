import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LIBRARY, type Template } from '../patch/library'

interface Props {
  onPick: (template: Template) => void
  onClose: () => void
}

/**
 * The shelf of racks to start from.
 *
 * Built here rather than borrowed, for the same reason the menu bar is: every
 * key in this app is captured on the window ahead of whatever holds focus, so
 * anything that wants the keyboard has to be something the rack knows to
 * stand down for. `App` raises that flag while this is open.
 *
 * Focus is real focus on the row buttons rather than an
 * `aria-activedescendant` pointer, which is the same choice the menu makes:
 * the browser then scrolls the row into view and announces it without this
 * component doing either.
 */
export function LibraryDialog({ onPick, onClose }: Props) {
  const [at, setAt] = useState(0)
  const rows = useRef<(HTMLButtonElement | null)[]>([])
  /** Whatever had focus before this opened, to hand it back on the way out. */
  const restore = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    rows.current[0]?.focus()
    return () => restore.current?.focus()
  }, [])

  // Captured, because the app's own input layer is suspended while this is
  // open and nothing else is listening: without this, Escape would reach the
  // page and do nothing at all.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const last = LIBRARY.length - 1
      const go = (to: number) => {
        e.preventDefault()
        const next = to < 0 ? last : to > last ? 0 : to
        setAt(next)
        rows.current[next]?.focus()
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') go(at + 1)
      else if (e.key === 'ArrowUp') go(at - 1)
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(last)
      else if (e.key === 'Tab') {
        // A dialog keeps the keyboard until it is dismissed. Tabbing out of it
        // would leave a modal sheet up with the focus somewhere underneath.
        e.preventDefault()
        go(e.shiftKey ? at - 1 : at + 1)
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [at, onClose])

  return createPortal(
    <div
      className="sheet-backdrop"
      // Clicking away is the other way out, and the same one every dialog has.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="library-title">
        <div className="sheet-head">
          <div>
            <h2 id="library-title">Patch library</h2>
            {/* Said here rather than discovered later. A library that looked
                like a file list would have people expecting their work back
                out of it. */}
            <p className="sheet-note">
              Racks to start from. Choosing one replaces what is on the bench with a copy —
              templates are never written back, so your changes are yours to save as a file.
            </p>
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="Close" type="button">
            &times;
          </button>
        </div>

        <ul className="library" role="list">
          {LIBRARY.map((template, i) => (
            <li key={template.id}>
              <button
                className={`library-row${i === at ? ' at' : ''}`}
                ref={(el) => {
                  rows.current[i] = el
                }}
                onClick={() => onPick(template)}
                onPointerEnter={() => setAt(i)}
                tabIndex={i === at ? 0 : -1}
                type="button"
              >
                <span className="library-name">{template.name}</span>
                <span className="library-tutorial">Tutorial {template.tutorial}</span>
                <span className="library-description">{template.description}</span>
                <span className="library-teaches">{template.teaches}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="sheet-foot">
          <span>{LIBRARY.length} racks · every one of them renders a sound</span>
          <span className="sheet-keys">↑↓ to move · Enter to load · Esc to close</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
