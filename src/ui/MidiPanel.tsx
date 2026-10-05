import { useRef, useSyncExternalStore } from 'react'
import type { MidiStatus } from '../input/midi'
import { cleanMappings, describeControl, mappingsFile, type MidiMapping } from '../input/midiMap'
import { describeTarget, type TargetContext } from '../input/midiTargets'
import type { MidiControlState } from '../input/useMidiControl'
import { STRIPS, type McuState } from '../input/useMcu'
import { downloadBytes } from '../patch/storage'
import { ConfirmButton } from './ConfirmButton'

interface Props {
  control: MidiControlState
  /** Which controllers are in DAW (Mackie Control) mode. */
  mcu: McuState
  status: MidiStatus
  /** Turn MIDI input on, which the browser asks the person about first. */
  onTurnOn: () => void
  context: () => TargetContext
  notice: (text: string, warning?: boolean) => void
}

const KINDS: { value: MidiMapping['kind']; label: string }[] = [
  { value: 'absolute', label: 'Knob or slider' },
  { value: 'relative', label: 'Endless knob' },
  { value: 'button', label: 'Button' },
]

/** How each endless-knob encoding is described: by what one step up and down send. */
const ENCODING_LABELS = { twos: '1 up · 127 down', offset: '65 up · 63 down', signed: '1 up · 65 down' }
const BUTTON_LABELS = { toggle: 'Each press switches', follow: 'On while it says on' }

/**
 * The MIDI controllers panel: which are connected, what each control is
 * mapped onto, Learn, and a monitor of what is arriving -- the quickest way
 * to find out what an unfamiliar controller sends.
 */
