import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadPrefs, savePrefs } from '../patch/storage'
import { soloTrack, stripOf, updateStrip, updateTrack } from '../song/edit'
import type { Song } from '../song/types'
import { faderGain, faderPosition } from '../ui/mixSpecs'
import { mcuFeedback, mcuNote, nothingSent, readMcu, type McuButton, type McuEvent, type McuSent, type McuView } from './mcu'
import type { MidiMessage } from './midi'
import { Pickup } from './midiMap'

/** Eight strips to a bank, as on every Mackie Control surface. */
export const STRIPS = 8
/** How far a V-pot's step turns a pan: fifty to cross it. */
const PAN_STEP = 0.04
/** How often the surface is brought up to date, besides when anything it shows changes. */
const REFRESH_MS = 200

/** What the surface acts on, as of the last render. */
export interface McuContext {
  song: Song
  /** The selected track. */
  trackId: string
  select: (id: string) => void
  editSong: (fn: (song: Song) => Song, key?: string) => void
  playing: () => boolean
  play: () => void
  stop: () => void
  /** Back or on by a bar while playing. */
  jumpBars: (n: -1 | 1) => void
  looping: boolean
  setLooping: (on: boolean) => void
  /** ● Rec in the roll: whether it is armed, and arming or disarming it. */
  recording: () => boolean
  toggleRecord: () => void
  /** The pattern before or after the one in the roll. */
  stepPattern: (n: -1 | 1) => void
}

interface Options {
  /** Whether MIDI is listening at all. */
  ready: boolean
  /** The inputs connected now. */
  devices: readonly string[]
  send: (device: string, data: number[]) => boolean
  context: () => McuContext
}

/**
 * A controller in DAW mode, as Fresyn's own: no learning, every control
 * meaning what Mackie Control says it does.
 *
 * The eight strips are eight tracks -- the first eight, and then the next
 * eight as the bank buttons move them along. A fader is the track's level
 * (picked up before it moves anything, so a fader standing low never drags a
 * loud track down), a knob its pan, M and S its mute and solo, Select makes
 * it the track on the bench, and R selects it and arms ● Rec, to record onto
 * it. Play, stop, record and cycle are the transport's; rewind and fast
 * forward go back and on a bar; up and down step through the tracks, left
 * and right through the patterns.
 *
 * And the surface is told how things are, so its lights mean something:
 * mute, solo, the selected track, playing, recording and the loop, each
 * fader where its track's level is -- which, on a surface without motors,
 * lights the LED that says a fader has not been picked up yet -- and each
 * knob's ring at its pan. Which inputs are in DAW mode is this machine's,
 * kept with its preferences.
 */
