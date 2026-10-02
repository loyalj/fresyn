import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { NOTE_COLORS } from '../patch/notes'
import type { RackNote, RackNoteColor } from '../patch/types'

/**
 * What a note can ask of the rack. One object for the whole rack, like
 * `RackActions`, handed down by context so a unit's notes never make the unit
 * itself redraw.
 */
export interface NoteActions {
  /** A new, empty note on `module`, at `x`, `y` from the corner of the face it is on. */
  add: (module: string, face: RackNote['face'], x: number, y: number) => void
  /** Some of a note's fields. Typing passes `typing`, so a burst of it is one step of undo. */
  edit: (id: string, change: Partial<RackNote>, typing?: boolean) => void
  remove: (id: string) => void
}

export const NoteActionsContext = createContext<NoteActions | null>(null)
/** Whether notes are showing at all: View, Show notes. */
export const NotesShown = createContext(true)

/**
 * The note just made, to be given the focus when it appears so it can be
 * typed into at once. Read and cleared by that note alone.
 */
let focusNext: string | null = null
export function focusNoteWhenShown(id: string) {
  focusNext = id
}

/** A note's width, as app.css draws it: what keeps one inside its unit. */
export const NOTE_WIDTH = 180

/** How far a note's grip must travel before a press becomes a drag. */
const DRAG_SLOP = 3

const COLOR_NAMES: Record<RackNoteColor, string> = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
  violet: 'Violet',
}

/** The notes on one face of one unit. */
export const UnitNotes = memo(function UnitNotes({ notes }: { notes: readonly RackNote[] }) {
  const shown = useContext(NotesShown)
  if (!shown || notes.length === 0) return null
  return (
    <div className="rack-notes">
      {notes.map((n) => (
        <RackNoteView key={n.id} note={n} />
      ))}
    </div>
  )
})

/**
 * One note: a grip to drag it by, its colour, fold and delete, and the text.
 *
 * Dragged by its grip, it moves under the pointer and is set down where it
 * is let go -- on its own unit, or on another, which it then belongs to. The
 * whole move is one step of undo. The text is edited where it is, and goes
 * into the patch as it is typed; a burst of typing is one step of undo.
 */
