import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type MenuItem =
  | { kind: 'action'; label: string; shortcut?: string; disabled?: boolean; onSelect: () => void }
  /** An action that shows whether it is currently on, like a setting. */
  | { kind: 'toggle'; label: string; shortcut?: string; checked: boolean; onSelect: () => void }
  | { kind: 'submenu'; label: string; items: MenuItem[] }
  | { kind: 'separator' }

export interface MenuDef {
  label: string
  items: MenuItem[]
}

/** Keys that would move the page under an open menu. */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

interface Props {
  menus: MenuDef[]
  /**
   * Raised while any menu is open. The rack owns the keyboard the rest of the
   * time, and a menu that let Space through would play the instrument while
   * you were reading it.
   */
  onOpenChange?: (open: boolean) => void
  /** Collapse everything behind one button, for a bar too narrow to hold it. */
  collapsed?: boolean
}

/**
 * The menu bar across the head of the rack.
 *
 * Built rather than borrowed because the bar has to answer to the app's own
 * input layer: every key in this app is captured on the window, ahead of
 * whatever has focus, so a menu can only work if the rack stands down while
 * one is open. That is the part a component from elsewhere would not know to
 * do.
 *
 * Focus is real focus, moved onto the item buttons, rather than an
 * `aria-activedescendant` pointer. It is more DOM work per keystroke and far
 * less to get wrong: the browser scrolls the focused item into view, reports
 * it to a screen reader, and takes it away again when something else is
 * clicked.
 */
