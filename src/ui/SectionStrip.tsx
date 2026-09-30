import { useRef, useState } from 'react'
import {
  addSection,
  colorSection,
  deleteSectionAndMusic,
  duplicateSection,
  moveSection,
  removeSection,
  renameSection,
  resizeSection,
  roomFor,
  sectionEnd,
  sectionsOf,
  slideSection,
  splitSection,
} from '../song/section'
import type { Bars } from '../song/timeline'
import type { Section, Song } from '../song/types'
import { ContextMenu, type MenuItem } from './Menu'
import { nextHue } from './palette'

interface Props {
  song: Song
  /** How wide the timeline is, in pixels, and how many pixels a tick is. */
  width: number
  ppt: number
  /** The song's bars, and the shortest a section can be made. */
  bars: Bars
  minimum: number
  /** A tick onto the playlist's snap, or onto the tick with `free`. */
  snap: (tick: number, free: boolean, how?: 'round' | 'floor') => number
  /** The section being looped, by its start, or null for the whole song. */
  section: number | null
  onSection: (tick: number | null) => void
  onEdit: (fn: (song: Song) => Song) => void
}

/** A new section made with a click rather than a drag: a four-bar phrase. */
const CLICK_BARS = 4
/** How far a press on a section travels before it is a drag and not a click. */
const DRAG_PX = 4

type Drag =
  | { kind: 'create'; from: number; to: number; x0: number; moved: boolean }
  /**
   * A section in hand. It follows the pointer, held `grab` ticks from its
   * start, and would start at `at`. Where that is clear of other sections it
   * slides there with its music (`slide`); over other sections it goes into
   * the gap `index` names instead, and they make room -- see `moveSection`.
   */
  | { kind: 'move'; tick: number; x0: number; grab: number; at: number; slide: boolean; moved: boolean; index: number }
  | { kind: 'resize'; tick: number; edge: 'start' | 'end'; at: number }

/**
 * The sections strip over the playlist: the song's arranger track.
 *
 * Drag across empty strip to make a section that long, or click for a
 * four-bar one. A section is clicked to loop it, double-clicked to rename it,
 * dragged by its edges to move them, and dragged by its body to another place
 * in the song -- taking its music with it, and opening and closing the song
 * up around it. Its × and its right-click menu take the label away and leave
 * the music; the menu also duplicates it, music and all, and cuts it in two.
 */
