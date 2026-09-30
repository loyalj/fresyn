import { useEffect, useState } from 'react'
import { GM_DRUMS, kitSlots } from '../patch/kit'
import type { KitSlot, ModuleDef } from '../patch/types'
import { midiName } from '../song/tuning'
import { useFace } from './useFace'

/** What a pad can be loaded with: an instrument from the library, by its id. */
interface Choice {
  id: string
  name: string
  category: string
}

export interface KitHandlers {
  /** Load a pad from the library, or empty it with null. */
  onLoad: (slot: number, instrument: string | null) => void
  /** Rename a pad, or move it to another note. */
  onPad: (slot: number, change: { name?: string; note?: number }) => void
  /** Every pad loaded with the standard kit. */
  onStandard: () => void
  /** Sound a pad while it is held, to hear what is in it. */
  onAudition: (slot: number, on: boolean) => void
  /** Open a pad's rack on the bench, to change its sound while the kit plays. */
  onEdit: (slot: number) => void
}

interface Props extends KitHandlers {
  def: ModuleDef
  slots: (KitSlot | null)[] | undefined
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
}

/** The shelves the loader lists, drums first: that is what a pad is for. */
const SHELF_ORDER = ['drums', 'sfx', 'bass', 'keys', 'plucked', 'mallets', 'strings', 'brass', 'leads', 'ambience']

/**
 * The Drum Kit's panel: sixteen pads, and the one picked laid out beside
 * them to be loaded, named, moved to another note, levelled, panned and put
 * in a choke group.
 *
 * A press on a pad picks it and plays it for as long as it is held, the way
 * a pad on a drum machine does. The library is fetched the first time a
 * panel is shown rather than with the page: it is most of a megabyte of
 * racks, and a rack without a kit never needs it.
 */
export function KitFace({ def, slots, valueOf, onChange, onLoad, onPad, onStandard, onAudition, onEdit }: Props) {
  const { control, read } = useFace(def, valueOf, onChange)
  const pads = kitSlots({ slots })
  const [picked, setPicked] = useState(0)
  const [choices, setChoices] = useState<Choice[] | null>(null)
  useEffect(() => {
    let live = true
    void import('../patch/instruments').then(({ INSTRUMENTS }) => {
      if (live) setChoices(INSTRUMENTS.map(({ id, name, category }) => ({ id, name, category })))
    })
    return () => {
      live = false
    }
  }, [])

  const pad = pads[picked]
  const n = picked + 1
  const empty = pads.every((p) => !p)

  return (
    <div className="kit">
      <div className="kit-pads" role="group" aria-label="Pads">
        {pads.map((p, i) => (
          <button
            key={i}
            type="button"
            className={`kit-pad${i === picked ? ' picked' : ''}${p ? '' : ' empty'}${read(`choke${i + 1}`) > 0 ? ' choked' : ''}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              setPicked(i)
              if (p) {
                e.currentTarget.setPointerCapture(e.pointerId)
                onAudition(i, true)
              }
            }}
            onPointerUp={() => p && onAudition(i, false)}
            onPointerCancel={() => p && onAudition(i, false)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              setPicked(i)
              if (p && !e.repeat) onAudition(i, true)
            }}
            onKeyUp={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && p) onAudition(i, false)
            }}
            aria-pressed={i === picked}
            aria-label={p ? `Pad ${i + 1}, ${p.name}, on ${noteText(p.note)}` : `Pad ${i + 1}, empty`}
            title={p ? `${p.name} on ${noteText(p.note)}: press to hear it` : `Pad ${i + 1} is empty: pick it and load a sound`}
          >
            <span className="kit-pad-n">{i + 1}</span>
            <span className="kit-pad-name">{p ? p.name : '—'}</span>
            {p && <span className="kit-pad-note">{midiName(p.note)}</span>}
          </button>
        ))}
      </div>

      <div className="kit-edit" aria-label={`Pad ${n}`} role="group">
        <div className="kit-edit-row">
          <span className="kit-edit-title">Pad {n}</span>
          {pad ? (
            <input
              key={`name${picked}${pad.name}`}
              className="kit-name"
              defaultValue={pad.name}
              aria-label={`Pad ${n} name`}
              spellCheck={false}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.currentTarget.value = pad.name
                  e.currentTarget.blur()
                }
              }}
              onBlur={(e) => onPad(picked, { name: e.currentTarget.value })}
            />
          ) : (
            <span className="kit-edit-empty">Empty</span>
          )}
        </div>

        <div className="kit-edit-row">
          <select
            className="kit-load"
            value=""
            aria-label={`Load a sound into pad ${n}`}
            title="Load a rack from the library into this pad: a copy of it, to do with as you like"
            disabled={!choices}
            onChange={(e) => {
              const id = e.target.value
              if (id) onLoad(picked, id)
            }}
          >
            <option value="">{choices ? (pad ? 'Replace…' : 'Load…') : 'Loading…'}</option>
            {choices &&
              SHELF_ORDER.map((shelf) => {
                const items = choices.filter((c) => c.category === shelf)
                return items.length ? (
                  <optgroup key={shelf} label={shelf === 'sfx' ? 'Sound effects' : shelf[0].toUpperCase() + shelf.slice(1)}>
                    {items.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null
              })}
          </select>
          {pad && (
            <>
              {/* Its own button: a press on the pad plays it. */}
              <button
                type="button"
                className="kit-edit-pad"
                onClick={() => onEdit(picked)}
                title="Open this pad's rack on the bench, to change its sound while the kit plays"
              >
                Edit pad
              </button>
              <button type="button" className="kit-clear" onClick={() => onLoad(picked, null)} title="Empty this pad">
                Clear
              </button>
            </>
          )}
        </div>

        {pad && (
          <>
            <div className="kit-edit-row">
              <label className="kit-field" title="The note that plays this pad. General MIDI's drum map names it">
                <span>Note</span>
                <input
                  key={`note${picked}${pad.note}`}
                  type="number"
                  min={0}
                  max={127}
                  defaultValue={pad.note}
                  aria-label={`Pad ${n} note`}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  onBlur={(e) => {
                    const v = Number(e.currentTarget.value)
                    if (e.currentTarget.value.trim() !== '' && Number.isFinite(v)) onPad(picked, { note: v })
                  }}
                />
                <span className="kit-note-name">{noteText(pad.note)}</span>
              </label>
              <label className="kit-field" title="Pads in the same group cut each other off: a closed hat stops an open one">
                <span>Choke</span>
                <select
                  value={Math.round(read(`choke${n}`))}
                  aria-label={`Pad ${n} choke group`}
                  onChange={(e) => onChange(`choke${n}`, Number(e.target.value))}
                >
                  <option value={0}>None</option>
                  {[1, 2, 3, 4].map((g) => (
                    <option key={g} value={g}>
                      Group {g}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="controls kit-knobs">
              {control(`level${n}`)}
              {control(`pan${n}`)}
            </div>
          </>
        )}

        {empty && (
          <button type="button" className="kit-standard" onClick={onStandard} disabled={!choices}>
            Load the standard kit
          </button>
        )}
      </div>
    </div>
  )
}

/** "C2 · 36 Kick": the note, its number, and what General MIDI calls it. */
function noteText(note: number): string {
  const gm = GM_DRUMS[note]
  return `${midiName(note)} · ${note}${gm ? ` ${gm}` : ''}`
}

