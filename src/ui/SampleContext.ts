import { createContext, useContext } from 'react'
import type { SampleLibrary } from '../audio/SampleLibrary'

/**
 * The rack's audio, for the one panel that plays some.
 *
 * A context rather than a prop for the same reason the engine is one: every
 * panel between the rack and the Sampler would otherwise carry something none
 * of them uses.
 */
export const SampleContext = createContext<SampleLibrary | null>(null)

export function useSamples() {
  return useContext(SampleContext)
}
