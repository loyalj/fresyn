import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { loadPrefs, savePrefs, type HarmonyPrefs } from '../../patch/storage'
import { hasScale } from '../../song/scale'
import type { Song } from '../../song/types'
import { PROGRESSIONS } from '../../utilities/harmony'

/**
 * The key, the chords and the progression that Scales & chords and
 * Progressions share. One store rather than one each, so a key picked in the
 * explorer is the key the sketcher writes in, and a chord added from the
 * explorer turns up in the progression at once -- with both panels open side
 * by side, or with one opened later. Remembered with the page's other
 * preferences.
 */
const DEFAULTS: HarmonyPrefs = {
  root: 0,
  mode: 'major',
  sevenths: false,
  octave: 3,
  degrees: [...PROGRESSIONS[0].degrees],
  voicing: 'smooth',
  rhythm: 'held',
  bars: 1,
  replace: true,
  fill: true,
}

/** The longest progression a sketch holds: three twelve-bar blues. */
export const MAX_CHORDS = 36

let state: HarmonyPrefs | null = null
const listeners = new Set<() => void>()

function current(): HarmonyPrefs {
  state ??= { ...DEFAULTS, ...loadPrefs().harmony }
  return state
}

function update(change: Partial<HarmonyPrefs>) {
  state = { ...current(), ...change }
  if (state.degrees.length > MAX_CHORDS) state = { ...state, degrees: state.degrees.slice(0, MAX_CHORDS) }
  savePrefs({ harmony: state })
  for (const fn of listeners) fn()
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * The shared state and a way to change it. The first time either panel is
 * ever opened, it starts in the song's key, where the song has one.
 */
export function useHarmony(song: Song) {
  const value = useSyncExternalStore(subscribe, current)
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    if (!loadPrefs().harmony && hasScale(song.scale)) update({ root: song.scale.root, mode: song.scale.mode })
    // Only on the first visit: after that the panels keep their own key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const set = useCallback((change: Partial<HarmonyPrefs>) => update(change), [])
  return [value, set] as const
}