export function MenuBar({ menus, onOpenChange, collapsed }: Props) {
  /** Index of the open top-level menu, or null when the bar is idle. */
  const [open, setOpen] = useState<number | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const triggers = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => onOpenChange?.(open !== null), [open, onOpenChange])

  const close = useCallback((focusTrigger = true) => {
    setOpen((was) => {
      if (was !== null && focusTrigger) triggers.current[was]?.focus()
      return null
    })
  }, [])

  /**
   * Escape closes from anywhere, and the keys that scroll the page are held
   * back while a menu is showing.
   *
   * The rows handle their own arrows, but this is what catches the case where
   * focus never made it into the list: the app's own input layer has stood
   * down by then, so nothing else is stopping the page scrolling out from
   * under the menu being read. Space is deliberately left alone -- a focused
   * row is activated with it.
   */
  useEffect(() => {
    if (open === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (SCROLL_KEYS.has(e.key)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])

  // Anywhere outside the bar shuts it, including the rack behind it.
  useEffect(() => {
    if (open === null) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !bar.current?.contains(e.target)) close(false)
    }
    // Capture, so a click on a jack closes the menu before the rack acts on it.
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open, close])

  const items = collapsed
    ? [{ label: '☰', items: menus.map((m) => ({ kind: 'submenu' as const, label: m.label, items: m.items })) }]
    : menus

  return (
    <div className={`menubar${collapsed ? ' menubar-collapsed' : ''}`} ref={bar} role="menubar">
      {items.map((menu, i) => (
        <div className="menubar-slot" key={menu.label}>
          <button
            className={`menubar-label${open === i ? ' open' : ''}`}
            ref={(el) => {
              triggers.current[i] = el
            }}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            onPointerDown={(e) => {
              // On pointerdown rather than click, so the menu is already open
              // by the time the button would have taken focus.
              e.preventDefault()
              setOpen((was) => (was === i ? null : i))
            }}
            // Once one is open, sweeping across the bar walks the menus, which
            // is what every menu bar has done since they were invented.
            onPointerEnter={() => setOpen((was) => (was === null ? was : i))}
            onKeyDown={(e) => {
              // The app's input layer captures on the window and gets first
              // refusal on every key. It calls preventDefault, but that does
              // not stop the event reaching a handler like this one -- so
              // without this line, Space after closing a menu would reopen it
              // instead of playing the rack, because focus is still here.
              if (e.defaultPrevented) return
              // A combination belongs to the browser or to the app's own
              // bindings; none of them mean "open this menu".
              if (e.ctrlKey || e.metaKey || e.altKey) return
              if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setOpen(i)
              } else if (e.key === 'ArrowRight' && items.length > 1) {
                e.preventDefault()
                triggers.current[(i + 1) % items.length]?.focus()
              } else if (e.key === 'ArrowLeft' && items.length > 1) {
                e.preventDefault()
                triggers.current[(i - 1 + items.length) % items.length]?.focus()
              }
            }}
          >
            {menu.label}
          </button>

          {open === i && (
            <MenuList
              items={menu.items}
              onClose={close}
              onLeave={() => {
                // Left from a top-level menu walks to the previous one, as on
                // the bar itself.
                if (items.length < 2) return close()
                const prev = (i - 1 + items.length) % items.length
                setOpen(prev)
                triggers.current[prev]?.focus()
              }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

interface ListProps {
  items: MenuItem[]
  onClose: (focusTrigger?: boolean) => void
  /** ArrowLeft out of this list, which means something different at each depth. */
  onLeave: () => void
  nested?: boolean
}

function MenuList({ items, onClose, onLeave, nested }: ListProps) {
  const list = useRef<HTMLDivElement>(null)
  /** Which submenu is showing, by item index. */
  const [openSub, setOpenSub] = useState<number | null>(null)
  const id = useId()

  /**
   * Every focusable row of *this* list, in order.
   *
   * A submenu's row is wrapped in a `.menu-slot`, so both shapes have to be
   * asked for. Only one level down either way: the rows of an open submenu
   * belong to that submenu's own list, not to this one.
   */
  const rows = () => [
    ...(list.current?.querySelectorAll<HTMLButtonElement>(
      ':scope > .menu-item, :scope > .menu-slot > .menu-item',
    ) ?? []),
  ]

  useEffect(() => {
    rows()[0]?.focus()
    // Once only: re-running would snatch focus back from a submenu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const step = (from: HTMLElement, delta: number) => {
    const all = rows()
    const at = all.indexOf(from as HTMLButtonElement)
    const next = all[(at + delta + all.length) % all.length]
    next?.focus()
  }

  return (
    <div className={`menu${nested ? ' menu-nested' : ''}`} role="menu" ref={list} id={id}>
      {items.map((item, i) => {
        if (item.kind === 'separator') {
          return <div className="menu-separator" key={`sep${i}`} role="separator" />
        }

        const common = {
          className: 'menu-item',
          role: 'menuitem',
          tabIndex: -1,
          onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              step(e.currentTarget, 1)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              step(e.currentTarget, -1)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault()
              onLeave()
            }
          },
        }

        if (item.kind === 'submenu') {
          return (
            <div className="menu-slot" key={item.label}>
              <button
                {...common}
                aria-haspopup="menu"
                aria-expanded={openSub === i}
                onPointerEnter={(e) => {
                  setOpenSub(i)
                  e.currentTarget.focus()
                }}
                onPointerDown={(e) => {
                  e.preventDefault()
                  setOpenSub((was) => (was === i ? null : i))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setOpenSub(i)
                    return
                  }
                  common.onKeyDown(e)
                }}
              >
                {/* An empty tick column, so its label lines up with the rows
                    around it rather than sitting out in the margin. */}
                <span className="menu-tick" aria-hidden="true" />
                <span className="menu-text">{item.label}</span>
                <span className="menu-more" aria-hidden="true">&#9656;</span>
              </button>
              {openSub === i && (
                <MenuList
                  items={item.items}
                  onClose={onClose}
                  onLeave={() => setOpenSub(null)}
                  nested
                />
              )}
            </div>
          )
        }

        const checked = item.kind === 'toggle' ? item.checked : undefined
        return (
          <button
            {...common}
            key={item.label}
            role={item.kind === 'toggle' ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={checked}
            disabled={item.kind === 'action' ? item.disabled : false}
            // Hovering a plain row closes whatever submenu was showing, so two
            // are never open down one list.
            onPointerEnter={(e) => {
              setOpenSub(null)
              e.currentTarget.focus()
            }}
            onClick={() => {
              item.onSelect()
              onClose(false)
            }}
          >
            <span className="menu-tick" aria-hidden="true">{checked ? '✓' : ''}</span>
            <span className="menu-text">{item.label}</span>
            {'shortcut' in item && item.shortcut && (
              <span className="menu-shortcut" aria-hidden="true">{item.shortcut}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

interface ContextProps {
  /** Where the pointer was, in client coordinates. */
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/**
 * The same menu, opened at the pointer instead of under a label.
 *
 * It goes in a portal on the body because the things worth right-clicking
 * sit inside panels that clip and scroll, and a menu that is cut off by the
 * rail it opened next to is worse than no menu. Being out of the panel is
 * also why it closes on a scroll: it is placed once, against the viewport,
 * and cannot follow the control it belongs to.
 */
export function ContextMenu({ x, y, items, onClose }: ContextProps) {
  const host = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ x, y })

  // Measured and moved before the browser paints, so a menu near an edge is
  // never seen in the wrong place first.
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    // Flipped rather than merely pushed: a menu shoved back from the right
    // edge would sit under the pointer, and the first row would be armed
    // wherever the button came up.
    const nx = x + width > window.innerWidth ? Math.max(0, x - width) : x
    const ny = y + height > window.innerHeight ? Math.max(0, y - height) : y
    setAt((was) => (was.x === nx && was.y === ny ? was : { x: nx, y: ny }))
  }, [x, y])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !host.current?.contains(e.target)) onClose()
    }
    // Capture, so a click on a jack or a knob shuts the menu before the rack
    // acts on it.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div className="context-menu" ref={host} style={{ left: at.x, top: at.y }}>
      <MenuList items={items} onClose={onClose} onLeave={onClose} />
    </div>,
    document.body,
  )
}
