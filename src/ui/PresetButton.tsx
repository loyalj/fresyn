import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { deletePreset, loadPresets, savePreset, type ModulePreset } from '../patch/myLibrary'

interface Props {
  /** The module type, which is what presets are kept per. */
  type: string
  moduleId: string
  /** The module's knobs as they stand, for saving. */
  current: () => Record<string, number>
  /** Put a preset's knobs on this module. */
  onApply: (params: Record<string, number>) => void
}

/**
 * A module's own presets: its knobs saved under a name, and put back on any
 * module of the same kind. A favourite Drive curve or a Formant set to robot,
 * without saving a whole rack to get it.
 *
 * On the ear with the bypass lamp, where every module keeps the controls that
 * are about the module rather than the sound. The list opens in a small sheet
 * of its own, put on the page rather than in the unit so the rack's own
 * clipping and perspective cannot cut it off.
 */
export function PresetButton({ type, moduleId, current, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<ModulePreset[]>([])
  const [name, setName] = useState('')
  const [where, setWhere] = useState({ left: 0, top: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const r = button.current.getBoundingClientRect()
    // Beside the ear, and kept on the screen.
    setWhere({ left: Math.min(r.right + 6, window.innerWidth - 240), top: Math.max(8, Math.min(r.top, window.innerHeight - 280)) })
  }, [open])

  useEffect(() => {
    if (!open) return
    setPresets(loadPresets(type))
    const away = (e: PointerEvent) => {
      if (sheet.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [open, type])

  const save = () => {
    const n = name.trim()
    if (!n) return
    if (savePreset(type, n, current())) {
      setPresets(loadPresets(type))
      setName('')
    }
  }

  return (
    <>
      <button
        ref={button}
        className={`unit-presets${open ? ' on' : ''}`}
        // Not the start of a drag: the ear is the handle everywhere else.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((o) => !o)}
        title={`Presets for ${moduleId}`}
        aria-label={`Presets for ${moduleId}`}
        aria-expanded={open}
        type="button"
      >
        ≡
      </button>
      {open &&
        createPortal(
          <div
            ref={sheet}
            className="preset-sheet"
            style={{ left: where.left, top: where.top }}
            role="dialog"
            aria-label={`Presets for ${moduleId}`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
            }}
          >
            <div className="preset-head">Presets</div>
            <ul className="preset-list">
              {presets.length === 0 && <li className="preset-empty">None saved for this kind of module yet.</li>}
              {presets.map((p) => (
                <li key={p.name} className="preset-row">
                  <button
                    className="preset-load"
                    onClick={() => {
                      onApply(p.params)
                      setOpen(false)
                    }}
                    title={`Put ${p.name} on ${moduleId}`}
                    type="button"
                  >
                    {p.name}
                  </button>
                  <button
                    className="preset-delete"
                    onClick={() => {
                      deletePreset(type, p.name)
                      setPresets(loadPresets(type))
                    }}
                    aria-label={`Delete ${p.name}`}
                    title="Delete this preset"
                    type="button"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="preset-save"
              onSubmit={(e) => {
                e.preventDefault()
                save()
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name this setting…"
                aria-label="Preset name"
                spellCheck={false}
                autoFocus
              />
              <button className="dock-toggle" type="submit" disabled={!name.trim()}>
                Save
              </button>
            </form>
          </div>,
          document.body,
        )}
    </>
  )
}
