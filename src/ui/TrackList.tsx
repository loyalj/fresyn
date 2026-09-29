import { useMemo, useRef, useState } from 'react'
import type { NoteTarget } from '../song/bind'
import { reorderTracks } from '../song/edit'
import {
  addFolder,
  folderOf,
  heardTracks,
  moveToFolder,
  removeFolder,
  soloFolder,
  tracksMatching,
  updateFolder,
} from '../song/folder'
import type { Folder, Song, Track } from '../song/types'
import { ContextMenu, type MenuItem } from './Menu'
import { nextHue } from './palette'
import { NameField } from './NameField'

interface Props {
  song: Song
  selected: string
  /** Which tracks have something a note can be played on. */
  targets: ReadonlyMap<string, NoteTarget>
  onSelect: (id: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onChange: (id: string, change: Partial<Omit<Track, 'id'>>, key?: string) => void
  /**
   * Solo is its own handler because it is not a change to one track: pressing
   * it clears solo everywhere else, which is what makes one button enough.
   */
  onSolo: (id: string) => void
  /** Folders, moves and reorders: edits to the song as it stands. */
  onEdit: (fn: (song: Song) => Song, key?: string) => void
  /** Whether hidden tracks are listed after all, dimmed. */
  showHidden: boolean
  onShowHidden: (show: boolean) => void
}

/**
 * A level as a desk prints it. The slider is linear, which is what a track's
 * gain is, but a mix is balanced in decibels: "6 dB down" is a thing people
 * say, and "0.50" is not.
 */
function decibels(gain: number) {
  if (gain <= 0.0001) return '−∞ dB'
  const db = 20 * Math.log10(gain)
  return `${db > -0.05 ? '0.0' : db.toFixed(1).replace('-', '−')} dB`
}

/** A track being dragged by its grip: where it would go, and into which folder. */
interface Drag {
  id: string
  order: string[]
  folder: string | null
}

/** One row of the list, in the order drawn. */
type Row =
  | { kind: 'track'; track: Track; pinnedBand: boolean }
  | { kind: 'folder'; folder: Folder; count: number }
  | { kind: 'rule' }

/**
 * The tracks, down the side of the dock.
 *
 * Selecting one puts its rack on the bench. That is the whole of the
 * relationship between this list and the rack above it: a track is a rack,
 * and the thing you are looking at up there is whichever row is lit down
 * here.
 *
 * Pinned tracks come first, in a band of their own that no search filters
 * and no folder folds away. Then everything else in its order, a folder's
 * tracks under the folder's own row wherever its first track falls. Hidden
 * tracks are left out unless asked for -- they still play; hiding is only
 * tidying -- and a search narrows the rest by name or by folder name.
 */
export function TrackList({
  song,
  selected,
  targets,
  onSelect,
  onAdd,
  onRemove,
  onChange,
  onSolo,
  onEdit,
  showHidden,
  onShowHidden,
}: Props) {
  const [search, setSearch] = useState('')
  const [drag, setDragState] = useState<Drag | null>(null)
  /**
   * The same, for the handlers to read: pointer moves arrive faster than
   * React draws, and a release reading the state it was drawn with would
   * drop the last few of them -- including the one over the folder.
   */
  const dragRef = useRef<Drag | null>(null)
  const setDrag = (next: Drag | null) => {
    dragRef.current = next
    setDragState(next)
  }
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  // While a track is dragged, the list is drawn as it would be let go.
  const view = useMemo(
    () => (drag ? moveToFolder(reorderTracks(song, drag.order), [drag.id], drag.folder) : song),
    [song, drag],
  )
  const heard = useMemo(() => heardTracks(view), [view])
  const hiddenCount = song.tracks.filter((t) => t.hidden).length
  const rows = useMemo(() => layout(view, tracksMatching(view, search), showHidden, search.trim() !== ''), [view, search, showHidden])

  /** What a point on the page is over: a track's row, or a folder's. */
  const rowAt = (x: number, y: number): { track: string } | { folder: string } | null => {
    const el = document.elementFromPoint(x, y)
    const row = el instanceof Element ? el.closest<HTMLElement>('[data-track], [data-folder]') : null
    if (!row) return null
    if (row.dataset.track !== undefined) return { track: row.dataset.track }
    return { folder: row.dataset.folder! }
  }

  const newFolderId = () => {
    const taken = new Set((song.folders ?? []).map((f) => f.id))
    let n = (song.folders?.length ?? 0) + 1
    while (taken.has(`folder${n}`)) n++
    return `folder${n}`
  }
  const newFolderName = () => `Folder ${(song.folders?.length ?? 0) + 1}`

  /** Hide a track, and move the bench off it first if it is the one there. */
  const hide = (track: Track) => {
    if (track.id === selected) {
      const next = song.tracks.find((t) => t.id !== track.id && !t.hidden)
      if (next) onSelect(next.id)
    }
    onChange(track.id, { hidden: true })
  }

  // The latest song and view, for a drag followed from the window.
  const latest = useRef({ song, view })
  latest.current = { song, view }

  /**
   * Follow a track dragged by its grip. From the window rather than with a
   * pointer capture on the grip: the list is redrawn in its new order as the
   * drag goes, React moves the row to do it, and a moved element loses its
   * capture -- which dropped every move after the first swap, including the
   * one over the folder.
   */
  const startDrag = (track: Track) => {
    setDrag({ id: track.id, order: latest.current.song.tracks.map((t) => t.id), folder: track.folder ?? null })
    const move = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const over = rowAt(e.clientX, e.clientY)
      if (!over) return
      if ('folder' in over) {
        if (drag.folder !== over.folder) setDrag({ ...drag, folder: over.folder })
        return
      }
      if (over.track === track.id) return
      const target = latest.current.view.tracks.find((t) => t.id === over.track)
      if (!target) return
      const from = drag.order.indexOf(track.id)
      const to = drag.order.indexOf(over.track)
      const order = drag.order.filter((id) => id !== track.id)
      order.splice(order.indexOf(over.track) + (to > from ? 1 : 0), 0, track.id)
      // Dropped among a folder's tracks, it joins them; among loose tracks,
      // it leaves whatever folder it was in. Not in the pinned band, which
      // is outside every folder.
      const folder = target.pinned ? drag.folder : (target.folder ?? null)
      setDrag({ ...drag, order, folder })
    }
    const stop = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      const d = dragRef.current
      setDrag(null)
      if (!d || e.type === 'pointercancel') return
      onEdit((s) => moveToFolder(reorderTracks(s, d.order), [d.id], d.folder))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const trackMenu = (track: Track): MenuItem[] => [
    { kind: 'toggle', label: 'Pin to the top', checked: !!track.pinned, onSelect: () => onChange(track.id, { pinned: track.pinned ? undefined : true }) },
    track.hidden
      ? { kind: 'action', label: 'Show', onSelect: () => onChange(track.id, { hidden: undefined }) }
      : {
          kind: 'action',
          label: 'Hide (still plays)',
          // Something has to stay on the bench.
          disabled: song.tracks.every((t) => t.id === track.id || t.hidden),
          onSelect: () => hide(track),
        },
    {
      kind: 'submenu',
      label: 'Move to folder',
      items: [
        ...(song.folders ?? []).map(
          (f): MenuItem => ({
            kind: 'toggle',
            label: f.name,
            checked: track.folder === f.id,
            onSelect: () => onEdit((s) => moveToFolder(s, [track.id], f.id)),
          }),
        ),
        ...((song.folders?.length ?? 0) > 0 ? [{ kind: 'separator' } as const] : []),
        {
          kind: 'action',
          label: 'New folder',
          onSelect: () => {
            const id = newFolderId()
            onEdit((s) => addFolder(s, id, newFolderName(), [track.id]))
          },
        },
        {
          kind: 'action',
          label: 'Out of any folder',
          disabled: track.folder === undefined,
          onSelect: () => onEdit((s) => moveToFolder(s, [track.id], null)),
        },
      ],
    },
    { kind: 'separator' },
    { kind: 'action', label: 'Remove track', disabled: song.tracks.length <= 1, onSelect: () => onRemove(track.id) },
  ]

  const folderMenu = (folder: Folder): MenuItem[] => {
    const members = song.tracks.filter((t) => t.folder === folder.id)
    return [
      { kind: 'toggle', label: 'Folded', checked: !!folder.collapsed, onSelect: () => onEdit((s) => updateFolder(s, folder.id, { collapsed: !folder.collapsed })) },
      {
        kind: 'action',
        label: 'Hide its tracks (they still play)',
        disabled: members.every((t) => t.hidden) || song.tracks.every((t) => t.folder === folder.id || t.hidden),
        onSelect: () => {
          if (members.some((t) => t.id === selected)) {
            const next = song.tracks.find((t) => t.folder !== folder.id && !t.hidden)
            if (next) onSelect(next.id)
          }
          onEdit((s) => ({ ...s, tracks: s.tracks.map((t) => (t.folder === folder.id ? { ...t, hidden: true } : t)) }))
        },
      },
      {
        kind: 'action',
        label: 'Show its tracks',
        disabled: !members.some((t) => t.hidden),
        onSelect: () => onEdit((s) => ({ ...s, tracks: s.tracks.map((t) => (t.folder === folder.id ? { ...t, hidden: undefined } : t)) })),
      },
      { kind: 'separator' },
      { kind: 'action', label: 'Remove folder (keeps its tracks)', onSelect: () => onEdit((s) => removeFolder(s, folder.id)) },
    ]
  }

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const trackRow = (track: Track, pinnedBand: boolean) => {
    const target = targets.get(track.id)
    // What a desk shows: a track that is not reaching the speakers -- muted,
    // or not soloed while something else is, or its folder either -- reads
    // dimmed.
    const silent = !heard.has(track.id)
    const folder = folderOf(view, track)
    return (
      <div
        key={track.id}
        data-track={track.id}
        className={`track${track.id === selected ? ' on' : ''}${silent ? ' silent' : ''}${
          drag?.id === track.id ? ' dragging' : ''
        }${track.color !== undefined ? ' colored' : ''}${folder && !pinnedBand ? ' in-folder' : ''}${
          track.hidden ? ' hidden-track' : ''
        }`}
        style={track.color !== undefined ? ({ '--track-h': track.color } as React.CSSProperties) : undefined}
        onPointerDown={() => onSelect(track.id)}
        onContextMenu={(e) => openMenu(e, trackMenu(track))}
      >
        {/* The grip a track is dragged up and down the list by, and into and
            out of folders. The order is only how the list reads -- every
            track plays either way -- so this is housekeeping. */}
        <span
          className="track-grip"
          title="Drag to reorder, or onto a folder to file it there"
          aria-hidden="true"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            startDrag(track)
          }}
        >
          ⋮⋮
        </span>
        <button
          className={`swatch${track.color === undefined ? ' none' : ''}`}
          style={track.color !== undefined ? ({ '--swatch-h': track.color } as React.CSSProperties) : undefined}
          onClick={() => onChange(track.id, { color: nextHue(track.color) })}
          title="Colour this track"
          aria-label={`Colour ${track.name}`}
          type="button"
        />
        <NameField
          className="track-name"
          value={track.name}
          label="Track name"
          title={pinnedBand && folder ? `Double-click to rename this track (in ${folder.name})` : 'Double-click to rename this track'}
          onSelect={() => onSelect(track.id)}
          onRename={(name) => onChange(track.id, { name }, `track:${track.id}`)}
        />

        {track.pinned && (
          <span className="track-pin" title="Pinned to the top">
            ▴
          </span>
        )}
        {/* Said here rather than only on the transport bar, because with
            several tracks the one that cannot be played is not necessarily
            the one you are looking at. */}
        {!target && <span className="track-warn" title="No Keyboard or Trigger in this rack">!</span>}
        {target?.kind === 'trigger' && (
          <span className="track-kind" title="No Keyboard: every note fires the Trigger">
            T
          </span>
        )}

        <input
          className="track-gain"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={track.gain}
          aria-label="Track level"
          title={decibels(track.gain)}
          onChange={(e) => onChange(track.id, { gain: Number(e.target.value) }, `gain:${track.id}`)}
        />
        <span className="track-db">{decibels(track.gain)}</span>

        <button
          className={`track-flag${track.mute ? ' on' : ''}`}
          onClick={() => onChange(track.id, { mute: track.mute ? undefined : true })}
          aria-pressed={!!track.mute}
          aria-label={`Mute ${track.name || 'track'}`}
          title="Mute"
          type="button"
        >
          M
        </button>
        <button
          className={`track-flag${track.solo ? ' on' : ''}`}
          onClick={() => onSolo(track.id)}
          aria-pressed={!!track.solo}
          aria-label={`Solo ${track.name || 'track'}`}
          title="Solo"
          type="button"
        >
          S
        </button>
        <button
          className="track-more"
          onClick={(e) => openMenu(e, trackMenu(track))}
          aria-label={`More for ${track.name || 'track'}`}
          title="Pin, hide, file in a folder"
          type="button"
        >
          ⋯
        </button>
        <button
          className="track-remove"
          onClick={() => onRemove(track.id)}
          // The last track is the rack on the bench; there has to be one.
          disabled={song.tracks.length <= 1}
          title="Remove this track"
          aria-label={`Remove ${track.name || 'track'}`}
          type="button"
        >
          ×
        </button>
      </div>
    )
  }

  const folderRow = (folder: Folder, count: number) => {
    const allSilent = view.tracks.filter((t) => t.folder === folder.id).every((t) => !heard.has(t.id))
    return (
      <div
        key={`folder:${folder.id}`}
        data-folder={folder.id}
        className={`track-folder${folder.collapsed ? ' collapsed' : ''}${folder.color !== undefined ? ' colored' : ''}${
          count > 0 && allSilent ? ' silent' : ''
        }${drag && drag.folder === folder.id ? ' drop' : ''}`}
        style={folder.color !== undefined ? ({ '--track-h': folder.color } as React.CSSProperties) : undefined}
        onContextMenu={(e) => openMenu(e, folderMenu(folder))}
      >
        <button
          className="track-fold"
          onClick={() => onEdit((s) => updateFolder(s, folder.id, { collapsed: !folder.collapsed }))}
          aria-expanded={!folder.collapsed}
          aria-label={`${folder.collapsed ? 'Unfold' : 'Fold'} ${folder.name}`}
          title={folder.collapsed ? 'Show its tracks' : 'Fold its tracks away'}
          type="button"
        >
          {folder.collapsed ? '▸' : '▾'}
        </button>
        <button
          className={`swatch${folder.color === undefined ? ' none' : ''}`}
          style={folder.color !== undefined ? ({ '--swatch-h': folder.color } as React.CSSProperties) : undefined}
          onClick={() => onEdit((s) => updateFolder(s, folder.id, { color: nextHue(folder.color) ?? null }))}
          title="Colour this folder"
          aria-label={`Colour ${folder.name}`}
          type="button"
        />
        <NameField
          className="track-name"
          value={folder.name}
          label="Folder name"
          title="Double-click to rename this folder"
          onSelect={() => {}}
          onRename={(name) => onEdit((s) => updateFolder(s, folder.id, { name }), `folder:${folder.id}`)}
        />
        <span className="track-count" title={`${count} track${count === 1 ? '' : 's'}`}>
          {count}
        </span>
        <input
          className="track-gain"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={folder.gain}
          aria-label="Folder level"
          title={`${decibels(folder.gain)}, on every track in it`}
          onChange={(e) => onEdit((s) => updateFolder(s, folder.id, { gain: Number(e.target.value) }), `folder-gain:${folder.id}`)}
        />
        <span className="track-db">{decibels(folder.gain)}</span>
        <button
          className={`track-flag${folder.mute ? ' on' : ''}`}
          onClick={() => onEdit((s) => updateFolder(s, folder.id, { mute: !folder.mute }))}
          aria-pressed={!!folder.mute}
          aria-label={`Mute ${folder.name}`}
          title="Mute every track in it"
          type="button"
        >
          M
        </button>
        <button
          className={`track-flag${folder.solo ? ' on' : ''}`}
          onClick={() => onEdit((s) => soloFolder(s, folder.id))}
          aria-pressed={!!folder.solo}
          aria-label={`Solo ${folder.name}`}
          title="Solo every track in it"
          type="button"
        >
          S
        </button>
        <button
          className="track-more"
          onClick={(e) => openMenu(e, folderMenu(folder))}
          aria-label={`More for ${folder.name}`}
          title="Fold, hide its tracks, remove the folder"
          type="button"
        >
          ⋯
        </button>
      </div>
    )
  }

  return (
    <div className="tracks">
      <div className="tracks-find">
        <input
          className="tracks-search"
          type="search"
          value={search}
          placeholder="Find a track"
          aria-label="Find a track"
          spellCheck={false}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSearch('')
          }}
        />
        {hiddenCount > 0 && (
          <button
            className={`tracks-hidden${showHidden ? ' on' : ''}`}
            onClick={() => onShowHidden(!showHidden)}
            aria-pressed={showHidden}
            title={showHidden ? 'Stop listing hidden tracks' : 'List hidden tracks too'}
            type="button"
          >
            {showHidden ? 'Hiding' : 'Show'} {hiddenCount} hidden
          </button>
        )}
      </div>

      <div className="tracks-rows">
        {rows.map((row, i) =>
          row.kind === 'track'
            ? trackRow(row.track, row.pinnedBand)
            : row.kind === 'folder'
              ? folderRow(row.folder, row.count)
              : <div key={`rule${i}`} className="tracks-rule" aria-hidden="true" />,
        )}
        {rows.length === 0 && <div className="tracks-none">No track called that</div>}
      </div>

      <div className="tracks-foot">
        <button className="track-add" onClick={onAdd} type="button">
          + Track
        </button>
        <button
          className="track-add"
          onClick={() => {
            const id = newFolderId()
            onEdit((s) => addFolder(s, id, newFolderName()))
          }}
          type="button"
        >
          + Folder
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

