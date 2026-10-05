import { defOf } from '../patch/defs'
import { clampValue, denormalize, normalize, type ParamSpec } from '../patch/param'
import type { Patch } from '../patch/types'
import { consoleOf, soloTrack, stripOf, updateConsole, updateStrip, updateTrack } from '../song/edit'
import type { Song, Track } from '../song/types'
import { BALANCE, EQ, faderGain, faderPosition, PAN, RETURNS, SEND_DELAY, SEND_SPACE } from '../ui/mixSpecs'
import type { MidiTarget } from './midiMap'

/**
 * What a controller's knobs can be mapped onto, named by a path:
 *
 *   rack/<module>/<param>   a knob or switch in the rack on the bench
 *   rack/<module>/gate      a module's Trigger button
 *   track/<n>/<what>        the nth track's level, pan, EQ, sends, mute, solo
 *   master/<what>           the master bus: level, balance, EQ, limiter
 *   space/<what>, delay/<what>  the two shared effects
 *   transport/<what>        play, loop and record, as their buttons
 *
 * The rack is whichever one is on the bench, and a track is counted by its
 * place in the list, not by name -- the way a hardware desk's first fader is
 * the first channel whatever is plugged into it. That is what lets one set
 * of mappings work in every project: the first slider is the first track's
 * level, and the cutoff knob turns the cutoff of whatever is selected.
 *
 * On the page, a control says what it is with `data-midi-param`, and where
 * it is with the `data-midi-scope` or `data-module` of what it sits in. See
 * `targetAt`.
 */

export interface TargetContext {
  /** The rack on the bench, and its knobs. */
  patch: Patch
  values: Record<string, number>
  setParam: (module: string, param: string, value: number) => void
  press: (module: string) => void
  release: (module: string) => void
  song: Song
  editSong: (fn: (song: Song) => Song, key?: string) => void
}

/** A knob with a spec, as a value target over `get` and `put`. */
function knobTarget(label: string, spec: ParamSpec, get: () => number, put: (v: number) => void): MidiTarget {
  return {
    kind: 'value',
    label,
    steps: spec.steps?.length,
    get: () => normalize(spec, get()),
    set: (t) => {
      const v = clampValue(spec, denormalize(spec, t))
      put(v)
      return normalize(spec, v)
    },
  }
}

const STRIP_LABELS: Record<string, string> = {
  gain: 'Level', pan: 'Pan', high: 'High', mid: 'Mid', low: 'Low', space: 'Space send', delay: 'Delay send', mute: 'Mute', solo: 'Solo',
}

function trackTarget(ctx: TargetContext, n: number, what: string): MidiTarget | null {
  const track = ctx.song.tracks[n - 1]
  if (!track) return null
  const id = track.id
  const label = `${track.name || `Track ${n}`} ${STRIP_LABELS[what] ?? what}`
  // Read from the song an edit is made to, not the one this was resolved
  // from: messages come faster than the page catches up.
  const latest = (s: Song): Track | undefined => s.tracks.find((t) => t.id === id)
  switch (what) {
    case 'gain':
      return {
        kind: 'value',
        label,
        get: () => faderPosition(track.gain),
        set: (t) => {
          const gain = faderGain(t)
          ctx.editSong((s) => updateTrack(s, id, { gain }), `gain:${id}`)
          return faderPosition(gain)
        },
      }
    case 'pan':
    case 'space':
    case 'delay': {
      const spec = what === 'pan' ? PAN : what === 'space' ? SEND_SPACE : SEND_DELAY
      return knobTarget(label, spec, () => stripOf(track)[what], (v) =>
        ctx.editSong((s) => updateStrip(s, id, { [what]: v }), `strip:${id}:${what}`),
      )
    }
    case 'high':
    case 'mid':
    case 'low':
      return knobTarget(label, EQ[what], () => stripOf(track).eq[what], (v) =>
        ctx.editSong((s) => {
          const t = latest(s)
          return t ? updateStrip(s, id, { eq: { ...stripOf(t).eq, [what]: v } }) : s
        }, `strip:${id}:${what}`),
      )
    case 'mute':
      return {
        kind: 'switch',
        label,
        get: () => !!track.mute,
        set: (on) => ctx.editSong((s) => updateTrack(s, id, { mute: on ? true : undefined })),
      }
    case 'solo':
      return {
        kind: 'switch',
        label,
        get: () => !!track.solo,
        // Solo is one track at a time, as the S buttons are.
        set: (on) => ctx.editSong((s) => (!!latest(s)?.solo === on ? s : soloTrack(s, id))),
      }
  }
  return null
}

