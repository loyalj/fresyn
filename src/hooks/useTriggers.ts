import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import { MODE_LATCH } from '../dsp/modules/Gate'
import { defOf } from '../patch/defs'
import type { Patch } from '../patch/types'

/**
 * Playing the rack's Triggers: their gates, their latches, and the keys they
 * are bound to.
 */
export function useTriggers(
  engine: AudioEngine,
  trackId: string,
  patch: Patch,
  values: Readonly<Record<string, number>>,
  /**
   * Told of every gate opened or closed here, after it is sent: the news a
   * recording roll listens for. Read through a ref, so a new function each
   * render does not rebuild every key binding.
   */
  onGate?: (moduleId: string, open: boolean) => void,
) {
  const told = useRef(onGate)
  told.current = onGate
  /**
   * Triggers currently latched open, by module id.
   *
   * Latch is the one fire mode that is not in the DSP. It changes what a press
   * means rather than what the gate carries, so the audio thread sees nothing
   * but an ordinary held gate that the release never arrives for. Keeping it
   * here is also what lets the button light up: a Trigger has no inputs, so
   * the key and the button are the only things that can open one, and both of
   * them are already on this side.
   */
  const [latched, setLatched] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * The Trigger whose key cap is waiting to be told which key, if any. One at
   * a time: the wait takes the whole keyboard, so a second cap listening at
   * the same time would be two panels racing for the same press.
   */
  const [listening, setListening] = useState<string | null>(null)

  /**
   * Open one module's gate. There is no rack-wide gate any more: a Trigger is
   * played by its own key or its own button, and everything else in the rack
   * hears it down a cable.
   *
   * The gate is recorded before the context is asked to open, not after. The
   * other way round it would land behind an await, and a key tapped while the
   * context was still booting would open a gate whose release had already gone
   * past -- a note stuck on from the first press of the session.
   */
  const gateOn = useCallback(
    (moduleId: string) => {
      engine.gate(true, trackId, moduleId)
      void engine.start()
      told.current?.(moduleId, true)
    },
    [engine, trackId],
  )

  const gateOff = useCallback(
    (moduleId: string) => {
      engine.gate(false, trackId, moduleId)
      told.current?.(moduleId, false)
    },
    [engine, trackId],
  )

  /** A module's Mode, as the knob currently reads. */
  const modeOf = useCallback(
    (moduleId: string) => Math.round(values[`${moduleId}.mode`] ?? 0),
    [values],
  )

  /**
   * A press, wherever it came from. The key and the panel button both arrive
   * here so that a mode means the same thing however the Trigger was played.
   */
  const press = useCallback(
    (moduleId: string) => {
      if (modeOf(moduleId) !== MODE_LATCH) {
        gateOn(moduleId)
        return
      }
      const on = latched.has(moduleId)
      if (on) gateOff(moduleId)
      else gateOn(moduleId)
      setLatched((prev) => {
        const next = new Set(prev)
        if (on) next.delete(moduleId)
        else next.add(moduleId)
        return next
      })
    },
    [latched, modeOf, gateOn, gateOff],
  )

  /** The release. A latched Trigger ignores it; that is the whole of latch. */
  const release = useCallback(
    (moduleId: string) => {
      if (modeOf(moduleId) === MODE_LATCH) return
      gateOff(moduleId)
    },
    [modeOf, gateOff],
  )

  /**
   * Let go of anything latched that has no business still being open: a
   * Trigger taken out of the rack, or one whose Mode has been turned off
   * latch while it was on. Without this the gate would be held by a module
   * nobody can reach any more, and the only way out would be a reload.
   */
  useEffect(() => {
    if (latched.size === 0) return
    const stale = [...latched].filter(
      (id) => !patch.modules.some((m) => m.id === id) || modeOf(id) !== MODE_LATCH,
    )
    if (stale.length === 0) return
    for (const id of stale) gateOff(id)
    setLatched((prev) => {
      const next = new Set(prev)
      for (const id of stale) next.delete(id)
      return next
    })
  }, [latched, patch.modules, modeOf, gateOff])

  /**
   * The rack's playable keys, read off the patch.
   *
   * Grouped by key before they become bindings because the input layer holds
   * one binding per key: two Triggers on W have to arrive as a single binding
   * that opens both gates, or the second would quietly replace the first.
   */
  const triggerKeys = useMemo(() => {
    const byCode = new Map<string, string[]>()
    for (const m of patch.modules) {
      if (!defOf(m.type).keyed || !m.key) continue
      byCode.set(m.key, [...(byCode.get(m.key) ?? []), m.id])
    }
    return [...byCode].map(([code, ids]) => ({
      code,
      onDown: () => {
        for (const id of ids) press(id)
      },
      onUp: () => {
        for (const id of ids) release(id)
      },
    }))
  }, [patch.modules, press, release])

  return { latched, listening, setListening, gateOn, gateOff, press, release, triggerKeys }
}
