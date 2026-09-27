import type { SampleBank, SampleData, SampleRecord } from '../dsp/samples'
import { getSample, idFor, putSample, type StoredSample } from './sampleStore'

/**
 * The rate every dropped file is decoded to.
 *
 * Fixed rather than taken from the audio context on purpose. A context runs
 * at whatever the device's hardware wants -- 44.1 kHz on plenty of machines
 * -- while every offline render is at 48, so decoding "at the context rate"
 * would mean a sample that played correctly live and 8.8% fast in the take.
 * Decoding to one known rate and letting the module divide by whatever engine
 * it finds itself in is the only version of this that is right in both.
 */
const DECODE_RATE = 48000

export interface LoadedSample {
  id: string
  name: string
  /** Frames, at `DECODE_RATE`, for the panel to draw and report. */
  data: SampleData
}

let decoder: OfflineAudioContext | null = null

function decodeContext(): OfflineAudioContext {
  // One frame long: nothing is rendered through it, it exists only to give
  // decodeAudioData a rate to resample to.
  if (!decoder) decoder = new OfflineAudioContext(1, 1, DECODE_RATE)
  return decoder
}

async function decode(bytes: ArrayBuffer): Promise<SampleData> {
  // A copy, because decodeAudioData detaches the buffer it is given and the
  // original is what goes into storage and into a bundle.
  const buffer = await decodeContext().decodeAudioData(bytes.slice(0))
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels && c < 2; c++) {
    channels.push(buffer.getChannelData(c))
  }
  return { channels, rate: buffer.sampleRate, frames: buffer.length }
}

/**
 * Every sample this rack can reach, on the main thread.
 *
 * One of these holds the decoded audio for the panels to draw and for an
 * offline render to play, and hands the same audio to the worklet. The bytes
 * behind it live in IndexedDB; this is the working copy.
 */
export class SampleLibrary {
  private loaded = new Map<string, LoadedSample>()
  /** Ids a patch asked for that are not here, so a panel can say which. */
  private absent = new Set<string>()
  private listeners = new Set<() => void>()

  /** Told when audio arrives or goes missing, so panels redraw. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private changed() {
    for (const fn of this.listeners) fn()
  }

  get(id: string | undefined): LoadedSample | null {
    return id ? (this.loaded.get(id) ?? null) : null
  }

  /** True once we have looked for this one and not found it. */
  isMissing(id: string | undefined): boolean {
    return !!id && this.absent.has(id)
  }

  bank(): SampleBank {
    const bank: SampleBank = new Map()
    for (const [id, s] of this.loaded) bank.set(id, s.data)
    return bank
  }

  /** The wire form, for the worklet's options and its messages. */
  records(): SampleRecord[] {
    return [...this.loaded.entries()].map(([id, s]) => ({ id, ...s.data }))
  }

  /**
   * Take a file the user dropped: store the bytes, decode them, keep both.
   *
   * The id is the content hash, so dropping the same file onto a second
   * Sampler costs nothing and two modules share one copy.
   */
  async add(file: File): Promise<LoadedSample> {
    const bytes = await file.arrayBuffer()
    const id = idFor(bytes)
    const already = this.loaded.get(id)
    if (already) return already

    const data = await decode(bytes)
    const stored: StoredSample = { id, name: file.name, type: file.type || 'audio/wav', bytes }
    // Stored before it is announced: a reload a second later should find it.
    await putSample(stored)
    return this.keep(stored, data)
  }

  /** Put audio that arrived from somewhere else -- a bundle -- into the library. */
  async addStored(stored: StoredSample): Promise<LoadedSample | null> {
    if (this.loaded.has(stored.id)) return this.loaded.get(stored.id)!
    try {
      const data = await decode(stored.bytes)
      await putSample(stored)
      return this.keep(stored, data)
    } catch {
      return null
    }
  }

  private keep(stored: StoredSample, data: SampleData): LoadedSample {
    const entry = { id: stored.id, name: stored.name, data }
    this.loaded.set(stored.id, entry)
    this.absent.delete(stored.id)
    this.changed()
    return entry
  }

  /**
   * Fetch what a patch asks for out of storage, on open.
   *
   * Anything not found is remembered as absent rather than retried: a patch
   * from somebody else names files this browser has never had, and the panel
   * needs to say so once rather than look every time it draws.
   */
  async hydrate(ids: readonly string[]): Promise<void> {
    let moved = false
    for (const id of new Set(ids)) {
      if (this.loaded.has(id) || this.absent.has(id)) continue
      const stored = await getSample(id)
      if (!stored) {
        this.absent.add(id)
        moved = true
        continue
      }
      try {
        this.loaded.set(id, { id, name: stored.name, data: await decode(stored.bytes) })
      } catch {
        this.absent.add(id)
      }
      moved = true
    }
    if (moved) this.changed()
  }
}