function deskTarget(ctx: TargetContext, bus: 'master' | 'space' | 'delay', what: string): MidiTarget | null {
  const desk = consoleOf(ctx.song)
  const edit = (change: Parameters<typeof updateConsole>[1]) =>
    ctx.editSong((s) => updateConsole(s, change), `console:${bus}.${what}`)
  const name = bus === 'master' ? 'Master' : bus === 'space' ? 'Space' : 'Delay'
  if (bus === 'master') {
    if (what === 'level') {
      return {
        kind: 'value',
        label: 'Master level',
        get: () => faderPosition(desk.master.level),
        set: (t) => {
          const level = faderGain(t)
          edit({ master: { level } })
          return faderPosition(level)
        },
      }
    }
    if (what === 'balance') return knobTarget('Master balance', BALANCE, () => desk.master.balance, (v) => edit({ master: { balance: v } }))
    if (what === 'high' || what === 'mid' || what === 'low') {
      return knobTarget(`Master ${EQ[what].label}`, EQ[what], () => desk.master.eq[what], (v) =>
        ctx.editSong((s) => updateConsole(s, { master: { eq: { ...consoleOf(s).master.eq, [what]: v } } }), `console:master.${what}`),
      )
    }
    if (what === 'limiter') {
      return {
        kind: 'switch',
        label: 'Master limiter',
        get: () => desk.master.limiter,
        set: (on) => ctx.editSong((s) => updateConsole(s, { master: { limiter: on } })),
      }
    }
    return null
  }
  const specs: Record<string, ParamSpec | undefined> =
    bus === 'space'
      ? { size: RETURNS.size, decay: RETURNS.decay, damping: RETURNS.spaceDamp, level: RETURNS.spaceLevel }
      : { time: RETURNS.time, feedback: RETURNS.feedback, damping: RETURNS.delayDamp, level: RETURNS.delayLevel }
  const spec = specs[what]
  if (!spec) return null
  const fx = desk[bus] as Record<string, number>
  return knobTarget(`${name} ${spec.label}`, spec, () => fx[what], (v) => edit({ [bus]: { [what]: v } }))
}

function rackTarget(ctx: TargetContext, module: string, what: string): MidiTarget | null {
  const m = ctx.patch.modules.find((x) => x.id === module)
  if (!m) return null
  const def = defOf(m.type)
  const spec = def.params.find((p) => p.id === what)
  if (spec) {
    const key = `${module}.${what}`
    return knobTarget(`${def.name} ${spec.label} (${module})`, spec, () => ctx.values[key] ?? spec.default, (v) =>
      ctx.setParam(module, what, v),
    )
  }
  if (what === 'gate' && def.trigger) {
    return { kind: 'trigger', label: `${def.name} trigger (${module})`, press: () => ctx.press(module), release: () => ctx.release(module) }
  }
  return null
}

const TRANSPORT_LABELS: Record<string, string> = { play: 'Play / stop', loop: 'Loop', record: 'Record' }

/**
 * A button on the page, pressed as a click on it, and on while it shows it
 * is. For the transport, whose buttons decide for themselves where to play
 * from and what recording means. Present only while the button is: Record is
 * on the roll, so it waits while the Song view is showing.
 */
function buttonTarget(scope: string, what: string): MidiTarget | null {
  const el = document.querySelector<HTMLElement>(
    `[data-midi-scope="${CSS.escape(scope)}"][data-midi-param="${CSS.escape(what)}"]`,
  )
  if (!el) return null
  const isOn = () => el.getAttribute('aria-pressed') === 'true' || el.classList.contains('on')
  return {
    kind: 'switch',
    label: TRANSPORT_LABELS[what] ?? what,
    get: isOn,
    set: (on) => {
      if (on !== isOn()) el.click()
    },
  }
}

/** The thing a target path names, as things stand; null while it is not there. */
export function resolveTarget(id: string, ctx: TargetContext): MidiTarget | null {
  const parts = id.split('/')
  const [scope, a, b] = parts
  if (scope === 'rack' && a && b) return rackTarget(ctx, a, b)
  if (scope === 'track' && a && b) return trackTarget(ctx, Number(a), b)
  if ((scope === 'master' || scope === 'space' || scope === 'delay') && a) return deskTarget(ctx, scope, a)
  if (scope === 'transport' && a && typeof document !== 'undefined') return buttonTarget(scope, a)
  return null
}

/** A target's name for the mapping list, said even when it is not there right now. */
export function describeTarget(id: string, ctx: TargetContext): { label: string; present: boolean } {
  const t = resolveTarget(id, ctx)
  if (t) return { label: t.label, present: true }
  const [scope, a, b] = id.split('/')
  if (scope === 'rack') return { label: `${a} ${b} (not in this rack)`, present: false }
  if (scope === 'track') return { label: `Track ${a} ${STRIP_LABELS[b] ?? b} (no such track)`, present: false }
  if (scope === 'transport') return { label: `${TRANSPORT_LABELS[a] ?? a} (not on screen)`, present: false }
  return { label: id, present: false }
}

/** The target path of the control at or around an element on the page, or null for one that cannot be mapped. */
export function targetAt(el: Element): { id: string; element: HTMLElement } | null {
  const control = el.closest<HTMLElement>('[data-midi-param]')
  if (!control) return null
  const what = control.dataset.midiParam!
  const scope = control.closest<HTMLElement>('[data-midi-scope]')
  if (scope) return { id: `${scope.dataset.midiScope}/${what}`, element: control }
  const unit = control.closest<HTMLElement>('[data-module]')
  if (unit) return { id: `rack/${unit.dataset.module}/${what}`, element: control }
  return null
}
