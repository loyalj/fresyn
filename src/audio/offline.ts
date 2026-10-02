import type { SampleBank, SampleRecord } from '../dsp/samples'
import type { Patch } from '../patch/types'
import type { Rack } from '../song/project'
import type { Song } from '../song/types'
import type { EncodeOptions } from './encode'
import type { Normalize } from './normalize'
import type { StemMix } from './renderSong'
import type { WavDepth } from './wav'
import { canShare } from './shared'

/**
 * Offline audio, off the page's thread.
 *
 * Bouncing a song, bouncing its stems, rendering a batch of takes and writing
 * any of them out as a file are all long runs of synchronous arithmetic. On
 * the page's own thread they froze the UI for as long as they took -- the
 * bounce handed the page back every half second of *audio*, which at a little
 * under realtime was a frozen half second at a time -- and they yielded with
 * `requestAnimationFrame`, which a hidden tab never fires, so a bounce left
 * running behind another tab simply stopped.
 *
 * So they run in workers, and this is the page's side of them: song and stem
 * bounces in `bounce.worker.ts`, takes and their WAVs in `takes.worker.ts`.
 * The renderers and encoders themselves are unchanged and still plain
 * modules -- the Node checks call them directly -- and the workers only wrap
 * them.
 *
 * The protocol is one job per worker at a time. A job is one message in; out
 * come any number of `progress` (and, for takes, `take`) messages, then one
 * `done` or `error`. Nothing needs an id, because a worker is only ever
 * running the one job it was handed. Workers are kept in a small pool: a
 * bounce and a batch of takes can run side by side, each in its own, and a
 * worker that has finished is kept for the next job of its kind, which then
 * skips fetching the DSP and building the encoders again.
 *
 * Everything that crosses is plain data. The song and the racks are JSON
 * already; samples go through `wireSamples`; audio comes back either as a
 * `Blob` ready to download, or -- for takes, which are auditioned before
 * they are written -- as Float32Arrays handed over rather than copied.
 */

// --- the protocol ------------------------------------------------------

/** What a take render needs of the export panel's settings. */
export interface TakeSettings {
  count: number
  sampleRate: number
  duration: number
  gateSeconds: number
  seed: number
  spread: number
  normalize: Normalize
}

/** A WAV to write: the takes being downloaded. */
export interface WavFile {
  name: string
  left: Float32Array
  right: Float32Array
  sampleRate: number
  bitDepth: WavDepth
}

export type OfflineRequest =
  | {
      kind: 'song'
      song: Song
      racks: Record<string, Rack>
      samples: SampleRecord[]
      sampleRate: number
      encode: EncodeOptions
    }
  | {
      kind: 'stems'
      song: Song
      racks: Record<string, Rack>
      samples: SampleRecord[]
      sampleRate: number
      stemMix: StemMix
      encode: EncodeOptions
      /** Each track's file name, by id, before its number and extension go on. */
      names: Record<string, string>
    }
  | {
      kind: 'takes'
      patch: Patch
      values: Record<string, number>
      samples: SampleRecord[]
      settings: TakeSettings
    }
  | {
      kind: 'wavs'
      files: WavFile[]
      /** Stored in one zip rather than written as the one WAV. */
      zip: boolean
    }

/**
 * How far a job has got. `render` is 0..1 of the whole job; `encode` says a
 * file is being written, which for stems is the `index`th of `count`.
 */
export interface OfflineProgress {
  stage: 'render' | 'encode'
  done: number
  index?: number
  count?: number
}

/** A take as it comes back: levelled, measured, and ready to draw and play. */
export interface RenderedTake {
  index: number
  seed: number
  seconds: number
  peak: number
  sampleRate: number
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
  envelope: Float32Array<ArrayBuffer>
  /** Held short of its loudness target to keep it under -1 dB. */
  limited: boolean
}

/** A written file, as a Blob: made in the worker, handed to a download as it is. */
export interface OfflineFile {
  blob: Blob
  extension: string
  mime: string
}

export interface SongDone extends OfflineFile {
  peak: number
  seconds: number
}

/** The stems in a zip, or no zip at all when every track was muted. */
export interface StemsDone {
  zip: Blob | null
  count: number
}

export interface OfflineResults {
  song: SongDone
  stems: StemsDone
  takes: { count: number }
  wavs: { blob: Blob }
}

export type OfflineReply =
  | { type: 'progress'; progress: OfflineProgress }
  | { type: 'take'; take: RenderedTake }
  | { type: 'done'; result: OfflineResults[keyof OfflineResults] }
  | { type: 'error'; message: string }

// --- samples -----------------------------------------------------------

/**
 * The sample bank, as it goes to a worker.
 *
 * Where the page can share memory the bank already lives in it (see
 * `SampleLibrary`), and the records go as they are: the worker reads the
 * page's own audio, and nothing is copied or transferred. Otherwise each
 * channel is copied and the copy handed over, so the page's own bank -- which
 * the live rack is still playing from -- is never detached, and the message
 * itself carries nothing to serialise.
 */
function wireSamples(bank: SampleBank): { records: SampleRecord[]; transfer: ArrayBuffer[] } {
  const records: SampleRecord[] = []
  const transfer: ArrayBuffer[] = []
  for (const [id, s] of bank) {
    const channels = s.channels.map((c) => {
      if (canShare && c.buffer instanceof SharedArrayBuffer) return c
      const copy = new Float32Array(c)
      transfer.push(copy.buffer)
      return copy
    })
    records.push({ id, channels, rate: s.rate, frames: s.frames })
  }
  return { records, transfer }
}

