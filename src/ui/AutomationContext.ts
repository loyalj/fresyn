import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { Transport } from '../audio/Transport'
import { automationValueAt, isAutomated } from '../song/automation'
import type { Song } from '../song/types'

/**
 * Where an automated knob is while the song plays, for drawing it there.
 *
 * Worked out on this side from the song and the playhead rather than read
 * back from the audio thread: the curve is the same arithmetic either way,
 * and this way a knob nobody can see costs nothing. Each knob subscribes to
 * its own target, so the knob being swept redraws and the rest of the rack
 * does not.
 */
export class AutomationView {
  /** What is playing, which the values come from; and the song being edited, which says what is automated. */
  private playing: Song | null = null
  private doc: Song | null = null
  /** Taken from the automation by a hand on them until the song stops: drawn where the hand put them. */
  private held = new Set<string>()
  private values = new Map<string, number | null>()
  private listeners = new Map<string, Set<() => void>>()
  private docListeners = new Set<() => void>()

  constructor(private readonly transport: Transport) {
    transport.subscribe((state) => {
      if (!state.playing) this.held.clear()
      this.update()
    })
  }

  setSongs(playing: Song, doc: Song) {
    this.playing = playing
    if (doc !== this.doc) {
      this.doc = doc
      for (const fn of this.docListeners) fn()
    }
    this.update()
  }

  hold(target: string) {
    if (!this.transport.state.playing || this.held.has(target)) return
    this.held.add(target)
    this.update()
  }

  /** Given back to the automation: the hand let go of it while recording. */
  release(target: string) {
    if (this.held.delete(target)) this.update()
  }

  private update() {
    const tick = this.transport.heardTick()
    for (const [target, fns] of this.listeners) {
      const v = tick === null || !this.playing || this.held.has(target) ? null : automationValueAt(this.playing, target, tick)
      if (v === (this.values.get(target) ?? null)) continue
      this.values.set(target, v)
      for (const fn of fns) fn()
    }
  }

  subscribe(target: string, fn: () => void): () => void {
    let set = this.listeners.get(target)
    if (!set) this.listeners.set(target, (set = new Set()))
    set.add(fn)
    return () => {
      set!.delete(fn)
      if (!set!.size) {
        this.listeners.delete(target)
        this.values.delete(target)
      }
    }
  }

  value(target: string): number | null {
    return this.values.get(target) ?? null
  }

  subscribeDoc(fn: () => void): () => void {
    this.docListeners.add(fn)
    return () => {
      this.docListeners.delete(fn)
    }
  }

  /** Whether any pattern has a lane for it -- placed or not, so a pattern being written on its own counts. */
  automated(target: string): boolean {
    return !!this.doc && (isAutomated(this.doc, target) || this.doc.patterns.some((p) => p.automation?.some((l) => l.target === target && l.points.length)))
  }
}

export interface AutomationUi {
  view: AutomationView
  /** Start automating a target in the pattern being written, and show its lane. */
  automate: (target: string) => void
}

export const AutomationContext = createContext<AutomationUi | null>(null)

/**
 * The start of the target path for the knobs inside: `rack/<track>/` and a
 * pad's prefix for the rack, plus `<module>.` for a unit; `strip/<track>/`,
 * `master/` and so on for the Mix view. A knob's own id finishes it.
 */
export const AutomationScope = createContext<string | null>(null)

/**
 * The target of a knob with this id where it sits, and where its automation
 * has it right now (0..1, or null when nothing is moving it), and whether
 * any clip automates it at all.
 */
export function useAutomation(id: string) {
  const ui = useContext(AutomationContext)
  const scope = useContext(AutomationScope)
  const target = ui && scope !== null ? scope + id : null
  const view = ui?.view
  const subscribe = useCallback((fn: () => void) => (view && target ? view.subscribe(target, fn) : () => {}), [view, target])
  const position = useSyncExternalStore(subscribe, () => (view && target ? view.value(target) : null))
  const subscribeDoc = useCallback((fn: () => void) => (view ? view.subscribeDoc(fn) : () => {}), [view])
  const automated = useSyncExternalStore(subscribeDoc, () => (view && target ? view.automated(target) : false))
  return { target, position, automated, automate: ui && target ? () => ui.automate(target) : null }
}
