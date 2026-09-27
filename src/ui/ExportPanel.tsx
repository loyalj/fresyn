import { NORMALIZE_OPTIONS, type Normalize } from '../audio/normalize'
import type { BitDepth } from '../audio/wav'
import type { ParamSpec } from '../patch/param'
import { ConfirmButton } from './ConfirmButton'
import { Knob } from './Knob'

export interface ExportSettings {
  count: number
  duration: number
  gateSeconds: number
  spread: number
  seed: number
  sampleRate: number
  bitDepth: BitDepth
  /** What each take is brought to before it is written; see `normalize`. */
  normalize: Normalize
}

export const DEFAULT_EXPORT: ExportSettings = {
  count: 8,
  duration: 2,
  gateSeconds: 0.1,
  spread: 0.08,
  seed: 1,
  sampleRate: 48000,
  bitDepth: 16,
  normalize: 'off',
}

/**
 * The render settings as knobs, so the recorder is operated the way the rest
 * of the rack is.
 *
 * Curves follow the same rule the modules use: anything the ear or the eye
 * reads logarithmically is exponential, so the low end of a range gets the
 * resolution. Spread is linear because it starts at zero, which an
 * exponential curve cannot leave.
 *
 * Seed is a small dial rather than the 32-bit field it used to be. Its job
 * is to be a number you can note down and come back to, and a knob spanning
 * two billion values cannot be brought back to one of them.
 */
const SPECS: Record<string, ParamSpec> = {
  count: { id: 'count', label: 'Takes', min: 1, max: 64, default: 8, unit: '', curve: 'exp' },
  duration: { id: 'duration', label: 'Length', min: 0.1, max: 30, default: 2, unit: 's', curve: 'exp' },
  gateSeconds: { id: 'gateSeconds', label: 'Gate', min: 0.001, max: 10, default: 0.1, unit: 's', curve: 'exp' },
  spread: { id: 'spread', label: 'Spread', min: 0, max: 0.5, default: 0.08, unit: '', curve: 'lin' },
  seed: { id: 'seed', label: 'Seed', min: 1, max: 128, default: 1, unit: '', curve: 'lin' },
}

const whole = (v: number) => String(Math.round(v))

interface Props {
  /**
   * The settings, held by the app per track rather than in here. The panel
   * is remounted whenever the recorder moves or the rack changes track, and
   * settings kept inside it went back to the defaults every time.
   */
  settings: ExportSettings
  onSettings: (next: ExportSettings) => void
  onExport: (settings: ExportSettings) => void
  busy: string | null
  /**
   * Whether this track already has takes on the panel, which a render
   * replaces. The button asks first when it would throw some away.
   */
  hasTakes?: boolean
}

/**
 * Render the rack to disk. A batch is the same patch under a series of known
 * seeds, which is what makes eight footsteps that belong together rather than
 * eight unrelated sounds.
 *
 * The settings are the panel. They used to be behind a button, which bought
 * a little height back and cost a click before every render -- on a module
 * whose whole job is rendering.
 */
export function ExportPanel({ settings: s, onSettings, onExport, busy, hasTakes }: Props) {
  const set = <K extends keyof ExportSettings>(key: K, value: ExportSettings[K]) =>
    onSettings({ ...s, [key]: value })

  return (
    <div className="export-panel">
      <div className="export-fields">
        <Setting hint="how many variations">
          <Knob
            spec={SPECS.count}
            value={s.count}
            step={1}
            format={whole}
            onChange={(v) => set('count', v)}
          />
        </Setting>

        <Setting hint="seconds, trimmed to the tail">
          <Knob spec={SPECS.duration} value={s.duration} onChange={(v) => set('duration', v)} />
        </Setting>

        <Setting hint="seconds the trigger is held">
          <Knob
            spec={SPECS.gateSeconds}
            value={s.gateSeconds}
            onChange={(v) => set('gateSeconds', v)}
          />
        </Setting>

        <Setting hint="how far knobs wander per take">
          <Knob spec={SPECS.spread} value={s.spread} onChange={(v) => set('spread', v)} />
        </Setting>

        <Setting hint="same seed, same renders">
          <Knob
            spec={SPECS.seed}
            value={s.seed}
            step={1}
            format={whole}
            onChange={(v) => set('seed', v)}
          />
        </Setting>

        <label className="export-format">
          <select
            value={`${s.sampleRate}/${s.bitDepth}`}
            onChange={(e) => {
              const [rate, depth] = e.target.value.split('/')
              onSettings({ ...s, sampleRate: Number(rate), bitDepth: Number(depth) as BitDepth })
            }}
          >
            <option value="48000/16">48 kHz &middot; 16-bit</option>
            <option value="48000/24">48 kHz &middot; 24-bit</option>
            <option value="44100/16">44.1 kHz &middot; 16-bit</option>
            <option value="44100/24">44.1 kHz &middot; 24-bit</option>
          </select>
          <span className="knob-label">Format</span>
        </label>

        {/* Beside the format, because both are about what lands in the file
            rather than about the sound: a whole set of takes at one
            loudness is what a game's mix is built from. */}
        <label className="export-format" title="Bring every take to the same level before it is saved">
          <select value={s.normalize} onChange={(e) => set('normalize', e.target.value as Normalize)}>
            {NORMALIZE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="knob-label">Level</span>
        </label>
      </div>

      <div className="export-actions">
        {/* A render replaces the takes on the panel, and takes are outside
            undo -- so with some there, it asks before it goes. */}
        <ConfirmButton
          className="export-go"
          disabled={!!busy}
          needed={!!hasTakes}
          ask="Replace the takes?"
          onConfirm={() => onExport(s)}
        >
          {busy ?? (s.count > 1 ? `Render ${s.count} takes` : 'Render')}
        </ConfirmButton>
      </div>
    </div>
  )
}

/** A knob with the note that used to sit under its field, as its tooltip. */
function Setting({ hint, children }: { hint: string; children: React.ReactNode }) {
  return (
    <div className="export-setting" title={hint}>
      {children}
    </div>
  )
}
