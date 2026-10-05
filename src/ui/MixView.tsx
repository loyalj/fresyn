import { useEffect, useRef, useState } from 'react'
import { folderOf, heardTracks } from '../song/folder'
import type { AudioEngine } from '../audio/AudioEngine'
import { consoleOf, stripOf, updateConsole, updateStrip } from '../song/edit'
import type { Song, Track } from '../song/types'
import { AutomationScope, useAutomation } from './AutomationContext'
import { Knob } from './Knob'
import { ContextMenu } from './Menu'
import { FALL, fillBar, scale } from './meter'
import { BALANCE, EQ, FADER_MAX_DB, FADER_MIN_DB, faderGain, PAN, RETURNS, SEND_DELAY, SEND_SPACE, toDb, toGain } from './mixSpecs'
import { useFallingMeter } from './useFallingMeter'

interface Props {
  song: Song
  /** An edit to the song, grouped under `key` so one drag is one undo step. */
  onEdit: (fn: (song: Song) => Song, key?: string) => void
  onTrack: (id: string, change: Partial<Omit<Track, 'id'>>, key?: string) => void
  onSolo: (id: string) => void
  engine: AudioEngine
  /** Whether hidden tracks get strips after all. */
  showHidden: boolean
}

const dbText = (gain: number) => {
  if (gain <= 0) return '−∞ dB'
  const db = 20 * Math.log10(gain)
  return `${db > -0.05 && db < 0.05 ? '0.0' : db.toFixed(1).replace('-', '−')} dB`
}

/**
 * The song's mixing desk: a channel strip per track, the two shared effects
 * they send to, and the master bus.
 *
 * Every knob here is a field of the song, so a mix is undone, saved and
 * bounced like anything else in it. The meters, like every meter in the app,
 * are written straight to the page from the audio thread's reports and never
 * go through React.
 */