export function MidiPanel({ control, mcu, status, onTurnOn, context, notice }: Props) {
  const lines = useSyncExternalStore(control.monitor.subscribe, control.monitor.snapshot)
  const fileInput = useRef<HTMLInputElement>(null)
  const ctx = context()
  const devices = status.state === 'ready' ? status.devices : []

  const importFile = async (file: File) => {
    try {
      const mappings = cleanMappings(JSON.parse(await file.text()))
      if (!mappings.length) {
        notice(`${file.name} has no MIDI mappings in it`, true)
        return
      }
      control.setMappings(mappings)
      notice(`Loaded ${mappings.length} MIDI mapping${mappings.length === 1 ? '' : 's'} from ${file.name}`)
    } catch {
      notice(`${file.name} is not a mappings file`, true)
    }
  }

  return (
    <div className="midi-panel">
      <div className="midi-status">
        {status.state === 'off' && (
          <>
            <span>MIDI input is off.</span>
            <button className="dock-toggle" type="button" onClick={onTurnOn}>
              Turn on
            </button>
          </>
        )}
        {status.state === 'asking' && <span>Waiting for the browser to allow MIDI…</span>}
        {status.state === 'unsupported' && <span>This browser has no MIDI: try Chrome or Edge.</span>}
        {status.state === 'denied' && <span>MIDI was not allowed: {status.error}</span>}
        {status.state === 'ready' &&
          (devices.length ? (
            <span>
              Connected: <strong>{devices.join(', ')}</strong>
            </span>
          ) : (
            <span>No controller connected. Plug one in and it is picked up.</span>
          ))}
      </div>

      {devices.length > 0 && (
        <ul className="midi-devices">
          {devices.map((d) => (
            <li key={d}>
              <span className="midi-device-name">{d}</span>
              <label
                className="midi-check"
                title="For a controller in its DAW mode: every control means what Mackie Control says, with no learning, and its lights follow the song"
              >
                <input type="checkbox" checked={mcu.enabled.includes(d)} onChange={(e) => mcu.setEnabled(d, e.target.checked)} />
                DAW mode (Mackie Control)
              </label>
            </li>
          ))}
        </ul>
      )}
      {mcu.enabled.some((d) => devices.includes(d)) && (
        <p className="midi-hint">
          Strips are tracks {mcu.bank + 1}–{mcu.bank + STRIPS}: faders are levels, knobs pan, M S mute and solo, Select picks the
          track, R picks it and arms ● Rec. « » move the strips along eight tracks. Anything learnt below comes first.
        </p>
      )}

      <div className="midi-row">
        <button
          className={`dock-toggle midi-learn${control.learning ? ' on' : ''}`}
          type="button"
          aria-pressed={control.learning}
          onClick={() => control.setLearning(!control.learning)}
          disabled={status.state !== 'ready'}
        >
          Learn
        </button>
        <label className="midi-check" title="A knob or slider moves nothing until it reaches the value on screen, so the sound never jumps">
          <input type="checkbox" checked={control.pickup} onChange={(e) => control.setPickup(e.target.checked)} />
          Pick up
        </label>
      </div>
      {control.learning && (
        <p className="midi-hint" aria-live="polite">
          {control.armed ? (
            <>
              Now move a control on the controller for <strong>{control.armed.label}</strong>.
            </>
          ) : (
            <>Click a knob, slider or button on screen, then move one on the controller. Esc to stop.</>
          )}
        </p>
      )}

      <table className="midi-maps">
        <tbody>
          {control.mappings.map((m) => {
            const target = describeTarget(m.target, ctx)
            const key = `${m.control.device}|${m.control.channel}|${m.control.type}|${m.control.number}`
            return (
              <tr key={key} className={target.present ? undefined : 'absent'}>
                <td className="midi-control" title={m.control.device || 'Any input'}>
                  {describeControl(m.control)}
                </td>
                <td>
                  <select
                    value={m.kind}
                    aria-label="Kind of control"
                    onChange={(e) => control.update(m.control, { kind: e.target.value as MidiMapping['kind'] })}
                  >
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  {m.kind === 'relative' && (
                    <select
                      value={m.encoding}
                      aria-label="What it sends"
                      onChange={(e) => control.update(m.control, { encoding: e.target.value as MidiMapping['encoding'] })}
                    >
                      {Object.entries(ENCODING_LABELS).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  )}
                  {m.kind === 'button' && (
                    <select
                      value={m.button}
                      aria-label="What a press does"
                      onChange={(e) => control.update(m.control, { button: e.target.value as MidiMapping['button'] })}
                    >
                      {Object.entries(BUTTON_LABELS).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="midi-target">→ {target.label}</td>
                <td>
                  <select
                    value={m.control.device}
                    aria-label="Which input"
                    title="Listen to this input only, or to any"
                    onChange={(e) => control.update(m.control, { control: { ...m.control, device: e.target.value } })}
                  >
                    {m.control.device && <option value={m.control.device}>This input</option>}
                    <option value="">Any input</option>
                    {!m.control.device &&
                      devices.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <button
                    className="track-flag"
                    type="button"
                    title="Forget this mapping"
                    aria-label={`Forget ${describeControl(m.control)}`}
                    onClick={() => control.remove(m.control)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!control.mappings.length && <p className="midi-hint">Nothing mapped yet. Press Learn to start.</p>}

      <div className="midi-row">
        <button
          className="dock-toggle"
          type="button"
          disabled={!control.mappings.length}
          onClick={() =>
            downloadBytes(JSON.stringify(mappingsFile(control.mappings), null, 2), 'midi-mappings.json', 'application/json')
          }
        >
          Export…
        </button>
        <button className="dock-toggle" type="button" onClick={() => fileInput.current?.click()}>
          Import…
        </button>
        <ConfirmButton
          className="dock-toggle"
          ask="Forget all?"
          disabled={!control.mappings.length}
          onConfirm={() => control.setMappings([])}
        >
          Clear
        </ConfirmButton>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void importFile(file)
          }}
        />
      </div>

      <div className="midi-monitor-head">
        <span>Monitor</span>
        <button className="midi-link" type="button" onClick={() => control.monitor.clear()} disabled={!lines.length}>
          clear
        </button>
      </div>
      <ol className="midi-monitor" aria-label="Messages arriving, newest first">
        {lines.length ? (
          lines.map((line) => (
            <li key={line.id} title={line.device}>
              <span className="midi-msg">{line.text}</span>
              <span className="midi-result">{line.result}</span>
            </li>
          ))
        ) : (
          <li className="midi-empty">Move something on the controller to see what it sends.</li>
        )}
      </ol>
    </div>
  )
}
