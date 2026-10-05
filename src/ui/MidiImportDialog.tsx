import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { gmName } from '../song/gm'
import { partName, type ImportedMidi } from '../song/midiImport'
import { PPQ } from '../song/types'

interface Props {
  /** The file's name, without its extension. */
  name: string
  imp: ImportedMidi
  /** The bar the file's tracks would be added at, counted from one. */
  addAtBar: number
  onNew: () => void
  onAdd: () => void
  onClose: () => void
}

/**
 * What a MIDI file holds, and where it goes: a project of its own, or its
 * tracks added to this one. Either way every part becomes a track with the
 * library voice nearest its General MIDI program, a pattern on a lane of its
 * own, and its volume and pan rides lanes on its strip.
 */
export function MidiImportDialog({ name, imp, addAtBar, onNew, onAdd, onClose }: Props) {
  const sheet = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheet.current?.querySelector<HTMLElement>('button.on')?.focus()
    return () => restore?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [onClose])

  const beats = Math.ceil(imp.end / PPQ)
  const meter = `${imp.meter.beats}/${imp.meter.unit}`
  const rides = imp.parts.filter((p) => p.gain.length > 1 || p.pan.length > 1).length

  return createPortal(
    <div
      className="sheet-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={sheet} className="sheet audio-sheet midi-import" role="dialog" aria-modal="true" aria-labelledby="midi-import-title">
        <div className="sheet-head">
          <div>
            <h2 id="midi-import-title">Import {name}</h2>
            <p className="sheet-note">
              {imp.parts.length} {imp.parts.length === 1 ? 'part' : 'parts'} · {Math.round(imp.tempo)} bpm
              {imp.tempos.length ? ` (${imp.tempos.length} tempo ${imp.tempos.length === 1 ? 'change' : 'changes'})` : ''} · {meter} ·{' '}
              {beats} beats{imp.markers.length ? ` · ${imp.markers.length} markers` : ''}
            </p>
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="Close" type="button">
            &times;
          </button>
        </div>

        <div className="audio-body">
          <ul className="midi-import-parts">
            {imp.parts.map((p, i) => (
              <li key={i}>
                <span className="midi-import-name">{partName(p)}</span>
                <span className="midi-import-sound">
                  {p.drums ? 'Drum Kit' : gmName(p.program ?? 0)} · {p.notes.length} {p.notes.length === 1 ? 'note' : 'notes'}
                </span>
              </li>
            ))}
          </ul>
          <p className="audio-hint">
            Each part becomes a track with the library voice nearest its sound, and a pattern of its own on the playlist.
            {rides ? ` Volume and pan changes become automation lanes on ${rides === 1 ? 'one track' : `${rides} tracks`}.` : ''}
          </p>
        </div>

        <div className="sheet-foot">
          <span className="sheet-keys">Esc to close</span>
          <span className="bounce-actions">
            <button
              className="dock-toggle"
              onClick={onAdd}
              title={`Add these tracks to the song, starting at bar ${addAtBar}; the song keeps its own tempo`}
              type="button"
            >
              Add at bar {addAtBar}
            </button>
            <button className="dock-toggle on" onClick={onNew} title="A new project from the file, with its tempo, meter and markers (Ctrl+Z to go back)" type="button">
              Open as new project
            </button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