export function useMcu({ ready, devices, send, context }: Options) {
  const [enabled, setEnabledState] = useState<string[]>(() => loadPrefs().mcuDevices ?? [])
  const [bank, setBank] = useState(0)
  const latest = useRef({ enabled, bank, context })
  latest.current = { enabled, bank, context }
  const pickups = useMemo(() => Array.from({ length: STRIPS }, () => new Pickup()), [])
  /** What each surface was last sent. */
  const sent = useRef(new Map<string, McuSent>())

  const setEnabled = useCallback((device: string, on: boolean) => {
    setEnabledState((was) => {
      const next = on ? [...new Set([...was, device])] : was.filter((d) => d !== device)
      savePrefs({ mcuDevices: next })
      return next
    })
    // Sent everything afresh when it is next in DAW mode.
    sent.current.delete(device)
  }, [])

  /**
   * A message from a surface in DAW mode: what it did, for the monitor, or
   * null when it is not from one.
   */
  const handle = useCallback(
    (m: MidiMessage): string | null => {
      const { enabled, bank } = latest.current
      if (!enabled.includes(m.device)) return null
      const e = readMcu(m)
      if (!e) return 'DAW mode: not a Mackie Control message'
      const said = describe(e, bank)
      try {
        act(e)
      } catch {
        return `${said} (did nothing)`
      }
      return said
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const act = (e: McuEvent) => {
    {
      const { bank, context } = latest.current
      const ctx = context()
      const tracks = ctx.song.tracks
      const trackAt = (strip: number) => tracks[bank + strip]

      if (e.kind === 'fader') {
        const track = trackAt(e.strip)
        if (!track) return
        const pickup = pickups[e.strip]
        const now = performance.now()
        if (!pickup.accept(e.position, faderPosition(track.gain), now)) return
        const gain = faderGain(e.position)
        pickup.wrote(faderPosition(gain), now)
        ctx.editSong((s) => updateTrack(s, track.id, { gain }), `gain:${track.id}`)
        return
      }
      if (e.kind === 'vpot') {
        const track = trackAt(e.strip)
        if (!track) return
        const pan = Math.round(Math.min(1, Math.max(-1, stripOf(track).pan + e.steps * PAN_STEP)) * 1000) / 1000
        ctx.editSong((s) => updateStrip(s, track.id, { pan }), `strip:${track.id}:pan`)
        return
      }
      if (e.kind === 'master' || !e.down) return

      const track = trackAt(e.strip)
      const move = (by: number) => {
        const at = tracks.findIndex((t) => t.id === ctx.trackId)
        const next = tracks[Math.min(tracks.length - 1, Math.max(0, at + by))]
        if (next) ctx.select(next.id)
      }
      const bankBy = (by: number) => {
        setBank((b) => {
          const next = b + by
          return next < 0 || next >= tracks.length ? b : next
        })
        for (const p of pickups) p.reset()
      }
      const press: Partial<Record<McuButton, () => void>> = {
        mute: () => track && ctx.editSong((s) => updateTrack(s, track.id, { mute: track.mute ? undefined : true })),
        solo: () => track && ctx.editSong((s) => soloTrack(s, track.id)),
        select: () => track && ctx.select(track.id),
        rec: () => {
          if (!track) return
          ctx.select(track.id)
          ctx.toggleRecord()
        },
        vpot: () => track && ctx.editSong((s) => updateStrip(s, track.id, { pan: 0 })),
        bankLeft: () => bankBy(-STRIPS),
        bankRight: () => bankBy(STRIPS),
        // This kind of surface labels its bank buttons Channel: either
        // moves the strips a whole bank, which is what its manual says.
        channelLeft: () => bankBy(-STRIPS),
        channelRight: () => bankBy(STRIPS),
        play: () => !ctx.playing() && ctx.play(),
        stop: () => ctx.playing() && ctx.stop(),
        record: () => ctx.toggleRecord(),
        cycle: () => ctx.setLooping(!ctx.looping),
        rewind: () => ctx.jumpBars(-1),
        forward: () => ctx.jumpBars(1),
        up: () => move(-1),
        down: () => move(1),
        left: () => ctx.stepPattern(-1),
        right: () => ctx.stepPattern(1),
      }
      press[e.button]?.()
    }
  }

  // The surfaces brought up to date: whenever a render may have changed what
  // they show, and every so often besides, for what changes without one --
  // the transport, ● Rec. Only what differs is sent.
  const refresh = useCallback(() => {
    const { enabled, bank, context } = latest.current
    if (!ready) return
    const ctx = context()
    const view: McuView = { lit: {}, faders: [], rings: [] }
    for (let i = 0; i < STRIPS; i++) {
      const t = ctx.song.tracks[bank + i]
      view.lit[mcuNote('mute', i)!] = !!t?.mute
      view.lit[mcuNote('solo', i)!] = !!t?.solo
      view.lit[mcuNote('select', i)!] = !!t && t.id === ctx.trackId
      view.lit[mcuNote('rec', i)!] = !!t && t.id === ctx.trackId && ctx.recording()
      view.faders.push(t ? faderPosition(t.gain) : 0)
      view.rings.push(t ? (stripOf(t).pan + 1) / 2 : null)
    }
    view.lit[mcuNote('play')!] = ctx.playing()
    view.lit[mcuNote('stop')!] = false
    view.lit[mcuNote('record')!] = ctx.recording()
    view.lit[mcuNote('cycle')!] = ctx.looping
    for (const device of enabled) {
      if (!devices.includes(device)) {
        sent.current.delete(device)
        continue
      }
      let s = sent.current.get(device)
      if (!s) sent.current.set(device, (s = nothingSent()))
      for (const msg of mcuFeedback(view, s)) send(device, msg)
    }
  }, [ready, devices, send])

  useEffect(() => {
    refresh()
    // The tracks under the surface's strips, bracketed in the track list.
    document.querySelectorAll('[data-mcu-strip]').forEach((el) => el.removeAttribute('data-mcu-strip'))
    if (!ready || !enabled.some((d) => devices.includes(d))) return
    const tracks = latest.current.context().song.tracks
    for (let i = 0; i < STRIPS; i++) {
      const t = tracks[bank + i]
      if (!t) break
      document.querySelector(`.track[data-track="${CSS.escape(t.id)}"]`)?.setAttribute('data-mcu-strip', String(i + 1))
    }
  })
  useEffect(() => {
    if (!ready || !enabled.length) return
    const t = window.setInterval(refresh, REFRESH_MS)
    return () => window.clearInterval(t)
  }, [ready, enabled, refresh])

  return { enabled, setEnabled, bank, handle }
}

export type McuState = ReturnType<typeof useMcu>

const BUTTON_NAMES: Record<McuButton, string> = {
  rec: 'Rec', solo: 'Solo', mute: 'Mute', select: 'Select', vpot: 'Pan to centre', touch: 'Fader touched',
  bankLeft: 'Bank ◀', bankRight: 'Bank ▶', channelLeft: 'Bank ◀', channelRight: 'Bank ▶',
  rewind: 'Back a bar', forward: 'On a bar', stop: 'Stop', play: 'Play', record: '● Rec', cycle: 'Loop',
  up: 'Track above', down: 'Track below', left: 'Pattern before', right: 'Pattern after',
}
const STRIP_BUTTONS = new Set<McuButton>(['rec', 'solo', 'mute', 'select', 'vpot', 'touch'])

/** What a message from the surface is, for the monitor. */
function describe(e: McuEvent, bank: number): string {
  const track = (strip: number) => `track ${bank + strip + 1}`
  if (e.kind === 'fader') return `DAW mode · ${track(e.strip)} level`
  if (e.kind === 'master') return 'DAW mode · master fader (not used)'
  if (e.kind === 'vpot') return `DAW mode · ${track(e.strip)} pan`
  const name = BUTTON_NAMES[e.button]
  const where = STRIP_BUTTONS.has(e.button) ? `, ${track(e.strip)}` : ''
  return `DAW mode · ${name}${where}${e.down ? '' : ' (let go)'}`
}
