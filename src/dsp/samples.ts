/**
 * Audio a patch plays but does not contain.
 *
 * A sample is the one thing in this rack that is neither a number nor a
 * cable: megabytes of it, arriving from a file the user dropped, needed
 * identically by the audio thread, by an offline render and by the panel that
 * draws it. So it travels beside the patch rather than inside it -- the patch
 * keeps a name and a hash, and the bank keeps the audio.
 *
 * Everything here is structured-cloneable, so the same shape goes into the
 * worklet's construction options, into a message when a file lands while the
 * rack is playing, and into an offline render on the main thread.
 */
export interface SampleData {
  /**
   * One array per channel, at `rate`. Mono files have one; a module reading a
   * second channel that is not there reads the first again.
   */
  channels: Float32Array[]
  /**
   * The rate the file was recorded at, not the rate the rack runs at.
   *
   * Kept apart on purpose. A dropped file is usually 44.1 kHz, a browser's
   * audio context is usually 48, and an offline render is always 48 -- so a
   * sample stored at "the" rate plays 8.8% fast on somebody's machine and
   * nobody can work out why. The module divides the two.
   */
  rate: number
  /** Frames per channel, which is what a read position is measured in. */
  frames: number
}

/** Every sample a patch can reach, by content hash. */
export type SampleBank = Map<string, SampleData>

/** An empty bank, for a rack that has not been given any audio. */
export function emptyBank(): SampleBank {
  return new Map()
}

/**
 * The wire form: what crosses into the worklet, and what a message carries.
 *
 * A plain array rather than a Map because the shape has to survive a
 * structured clone into `processorOptions`, which a Map does -- but an array
 * of records is what the sender already has and what the receiver rebuilds a
 * Map from in one line.
 */
export interface SampleRecord extends SampleData {
  id: string
}

export function bankFrom(records: readonly SampleRecord[] | undefined): SampleBank {
  const bank = emptyBank()
  for (const r of records ?? []) {
    bank.set(r.id, { channels: r.channels, rate: r.rate, frames: r.frames })
  }
  return bank
}
