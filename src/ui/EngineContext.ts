import { createContext, useContext } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'

/**
 * The running engine, for the few panels that need live audio data rather
 * than knob values. Threading it through the rack as a prop would mean
 * RackUnit and ModulePanel both carrying something neither of them uses.
 */
export const EngineContext = createContext<AudioEngine | null>(null)

export function useEngine() {
  return useContext(EngineContext)
}

/**
 * Where the rack on the bench sits in the running track: nothing for a
 * track's own rack, and a pad's `kit1/3/` while one is open. The engine
 * reports every module by its id in the track, so a panel in a pad looks
 * itself up by this and its own id together.
 */
export const EnginePrefix = createContext('')

/** A module on the bench, by the id the engine knows it by. */
export function useEngineId(moduleId: string) {
  return useContext(EnginePrefix) + moduleId
}
