import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { deletePreset, findPreset, loadPresets, savePreset, type ModulePreset } from '../patch/myLibrary'
import { ConfirmButton, useConfirm } from './ConfirmButton'

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
  /** Why the last save or delete did not happen, when storage refused it. */
  const [failed, setFailed] = useState<string | null>(null)
  /** A save over a preset already there, asked about before it goes ahead. */
  const replace = useConfirm()
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
    setFailed(null)
    const away = (e: PointerEvent) => {
      if (sheet.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [open, type])

  const trimmed = name.trim()
  /** The preset a save under this name would overwrite, if any. */
  const existing = trimmed ? findPreset(type, trimmed) : undefined

  const save = () => {
    if (!trimmed) return
    // Overwriting a preset throws its knobs away for good -- presets are
    // outside the rack's undo -- so the first press asks, and the second,
    // by click or by Enter, is the answer.
    if (existing && !replace.armed) {
      replace.arm()
      return
    }
    replace.disarm()
    if (savePreset(type, trimmed, current())) {
      setPresets(loadPresets(type))
      setName('')
      setFailed(null)
    } else {
      setFailed('Could not save: this browser is not letting the page store anything')
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
                  {/* Two presses, as in the library: there is no undo for a
                      preset, and the × sits right beside the row you meant
                      to load. */}
                  <ConfirmButton
                    className="preset-delete"
                    onConfirm={() => {
                      if (!deletePreset(type, p.name)) {
                        setFailed('Could not delete: this browser is not letting the page store anything')
                      }
                      setPresets(loadPresets(type))
                    }}
                    ask="Delete?"
                    aria-label={`Delete ${p.name}`}
                    title="Delete this preset"
                  >
                    ×
                  </ConfirmButton>
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
                onChange={(e) => {
                  setName(e.target.value)
                  replace.disarm()
                }}
                placeholder="Name this setting…"
                aria-label="Preset name"
                spellCheck={false}
                autoFocus
              />
              <button
                className={`dock-toggle preset-submit${replace.armed ? ' confirm' : ''}`}
                type="submit"
                disabled={!trimmed}
                title={existing ? `Replace the knobs saved as ${existing.name}` : undefined}
              >
                {replace.armed ? 'Replace?' : 'Save'}
              </button>
            </form>
            {failed && (
              <div className="preset-failed" role="alert">
                {failed}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
