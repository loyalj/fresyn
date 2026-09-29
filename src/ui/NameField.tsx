import { useLayoutEffect, useRef, useState } from 'react'

/**
 * A name shown in a list -- a track's, a pattern's -- that is renamed where it
 * stands, but only when asked.
 *
 * It used to be a live text field, so the click that meant "this one" also
 * meant "start typing": a caret appeared, and the next keys pressed, which in
 * this app play the rack, renamed the track instead. Now a click, or tabbing
 * in, picks the row and nothing else; a double-click, Enter or F2 starts the
 * rename, with the whole name selected so typing replaces it. Enter or
 * leaving the field finishes, Escape puts back what it was, and a name left
 * blank goes back to what it was too -- a row with no name is a row nobody
 * can find.
 *
 * Still an input throughout, read-only while it is not being edited, so the
 * name is one element whatever it is doing and reads out the same way.
 */
export function NameField({
  value,
  label,
  title,
  className,
  onSelect,
  onRename,
}: {
  value: string
  /** What a screen reader calls it: "Track name". */
  label: string
  title?: string
  className: string
  onSelect: () => void
  /** Called as it is typed, so the name changes everywhere while it is written. */
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  /** What the name was when editing began, for Escape and for a blank. */
  const before = useRef(value)

  const field = useRef<HTMLInputElement>(null)

  const start = () => {
    before.current = value
    setEditing(true)
  }

  // The whole name selected as the rename begins, so typing replaces it --
  // in a layout effect, which runs before the next key can arrive, and after
  // the render that lifts read-only, which a selection made any sooner would
  // be on a field still refusing the keys about to replace it.
  useLayoutEffect(() => {
    if (editing) field.current?.select()
  }, [editing])

  return (
    <input
      ref={field}
      className={`${className}${editing ? ' editing' : ''}`}
      value={value}
      readOnly={!editing}
      spellCheck={false}
      aria-label={label}
      title={editing ? undefined : (title ?? 'Double-click to rename')}
      // Picked on focus as well as on the row, so tabbing to a name picks
      // that row rather than leaving you looking at another one.
      onFocus={onSelect}
      // The second click of a double-click, or any after it -- read off the
      // click count rather than waiting for a dblclick event, which a
      // triple-click sent all at once never raises.
      onClick={(e) => {
        if (!editing && e.detail >= 2) start()
      }}
      onChange={(e) => onRename(e.target.value)}
      onKeyDown={(e) => {
        if (!editing) {
          if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault()
            start()
          }
          return
        }
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          onRename(before.current)
          // Blurred after the render that puts the old name back, so the
          // blank check below sees the restored name rather than the edit.
          const el = e.currentTarget
          requestAnimationFrame(() => el.blur())
        }
      }}
      onBlur={(e) => {
        if (!editing) return
        setEditing(false)
        const trimmed = e.currentTarget.value.trim()
        if (!trimmed) onRename(before.current)
        else if (trimmed !== e.currentTarget.value) onRename(trimmed)
      }}
    />
  )
}
