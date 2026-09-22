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