export function SectionStrip({ song, width, ppt, bars, minimum, snap, section, onSection, onEdit }: Props) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [drag, setDragState] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const setDrag = (next: Drag | null) => {
    dragRef.current = next
    setDragState(next)
  }
  const [renaming, setRenaming] = useState<{ tick: number; name: string } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const all = sectionsOf(song)
  // A resize is drawn as it would land, from the same edit that will land it.
  const shown =
    drag?.kind === 'resize' ? sectionsOf(resizeSection(song, drag.tick, drag.edge, drag.at, minimum)) : all

  /** A click's worth of section from a tick: four bars, in whatever meter they are in. */
  const clickLength = (at: number) => bars.bar(bars.at(at).index + CLICK_BARS).tick - at
  const tickAt = (clientX: number) => (clientX - layerRef.current!.getBoundingClientRect().left) / ppt
  const sectionEl = (target: EventTarget) =>
    target instanceof Element ? target.closest<HTMLElement>('.playlist-section') : null

  /** Loop a section, or stop looping it. */
  const toggle = (tick: number) => onSection(section === tick ? null : tick)

  /**
   * Apply an edit that can move the section being looped, and keep looping
   * it wherever it went. Sections have names no other has, so it is found by
   * its name afterwards.
   */
  const editKeepingLoop = (fn: (s: Song) => Song) => {
    onEdit(fn)
    const looped = section === null ? undefined : all.find((s) => s.tick === section)
    if (!looped) return
    const moved = sectionsOf(fn(song)).find((s) => s.name === looped.name)
    if (moved && moved.tick !== section) onSection(moved.tick)
  }

  const remove = (tick: number) => {
    if (section === tick) onSection(null)
    onEdit((s) => removeSection(s, tick))
  }

  /** Where a section being dragged would land, as a gap between sections: past the middles it is past. */
  const landing = (tick: number) => all.filter((s) => s.tick + s.length / 2 < tick).length

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('input, .playlist-section-remove')) return
    const el = sectionEl(e.target)
    const x = tickAt(e.clientX)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (!el) {
      const from = snap(x, e.altKey, 'floor')
      setDrag({ kind: 'create', from, to: from, x0: e.clientX, moved: false })
      return
    }
    const tick = Number(el.dataset.tick)
    const edge = target?.closest<HTMLElement>('.playlist-section-edge')?.dataset.edge as 'start' | 'end' | undefined
    if (edge) {
      const s = all.find((x) => x.tick === tick)!
      setDrag({ kind: 'resize', tick, edge, at: edge === 'start' ? s.tick : sectionEnd(s) })
      return
    }
    setDrag({ kind: 'move', tick, x0: e.clientX, grab: x - tick, at: tick, slide: true, moved: false, index: landing(x) })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const x = tickAt(e.clientX)
    if (d.kind === 'create') {
      const moved = Math.abs(e.clientX - d.x0) > DRAG_PX
      const to = snap(x, e.altKey)
      if (to !== d.to || (moved && !d.moved)) setDrag({ ...d, to, moved: d.moved || moved })
    } else if (d.kind === 'move') {
      const moved = d.moved || Math.abs(e.clientX - d.x0) > DRAG_PX
      const s = all.find((x) => x.tick === d.tick)
      if (!s) return
      const at = snap(x - d.grab, e.altKey)
      const slide = roomFor(song, s, at)
      const index = landing(x)
      if (at !== d.at || index !== d.index || slide !== d.slide || moved !== d.moved) setDrag({ ...d, at, slide, index, moved })
    } else {
      const at = snap(x, e.altKey)
      if (at !== d.at) setDrag({ ...d, at })
    }
  }

  const onPointerUp = () => {
    const d = dragRef.current
    if (!d) return
    setDrag(null)
    if (d.kind === 'create') {
      const from = Math.min(d.from, d.to)
      const length = Math.abs(d.to - d.from)
      if (d.moved && length >= minimum) onEdit((s) => addSection(s, from, length))
      else if (!d.moved) onEdit((s) => addSection(s, d.from, clickLength(d.from)))
    } else if (d.kind === 'move') {
      // A press that went nowhere is a click, which `onClick` answers.
      if (!d.moved) return
      if (d.slide) editKeepingLoop((s) => slideSection(s, d.tick, d.at))
      else editKeepingLoop((s) => moveSection(s, d.tick, d.index))
    } else {
      editKeepingLoop((s) => resizeSection(s, d.tick, d.edge, d.at, minimum))
    }
  }

  /**
   * The section under a click. Found by where the pointer is rather than by
   * the event's target: the strip holds the pointer from the press on, so
   * the click and the double-click after it are the strip's, not the
   * section's.
   */
  const clicked = (e: React.MouseEvent) => {
    const el = sectionEl(document.elementFromPoint(e.clientX, e.clientY) ?? e.target)
    return el ? all.find((s) => s.tick === Number(el.dataset.tick)) : undefined
  }

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = sectionEl(e.target)
    const at = snap(tickAt(e.clientX), false, 'floor')
    if (!el) {
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [{ kind: 'action', label: 'Add a section here', onSelect: () => onEdit((s) => addSection(s, at, clickLength(at))) }],
      })
      return
    }
    const s = all.find((x) => x.tick === Number(el.dataset.tick))
    if (!s) return
    const under = bars.at(tickAt(e.clientX))
    const barAt = under.tick
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { kind: 'toggle', label: 'Loop this section', checked: section === s.tick, onSelect: () => toggle(s.tick) },
        { kind: 'action', label: 'Rename...', shortcut: 'Double-click', onSelect: () => setRenaming({ tick: s.tick, name: s.name }) },
        { kind: 'action', label: 'Next colour', onSelect: () => onEdit((x) => colorSection(x, s.tick, nextHue(s.color) ?? null)) },
        { kind: 'action', label: 'No colour', disabled: s.color === undefined, onSelect: () => onEdit((x) => colorSection(x, s.tick, null)) },
        { kind: 'separator' },
        {
          kind: 'action',
          label: 'Duplicate, with its music',
          onSelect: () => editKeepingLoop((x) => duplicateSection(x, s.tick)),
        },
        {
          kind: 'action',
          label: `Split at bar ${under.index + 1}`,
          disabled: barAt <= s.tick || barAt >= sectionEnd(s),
          onSelect: () => onEdit((x) => splitSection(x, barAt)),
        },
        { kind: 'separator' },
        { kind: 'action', label: 'Remove section (keeps the music)', shortcut: 'Del', onSelect: () => remove(s.tick) },
        {
          kind: 'action',
          label: 'Delete section and its music',
          onSelect: () => {
            if (section === s.tick) onSection(null)
            editKeepingLoop((x) => deleteSectionAndMusic(x, s.tick))
          },
        },
      ],
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, s: Section) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') toggle(s.tick)
    else if (e.key === 'F2') setRenaming({ tick: s.tick, name: s.name })
    else if (e.key === 'Delete' || e.key === 'Backspace') remove(s.tick)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const create = drag?.kind === 'create' && drag.moved ? drag : null
  const moving = drag?.kind === 'move' && drag.moved ? drag : null

  return (
    <div className="playlist-sections">
      <span className="playlist-label playlist-label-quiet" title="Sections">
        §
      </span>
      <div
        className="playlist-section-layer"
        ref={layerRef}
        style={{ width }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onContextMenu={onContextMenu}
        onClick={(e) => {
          // The first click of a double-click loops; the second does not
          // undo it, since that one is on its way to a rename.
          const s = clicked(e)
          if (s && e.detail === 1 && !(e.target instanceof Element && e.target.closest('input'))) toggle(s.tick)
        }}
        onDoubleClick={(e) => {
          const s = clicked(e)
          if (s) setRenaming({ tick: s.tick, name: s.name })
        }}
        title="Drag across to make a section, or click for a four-bar one"
      >
        {shown.map((s) => {
          const on = section === s.tick
          return (
            <div
              key={s.tick}
              data-tick={s.tick}
              className={`playlist-section${on ? ' on' : ''}${s.color !== undefined ? ' colored' : ''}${
                moving?.tick === s.tick ? (moving.slide ? ' sliding' : ' lifted') : ''
              }`}
              style={
                {
                  // The one in hand is drawn where it would land.
                  left: (moving?.tick === s.tick ? moving.at : s.tick) * ppt,
                  width: Math.max(4, s.length * ppt),
                  ...(s.color !== undefined ? { '--sec-h': s.color } : {}),
                } as React.CSSProperties
              }
              role="button"
              tabIndex={0}
              aria-pressed={on}
              aria-label={`${s.name} section`}
              title={
                on
                  ? `Looping ${s.name}: click to play the whole song`
                  : `${s.name}: click to play and loop it, drag to move it with its music, double-click to rename, right-click for more`
              }
              onKeyDown={(e) => onKeyDown(e, s)}
            >
              {renaming?.tick === s.tick ? (
                <input
                  className="playlist-section-rename"
                  value={renaming.name}
                  autoFocus
                  aria-label="Section name"
                  spellCheck={false}
                  onChange={(e) => setRenaming({ tick: s.tick, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={() => {
                    if (renaming) onEdit((x) => renameSection(x, renaming.tick, renaming.name))
                    setRenaming(null)
                  }}
                />
              ) : (
                <span className="playlist-section-name">{s.name}</span>
              )}
              <button
                className="playlist-section-remove"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  remove(s.tick)
                }}
                aria-label={`Remove the ${s.name} section`}
                title="Remove this section. Its music stays where it is"
                type="button"
                tabIndex={-1}
              >
                ×
              </button>
              <span className="playlist-section-edge" data-edge="start" />
              <span className="playlist-section-edge" data-edge="end" />
            </div>
          )
        })}
        {create && (
          <div
            className="playlist-section-ghost"
            style={{ left: Math.min(create.from, create.to) * ppt, width: Math.abs(create.to - create.from) * ppt }}
          />
        )}
        {moving && !moving.slide && <div className="playlist-section-drop" style={{ left: dropX(all, moving.index) * ppt }} />}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** The tick of the gap a dragged section would land in. */
function dropX(all: readonly Section[], index: number): number {
  if (!all.length) return 0
  return index < all.length ? all[index].tick : sectionEnd(all[all.length - 1])
}