const RackNoteView = memo(function RackNoteView({ note }: { note: RackNote }) {
  const actions = useContext(NoteActionsContext)
  const ref = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLTextAreaElement>(null)
  const [shift, setShift] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ pointer: number; x0: number; y0: number; moved: boolean } | null>(null)

  useLayoutEffect(() => {
    if (focusNext !== note.id) return
    focusNext = null
    text.current?.focus()
  }, [note.id])

  // Folded back open by a click on its first line: the text wants the focus.
  const [openPending, setOpenPending] = useState(false)
  useEffect(() => {
    if (!openPending || note.collapsed) return
    setOpenPending(false)
    text.current?.focus()
  }, [openPending, note.collapsed])

  if (!actions) return null
  const color = note.color ?? 'yellow'
  const nextColor = NOTE_COLORS[(NOTE_COLORS.indexOf(color) + 1) % NOTE_COLORS.length]
  const firstLine = note.text.split('\n')[0].trim()

  /** Where it lands: the unit under the pointer, and its corner there. */
  const drop = (e: React.PointerEvent) => {
    const el = ref.current
    const face = el?.closest('.unit-face-front, .unit-face-back') as HTMLElement | null
    if (!el || !face) return
    const own = face.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    // The note's corner on the page, where it was let go.
    const left = box.left
    const top = box.top
    // Whatever unit is under the pointer, on the same side as this one; the
    // note itself is in the way of looking, so it is stepped past.
    const under = document
      .elementsFromPoint(e.clientX, e.clientY)
      .filter((n) => !el.contains(n))
      .map((n) => n.closest<HTMLElement>(note.face === 'back' ? '.unit-face-back' : '.unit-face-front'))
      .find((n): n is HTMLElement => !!n && !n.hasAttribute('inert'))
    const target = under ?? face
    const module = target.closest<HTMLElement>('.unit-flip')?.dataset.module ?? note.module
    const rect = target === face ? own : target.getBoundingClientRect()
    const x = Math.max(0, Math.min(left - rect.left, rect.width - NOTE_WIDTH))
    const y = Math.max(0, Math.min(top - rect.top, rect.height - 20))
    actions.edit(note.id, { module, x, y })
  }

  return (
    <div
      ref={ref}
      className={`rack-note rack-note-${color}${note.collapsed ? ' collapsed' : ''}${shift ? ' moving' : ''}`}
      style={{
        // Kept inside its unit -- as far as the unit is wide enough to hold
        // it -- whatever width the unit has since been laid out at.
        left: `max(0px, min(${note.x}px, calc(100% - ${NOTE_WIDTH}px)))`,
        top: `min(${note.y}px, calc(100% - 20px))`,
        transform: shift ? `translate(${shift.x}px, ${shift.y}px)` : undefined,
      }}
      // The rack picks units and pulls cables on a press; a note is neither.
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        className="rack-note-grip"
        title="Drag to move this note, onto another module if you like"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { pointer: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.pointer !== e.pointerId) return
          const dx = e.clientX - d.x0
          const dy = e.clientY - d.y0
          if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
          d.moved = true
          setShift({ x: dx, y: dy })
        }}
        onPointerUp={(e) => {
          const d = drag.current
          if (!d || d.pointer !== e.pointerId) return
          drag.current = null
          if (d.moved) drop(e)
          setShift(null)
        }}
        onPointerCancel={() => {
          drag.current = null
          setShift(null)
        }}
      >
        <button
          type="button"
          className="rack-note-fold"
          aria-label={note.collapsed ? 'Unfold note' : 'Fold note'}
          aria-expanded={!note.collapsed}
          onClick={() => {
            actions.edit(note.id, { collapsed: note.collapsed ? undefined : true })
            if (note.collapsed) setOpenPending(true)
          }}
        >
          {note.collapsed ? '▸' : '▾'}
        </button>
        {note.collapsed && (
          <span className="rack-note-title" onDoubleClick={() => actions.edit(note.id, { collapsed: undefined })}>
            {firstLine || 'Note'}
          </span>
        )}
        <span className="rack-note-spacer" />
        <button
          type="button"
          className="rack-note-color"
          aria-label={`Colour: ${COLOR_NAMES[color]}. Change to ${COLOR_NAMES[nextColor]}`}
          title={`Change colour (${COLOR_NAMES[nextColor]} next)`}
          onClick={() => actions.edit(note.id, { color: nextColor })}
        />
        <button
          type="button"
          className="rack-note-delete"
          aria-label="Delete note"
          title="Delete note (Ctrl+Z brings it back)"
          onClick={() => actions.remove(note.id)}
        >
          ×
        </button>
      </div>
      {!note.collapsed && (
        <textarea
          ref={text}
          className="rack-note-text"
          value={note.text}
          placeholder="Note…"
          aria-label={`Note on ${note.module}`}
          spellCheck
          onChange={(e) => actions.edit(note.id, { text: e.target.value }, true)}
          onKeyDown={(e) => {
            // Escape leaves the note; nothing else in the rack hears it.
            if (e.key === 'Escape') {
              e.stopPropagation()
              e.currentTarget.blur()
            }
          }}
        />
      )}
    </div>
  )
})

const NO_NOTES: readonly RackNote[] = []

/**
 * Each module's notes, as arrays that stay the same from one render to the
 * next until one of that module's notes changes -- so writing in a note on
 * one unit redraws that unit and none of the others, whose props are compared
 * by identity (see `sameUnit`).
 */
export function useNotesByModule(notes: readonly RackNote[] | undefined): ReadonlyMap<string, readonly RackNote[]> {
  const last = useRef(new Map<string, readonly RackNote[]>())
  return useMemo(() => {
    const grouped = new Map<string, RackNote[]>()
    for (const n of notes ?? NO_NOTES) {
      const list = grouped.get(n.module)
      if (list) list.push(n)
      else grouped.set(n.module, [n])
    }
    const out = new Map<string, readonly RackNote[]>()
    for (const [id, list] of grouped) {
      const was = last.current.get(id)
      out.set(id, was && was.length === list.length && was.every((n, i) => n === list[i]) ? was : list)
    }
    last.current = out
    return out
  }, [notes])
}

