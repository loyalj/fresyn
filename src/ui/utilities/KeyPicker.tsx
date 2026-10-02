import { SCALES } from '../../song/scale'
import { spelling } from '../../utilities/harmony'

/** The key and scale, as Scales & chords and Progressions both pick them: each root spelled the way its key spells it. */
export function KeyPicker({ root, mode, onChange }: { root: number; mode: string; onChange: (change: { root?: number; mode?: string }) => void }) {
  return (
    <>
      <label className="timing-field">
        <span>Key</span>
        <select value={root} aria-label="Key" onChange={(e) => onChange({ root: Number(e.target.value) })}>
          {Array.from({ length: 12 }, (_, pc) => (
            <option key={pc} value={pc}>
              {spelling(pc, mode)(pc)}
            </option>
          ))}
        </select>
      </label>
      <label className="timing-field">
        <span>Scale</span>
        <select value={mode} aria-label="Scale" onChange={(e) => onChange({ mode: e.target.value })}>
          {SCALES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}