// --- the pool ----------------------------------------------------------

type WorkerKind = 'bounce' | 'takes'

const KIND: Record<OfflineRequest['kind'], WorkerKind> = {
  song: 'bounce',
  stems: 'bounce',
  takes: 'takes',
  wavs: 'takes',
}

// Each spelled out in full: `new Worker(new URL(<literal>, import.meta.url))`
// is the shape the bundler looks for to build a worker's script at all.
const SPAWN: Record<WorkerKind, () => Worker> = {
  bounce: () => new Worker(new URL('./bounce.worker.ts', import.meta.url), { type: 'module' }),
  takes: () => new Worker(new URL('./takes.worker.ts', import.meta.url), { type: 'module' }),
}

/**
 * Workers with nothing to do, kept for the next job of their kind. One of
 * each is enough: two jobs of a kind at once is rare (and the second simply
 * gets a worker of its own), and a second idle one would only be holding a
 * copy of the DSP for nobody.
 */
const idle: Record<WorkerKind, Worker | null> = { bounce: null, takes: null }

function acquire(kind: WorkerKind): Worker {
  const kept = idle[kind]
  idle[kind] = null
  return kept ?? SPAWN[kind]()
}

function release(kind: WorkerKind, worker: Worker) {
  if (!idle[kind]) idle[kind] = worker
  else worker.terminate()
}

/**
 * Hand a job to a worker and wait for it.
 *
 * A worker that errors outright -- its script failed to load, or it ran out
 * of memory -- is thrown away rather than pooled: whatever state it is in is
 * not one to start the next job from. A job that fails in the ordinary way
 * says so with an `error` reply and leaves its worker fit to reuse.
 */
function run<K extends OfflineRequest['kind']>(
  request: Extract<OfflineRequest, { kind: K }>,
  transfer: Transferable[],
  on: {
    progress?: (p: OfflineProgress) => void
    take?: (t: RenderedTake) => void
  } = {},
): Promise<OfflineResults[K]> {
  const kind = KIND[request.kind]
  const worker = acquire(kind)
  return new Promise<OfflineResults[K]>((resolve, reject) => {
    const settle = (reuse: boolean) => {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      if (reuse) release(kind, worker)
      else worker.terminate()
    }
    worker.onmessage = (e: MessageEvent<OfflineReply>) => {
      const reply = e.data
      switch (reply.type) {
        case 'progress':
          on.progress?.(reply.progress)
          break
        case 'take':
          on.take?.(reply.take)
          break
        case 'done':
          settle(true)
          resolve(reply.result as OfflineResults[K])
          break
        case 'error':
          settle(true)
          reject(new Error(reply.message))
          break
      }
    }
    worker.onerror = (e) => {
      e.preventDefault()
      settle(false)
      reject(new Error(e.message || 'the offline renderer failed to start'))
    }
    worker.onmessageerror = () => {
      settle(false)
      reject(new Error('the offline renderer sent something unreadable'))
    }
    worker.postMessage(request, transfer)
  })
}

// --- jobs --------------------------------------------------------------

interface SongJob {
  song: Song
  racks: Record<string, Rack>
  samples: SampleBank
  sampleRate: number
  encode: EncodeOptions
}

/** The whole mix, rendered and encoded. */
export function bounceSong(job: SongJob, onProgress?: (p: OfflineProgress) => void): Promise<SongDone> {
  const { records, transfer } = wireSamples(job.samples)
  return run(
    { kind: 'song', song: job.song, racks: job.racks, samples: records, sampleRate: job.sampleRate, encode: job.encode },
    transfer,
    { progress: onProgress },
  )
}

/** A file per audible track, each encoded as soon as it is rendered, in one zip. */
export function bounceStems(
  job: SongJob & { stemMix: StemMix; names: Record<string, string> },
  onProgress?: (p: OfflineProgress) => void,
): Promise<StemsDone> {
  const { records, transfer } = wireSamples(job.samples)
  return run(
    {
      kind: 'stems',
      song: job.song,
      racks: job.racks,
      samples: records,
      sampleRate: job.sampleRate,
      stemMix: job.stemMix,
      encode: job.encode,
      names: job.names,
    },
    transfer,
    { progress: onProgress },
  )
}

/**
 * A batch of takes of one patch. Each arrives through `onTake` as soon as it
 * is done, its audio handed over rather than copied.
 */
export function renderTakes(
  job: { patch: Patch; values: Record<string, number>; samples: SampleBank; settings: TakeSettings },
  onTake: (take: RenderedTake) => void,
): Promise<{ count: number }> {
  const { records, transfer } = wireSamples(job.samples)
  return run(
    { kind: 'takes', patch: job.patch, values: job.values, samples: records, settings: job.settings },
    transfer,
    { take: onTake },
  )
}

/**
 * Takes written as WAVs: the one file, or a zip of several. The audio is
 * copied across rather than handed over, since the takes stay in the list to
 * be auditioned and downloaded again.
 */
export function writeWavs(files: WavFile[], zip: boolean): Promise<{ blob: Blob }> {
  return run({ kind: 'wavs', files, zip }, [])
}
