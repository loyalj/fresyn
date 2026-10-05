import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadPrefs, savePrefs } from '../patch/storage'
import type { MidiMessage } from './midi'
import {
  bind,
  cleanMappings,
  correctedEncoding,
  describeControl,
  dispatch,
  freshState,
  Learner,
  matches,
  sameControl,
  type MappingState,
  type MidiControl,
  type MidiMapping,
} from './midiMap'
import { describeTarget, resolveTarget, targetAt, type TargetContext } from './midiTargets'

/** One line of the monitor: a message, and what it did. */
export interface MonitorLine {
  id: number
  device: string
  /** "CC 21 · ch 1 = 64", "Note C3 (48) · ch 10 on". */
  text: string
  /** What it moved, why it moved nothing, or that it was learnt. */
  result: string
}

/**
 * The last few messages, for the panel to show. Kept out of React state, so
 * that a knob turned on a controller re-renders the monitor and not the app.
 */
export class MidiMonitor {
  static readonly LINES = 14
  private lines: MonitorLine[] = []
  private listeners = new Set<() => void>()
  private next = 1

  push(m: MidiMessage, result: string) {
    const control = describeControl({ device: m.device, channel: m.channel, type: m.kind === 'cc' ? 'cc' : m.kind === 'bend' ? 'bend' : 'note', number: m.number })
    const value = m.kind === 'cc' ? ` = ${m.value}` : m.kind === 'bend' ? ` = ${m.fine ?? m.value}` : m.kind === 'noteOn' ? ` on ${m.value}` : ' off'
    this.lines = [{ id: this.next++, device: m.device, text: control + value, result }, ...this.lines].slice(0, MidiMonitor.LINES)
    for (const fn of this.listeners) fn()
  }