export function MixView({ song, onEdit, onTrack, onSolo, engine, showHidden }: Props) {
  const desk = consoleOf(song)
  const heard = heardTracks(song)
  const bars = useRef(new Map<string, HTMLDivElement>())
  const feed = useFallingMeter(FALL, (id: string, v) => fillBar(bars.current.get(id), v))
  const lufs = useRef<HTMLSpanElement>(null)

  useEffect(
    () =>
      engine.onMixLevels((levels) => {
        // Kept at the louder of two reports that land in one frame: a track
        // can report more than once before the bar is drawn.
        for (const [id, peak] of Object.entries(levels.tracks)) feed(id, scale(peak), true)
        feed('master', scale(levels.master), true)
        const el = lufs.current
        if (el) el.textContent = levels.shortTerm <= -70 ? '— LUFS' : `${levels.shortTerm.toFixed(1).replace('-', '−')} LUFS`
      }),
    [engine, feed],
  )

  const meter = (id: string) => (
    <div className="strip-meter level-meter mix-meter" aria-hidden="true">
      <div
        className="strip-meter-fill level-meter-fill"
        ref={(el) => {
          if (el) bars.current.set(id, el)
          else bars.current.delete(id)
        }}
      />
    </div>
  )

  const fader = (label: string, gain: number, onChange: (gain: number) => void, param: string) => (
    <Fader label={label} gain={gain} onChange={onChange} param={param} />
  )

  return (
    <div className="mix">
      <div className="mix-strips">
        {/* A hidden track still plays, so it is still mixed -- just not
            shown, unless the track list has been asked to list them. */}
        {song.tracks.filter((t) => showHidden || !t.hidden).map((track) => {
          const strip = stripOf(track)
          const silent = !heard.has(track.id)
          const folder = folderOf(song, track)
          const set = (change: Parameters<typeof updateStrip>[2], field: string) =>
            onEdit((s) => updateStrip(s, track.id, change), `strip:${track.id}:${field}`)
          return (
            // Automated by the track's id, where a controller counts strips by place.
            <AutomationScope.Provider key={track.id} value={`strip/${track.id}/`}>
            <div
              className={`mix-strip${silent ? ' silent' : ''}${track.color !== undefined ? ' colored' : ''}`}
              style={track.color !== undefined ? ({ '--track-h': track.color } as React.CSSProperties) : undefined}
              // Counted by its place in the song, as a controller's faders are.
              data-midi-scope={`track/${song.tracks.indexOf(track) + 1}`}
            >
              <div className="mix-name" title={folder ? `${track.name}, in ${folder.name}` : track.name}>
                {folder && <span className="mix-folder">{folder.name}</span>}
                {track.name}
              </div>
              <div className="mix-body">
                <div className="mix-knobs">
                  <Knob spec={EQ.high} value={strip.eq.high} onChange={(v) => set({ eq: { ...strip.eq, high: v } }, 'high')} />
                  <Knob spec={SEND_SPACE} value={strip.space} onChange={(v) => set({ space: v }, 'space')} />
                  <Knob spec={EQ.mid} value={strip.eq.mid} onChange={(v) => set({ eq: { ...strip.eq, mid: v } }, 'mid')} />
                  <Knob spec={SEND_DELAY} value={strip.delay} onChange={(v) => set({ delay: v }, 'delay')} />
                  <Knob spec={EQ.low} value={strip.eq.low} onChange={(v) => set({ eq: { ...strip.eq, low: v } }, 'low')} />
                  <Knob spec={PAN} value={strip.pan} onChange={(v) => set({ pan: v }, 'pan')} />
                </div>
                <div className="mix-level">
                  {fader(`${track.name} level`, track.gain, (g) => onTrack(track.id, { gain: g }, `gain:${track.id}`), 'gain')}
                  {meter(track.id)}
                </div>
              </div>
              <div className="mix-foot">
                <span className="mix-db">{dbText(track.gain)}</span>
                <button
                  className={`track-flag${track.mute ? ' on' : ''}`}
                  data-midi-param="mute"
                  onClick={() => onTrack(track.id, { mute: track.mute ? undefined : true })}
                  title="Mute"
                  type="button"
                >
                  M
                </button>
                <button
                  className={`track-flag${track.solo ? ' on' : ''}`}
                  data-midi-param="solo"
                  onClick={() => onSolo(track.id)}
                  title="Solo"
                  type="button"
                >
                  S
                </button>
              </div>
            </div>
            </AutomationScope.Provider>
          )
        })}
      </div>

      {/* The two effects every strip can send to. One of each for the whole
          song: a room the whole band is in, not a reverb per instrument. */}
      <div className="mix-returns">
        <div className="mix-return" data-midi-scope="space">
          <div className="mix-name">Space</div>
          <AutomationScope.Provider value="space/">
          <div className="mix-knobs">
            <Knob spec={RETURNS.size} value={desk.space.size} onChange={(v) => onEdit((s) => updateConsole(s, { space: { size: v } }), 'console:space.size')} />
            <Knob spec={RETURNS.decay} value={desk.space.decay} onChange={(v) => onEdit((s) => updateConsole(s, { space: { decay: v } }), 'console:space.decay')} />
            <Knob spec={RETURNS.spaceDamp} value={desk.space.damping} onChange={(v) => onEdit((s) => updateConsole(s, { space: { damping: v } }), 'console:space.damping')} />
            <Knob spec={RETURNS.spaceLevel} value={desk.space.level} onChange={(v) => onEdit((s) => updateConsole(s, { space: { level: v } }), 'console:space.level')} />
          </div>
          </AutomationScope.Provider>
        </div>
        <div className="mix-return" data-midi-scope="delay">
          <div className="mix-name">Delay</div>
          <AutomationScope.Provider value="delay/">
          <div className="mix-knobs">
            <Knob spec={RETURNS.time} value={desk.delay.time} onChange={(v) => onEdit((s) => updateConsole(s, { delay: { time: v } }), 'console:delay.time')} />
            <Knob spec={RETURNS.feedback} value={desk.delay.feedback} onChange={(v) => onEdit((s) => updateConsole(s, { delay: { feedback: v } }), 'console:delay.feedback')} />
            <Knob spec={RETURNS.delayDamp} value={desk.delay.damping} onChange={(v) => onEdit((s) => updateConsole(s, { delay: { damping: v } }), 'console:delay.damping')} />
            <Knob spec={RETURNS.delayLevel} value={desk.delay.level} onChange={(v) => onEdit((s) => updateConsole(s, { delay: { level: v } }), 'console:delay.level')} />
          </div>
          </AutomationScope.Provider>
        </div>
      </div>

      {/* The master bus: the whole mix, on its way out. */}
      <div className="mix-strip mix-master" data-midi-scope="master">
        <div className="mix-name">Master</div>
        <AutomationScope.Provider value="master/">
        <div className="mix-body">
          <div className="mix-knobs">
            <Knob spec={EQ.high} value={desk.master.eq.high} onChange={(v) => onEdit((s) => updateConsole(s, { master: { eq: { ...desk.master.eq, high: v } } }), 'console:master.high')} />
            <Knob spec={BALANCE} value={desk.master.balance} onChange={(v) => onEdit((s) => updateConsole(s, { master: { balance: v } }), 'console:master.balance')} />
            <Knob spec={EQ.mid} value={desk.master.eq.mid} onChange={(v) => onEdit((s) => updateConsole(s, { master: { eq: { ...desk.master.eq, mid: v } } }), 'console:master.mid')} />
            <button
              className={`dock-toggle mix-limiter${desk.master.limiter ? ' on' : ''}`}
              data-midi-param="limiter"
              onClick={() => onEdit((s) => updateConsole(s, { master: { limiter: !desk.master.limiter } }))}
              title="A brickwall at -1 dB: the mix can never clip"
              aria-pressed={desk.master.limiter}
              type="button"
            >
              Limit
            </button>
            <Knob spec={EQ.low} value={desk.master.eq.low} onChange={(v) => onEdit((s) => updateConsole(s, { master: { eq: { ...desk.master.eq, low: v } } }), 'console:master.low')} />
          </div>
          <div className="mix-level">
            {fader('Master level', desk.master.level, (g) => onEdit((s) => updateConsole(s, { master: { level: g } }), 'console:master.level'), 'level')}
            {meter('master')}
          </div>
        </div>
        </AutomationScope.Provider>
        <div className="mix-foot">
          <span className="mix-db">{dbText(desk.master.level)}</span>
          <span className="mix-lufs" ref={lufs} title="Loudness of the mix over the last 3 seconds">
            — LUFS
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * A fader in dB, drawn where the song's automation has it while it plays,
 * and with Automate in this pattern on its right-click, as a knob has.
 */
function Fader({ label, gain, onChange, param }: { label: string; gain: number; onChange: (gain: number) => void; param: string }) {
  const automation = useAutomation(param)
  const shown = automation.position !== null ? faderGain(automation.position) : gain
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <div className={`mix-fader-wrap${automation.automated ? ' automated' : ''}`}>
      <input
        className="mix-fader"
        data-midi-param={param}
        type="range"
        min={FADER_MIN_DB}
        max={FADER_MAX_DB}
        step={0.1}
        value={toDb(shown)}
        aria-label={label}
        title={`${label}: ${dbText(shown)} (double-click for 0 dB)`}
        onChange={(e) => onChange(toGain(Number(e.target.value)))}
        onDoubleClick={() => onChange(1)}
        onContextMenu={(e) => {
          if (!automation.automate) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      />
      {menu && automation.automate && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ kind: 'action', label: 'Automate in this pattern', onSelect: automation.automate }]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