/**
 * The rows, in the order they are drawn: the pinned band and a rule under
 * it, then every other track in order with each folder's row where its first
 * track falls and its tracks under it, and last the folders with nothing in
 * them to show yet.
 */
function layout(song: Song, matching: Set<string>, showHidden: boolean, searching: boolean): Row[] {
  const rows: Row[] = []
  const listed = (t: Track) => showHidden || !t.hidden
  const pinned = song.tracks.filter((t) => t.pinned && listed(t))
  for (const t of pinned) rows.push({ kind: 'track', track: t, pinnedBand: true })
  const rest = song.tracks.filter((t) => !t.pinned && listed(t) && matching.has(t.id))
  if (pinned.length && rest.length) rows.push({ kind: 'rule' })

  const folders = new Map((song.folders ?? []).map((f) => [f.id, f]))
  const drawn = new Set<string>()
  for (const t of rest) {
    const folder = t.folder !== undefined ? folders.get(t.folder) : undefined
    if (!folder) {
      rows.push({ kind: 'track', track: t, pinnedBand: false })
      continue
    }
    if (drawn.has(folder.id)) continue
    drawn.add(folder.id)
    const members = rest.filter((x) => x.folder === folder.id)
    rows.push({ kind: 'folder', folder, count: song.tracks.filter((x) => x.folder === folder.id).length })
    // A search looks inside a folded folder: what it found is shown.
    if (!folder.collapsed || searching) for (const m of members) rows.push({ kind: 'track', track: m, pinnedBand: false })
  }
  if (!searching) {
    for (const f of song.folders ?? []) {
      if (drawn.has(f.id)) continue
      rows.push({ kind: 'folder', folder: f, count: song.tracks.filter((x) => x.folder === f.id).length })
    }
  }
  return rows
}