  clear() {
    this.lines = []
    for (const fn of this.listeners) fn()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  snapshot = () => this.lines
}

const keyOf = (c: MidiControl) => `${c.device}|${c.channel}|${c.type}|${c.number}`

interface Options {
  /** What the targets act on, as of the last render. */
  context: () => TargetContext
  notice: (text: string) => void
}

/**
 * The controller mappings: kept with this machine's preferences (they are
 * about the controller on the desk, not the song), learnt from the page, and
 * played as messages arrive.
 *
 * Learning: switched on, a click on any control that can be mapped picks it
 * -- and does nothing else, so a knob is not turned by the click that picks
 * it -- and the next control moved on a controller is mapped onto it. It
 * stays on for the next one, until it is switched off or Escape is pressed.
 */
export function useMidiControl({ context, notice }: Options) {
  const [mappings, setMappingsState] = useState<MidiMapping[]>(() => cleanMappings(loadPrefs().midiMappings))
  const [pickup, setPickupState] = useState(() => loadPrefs().midiPickup ?? true)
  const [learning, setLearning] = useState(false)
  /** The control on the page waiting for one on the controller. */
  const [armed, setArmed] = useState<{ id: string; label: string } | null>(null)
  const monitor = useMemo(() => new MidiMonitor(), [])

  const latest = useRef({ mappings, pickup, armed, context, notice })
  latest.current = { mappings, pickup, armed, context, notice }
  const states = useRef(new Map<string, MappingState>())
  const learner = useMemo(() => new Learner(), [])
  const quiet = useRef<number | undefined>(undefined)

  const setMappings = useCallback((next: MidiMapping[] | ((was: MidiMapping[]) => MidiMapping[])) => {
    setMappingsState((was) => {
      const value = typeof next === 'function' ? next(was) : next
      savePrefs({ midiMappings: value })
      return value
    })
  }, [])

  const setPickup = useCallback((on: boolean) => {
    setPickupState(on)
    savePrefs({ midiPickup: on })
  }, [])

  /** The learn in progress, finished: the control heard is mapped onto what was armed. */
  const finishLearn = useCallback(() => {
    window.clearTimeout(quiet.current)
    const target = latest.current.armed
    if (!target) return
    const mapping = learner.finish(target.id)
    if (!mapping) return
    setMappings((was) => bind(was, mapping))
    states.current.delete(keyOf(mapping.control))
    setArmed(null)
    const kind = mapping.kind === 'relative' ? 'endless knob' : mapping.kind === 'button' ? 'button' : 'knob or slider'
    latest.current.notice(`MIDI: ${describeControl(mapping.control)} (${kind}) now moves ${target.label}`)
  }, [learner, setMappings])

  /**
   * A message from a controller. True when a mapping, or a learn, took it --
   * in which case it is not also played as a note.
   */
  const handle = useCallback(
    (m: MidiMessage, otherwise?: (m: MidiMessage) => string | null): boolean => {
      const { mappings, pickup, armed, context } = latest.current
      if (armed) {
        const enough = learner.hear(m)
        if (!learner.started) return false
        monitor.push(m, `learning for ${armed.label}`)
        window.clearTimeout(quiet.current)
        if (enough) finishLearn()
        else quiet.current = window.setTimeout(finishLearn, Learner.QUIET_MS)
        return true
      }
      // An input named outright comes before a mapping for any input.
      let mapping =
        mappings.find((x) => x.control.device !== '' && matches(x.control, m)) ??
        mappings.find((x) => matches(x.control, m))
      if (!mapping) {
        // What nothing learnt takes: a surface in DAW mode, if it is one.
        const done = otherwise?.(m) ?? null
        if (done !== null) {
          monitor.push(m, done)
          return true
        }
        monitor.push(m, m.kind === 'noteOn' || m.kind === 'noteOff' ? 'not mapped: plays the selected track' : 'not mapped')
        return false
      }
      // An endless knob whose encoding was guessed wrong, put right by what it just sent.
      const fixed = mapping.kind === 'relative' ? correctedEncoding(mapping.encoding ?? 'twos', m.value) : null
      if (fixed) {
        mapping = { ...mapping, encoding: fixed }
        update(mapping.control, { encoding: fixed })
      }
      const target = resolveTarget(mapping.target, context())
      if (!target) {
        monitor.push(m, `${describeTarget(mapping.target, context()).label}`)
        return true
      }
      const key = keyOf(mapping.control)
      let state = states.current.get(key)
      if (!state) states.current.set(key, (state = freshState()))
      const did = dispatch(mapping, m, target, state, performance.now(), pickup)
      monitor.push(
        m,
        did
          ? target.label
          : mapping.kind === 'absolute' && target.kind === 'value' && state.pickup.waiting
            ? `${target.label}: move it to where the knob on screen is, to pick it up`
            : target.label,
      )
      return true
    },
    [learner, monitor, finishLearn],
  )

  // --- learning on the page ----------------------------------------------
  useEffect(() => {
    if (!learning) {
      setArmed(null)
      learner.reset()
      return
    }
    document.body.classList.add('midi-learning')
    /** The element last armed, lit until another is. */
    let lit: HTMLElement | null = null
    const light = (el: HTMLElement | null) => {
      lit?.removeAttribute('data-midi-armed')
      lit = el
      lit?.setAttribute('data-midi-armed', '')
    }
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || e.target.closest('.midi-panel')) return
      const hit = targetAt(e.target)
      if (!hit && !e.target.closest('[data-midi-param]')) return
      // The click that picks a control must not also turn it, press it or
      // start dragging it.
      e.preventDefault()
      e.stopPropagation()
      if (!hit) {
        latest.current.notice('That control cannot be mapped')
        return
      }
      const found = describeTarget(hit.id, latest.current.context())
      learner.reset()
      light(hit.element)
      setArmed({ id: hit.id, label: found.label })
    }
    // The click a press turns into, on a button, is swallowed with it.
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || e.target.closest('.midi-panel')) return
      if (e.target.closest('[data-midi-param]')) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // Escape ends learning and nothing else: not the panel, not a pick.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setLearning(false)
    }
    window.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('click', onClick, { capture: true })
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      document.body.classList.remove('midi-learning')
      light(null)
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('click', onClick, { capture: true })
      window.removeEventListener('keydown', onKey, { capture: true })
      window.clearTimeout(quiet.current)
    }
  }, [learning, learner])

  // While learning, what is already mapped is marked, so it can be seen
  // which knobs a controller already reaches. After every render, as the
  // page changes under it: a track selected is a different rack.
  // Nothing is looked at while not learning, once the marks are cleared: the
  // app renders on every knob turn.
  //
  // And while a controller is connected, every mapped control carries a
  // badge saying which of the controller's it answers to -- "CC21", "N36" --
  // so it can be seen at a glance what the hardware reaches.
  const marked = useRef(false)
  const [badges, setBadges] = useState(false)
  useEffect(() => {
    const showing = learning || (badges && mappings.length > 0)
    if (!showing && !marked.current) return
    document.querySelectorAll('[data-midi-mapped]').forEach((el) => el.removeAttribute('data-midi-mapped'))
    document.querySelectorAll('[data-midi-badge]').forEach((el) => el.removeAttribute('data-midi-badge'))
    marked.current = showing
    if (!showing) return
    const byTarget = new Map(mappings.map((m) => [m.target, m]))
    document.querySelectorAll('[data-midi-param]').forEach((el) => {
      const hit = targetAt(el)
      const m = hit && byTarget.get(hit.id)
      if (!m) return
      if (learning) el.setAttribute('data-midi-mapped', '')
      if (!badges) return
      // A slider cannot draw a badge of its own; its wrapper wears it.
      const host = el instanceof HTMLInputElement ? el.parentElement : el
      host?.setAttribute('data-midi-badge', shortControl(m.control))
    })
  })

  const remove = useCallback(
    (control: MidiControl) => setMappings((was) => was.filter((m) => !sameControl(m.control, control))),
    [setMappings],
  )
  const update = useCallback(
    (control: MidiControl, change: Partial<MidiMapping>) => {
      states.current.delete(keyOf(control))
      setMappings((was) => {
        const at = was.findIndex((m) => sameControl(m.control, control))
        if (at < 0) return was
        const next: MidiMapping = { ...was[at], ...change }
        if (next.kind !== 'relative') delete next.encoding
        else next.encoding ??= 'twos'
        if (next.kind !== 'button') delete next.button
        else next.button ??= 'toggle'
        // Changing which input it listens to could land on another mapping's
        // control: the one being changed wins, as a fresh learn would.
        return bind(was.filter((_, i) => i !== at), next)
      })
    },
    [setMappings],
  )

  return {
    mappings,
    setMappings,
    /** Show which controller control each mapped one answers to: while one is connected. */
    setBadges,
    remove,
    update,
    pickup,
    setPickup,
    learning,
    setLearning,
    armed,
    monitor,
    handle,
  }
}

export type MidiControlState = ReturnType<typeof useMidiControl>

/** A control in as few characters as a badge has room for: CC21, N36, F3 for a fader on channel 3. */
function shortControl(c: MidiControl): string {
  if (c.type === 'cc') return `CC${c.number}`
  if (c.type === 'bend') return `F${c.channel}`
  return `N${c.number}`
}
