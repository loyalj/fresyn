import type { Routing } from '../dsp/Console'
import type { SampleBank } from '../dsp/samples'
import { trackMix } from '../song/edit'
import type { Rack } from '../song/project'
import { SongPlayer } from '../song/runtime'
import { songEnd } from '../song/schedule'
import { tempoMap } from '../song/timeline'
import type { Song } from '../song/types'
import { trimTail } from './render'

const BLOCK = 128

/**
 * Bouncing a song to samples, faster than realtime.
 *
 * It runs `SongPlayer`, which is what a game would run, which in turn runs
 * the same `fill` the live transport does. That chain is the whole point: a
 * bounced file is not a second implementation of the song, it is the song,
 * and the only difference from playing it is that nothing waits for a
 * speaker.
 */

export interface SongRenderOptions {
  sampleRate: number
  /** Audio for any Sampler in any rack. Without it they render silent. */
  samples?: SampleBank
  seed?: number
  /**
   * Seconds to keep rendering after the last note.
   *
   * A piece does not end where its arrangement does: the final chord is still
   * releasing and the reverb is still going. Whatever is left after this is
   * trimmed, so the only cost of being generous is a moment of arithmetic.
   */
  tailSeconds?: number
  fadeMs?: number
  silenceDb?: number
  /** Only these tracks, on top of the song's own mute and solo. */
  only?: readonly string[]
  /** How much of the desk to go through; all of it unless a stem says otherwise. */
  routing?: Routing
  /**
   * Called with 0..1 as it goes, and awaited.
   *
   * A bounce is synchronous arithmetic and holds its thread while it runs.
   * In the app that thread is the bounce worker's, which has nothing else to
   * do, so this only posts; a caller running it anywhere with a page to keep
   * alive would hand the thread back here, with a macrotask rather than an
   * animation frame -- a hidden tab never fires one, and the bounce would stop.
   */
  onProgress?: (done: number) => void | Promise<void>
  /**
   * How often `onProgress` is called, in milliseconds of wall-clock time.
   *
   * Time rather than audio: a slice measured in audio is a different length
   * of frozen page on every machine and for every song, and a heavy song at
   * a little under realtime turned half a second of it into half a second of
   * nothing responding.
   */
  progressMs?: number
}

export interface SongRenderResult {
  // Pinned to ArrayBuffer so these can be handed straight to an AudioBuffer
  // or a Blob; a SharedArrayBuffer-backed view is accepted by neither.
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
  sampleRate: number
  peak: number
  seconds: number
}

const DEFAULTS = {
  seed: 1,
  tailSeconds: 4,
  fadeMs: 8,
  silenceDb: -72,
  // Inside a frame at 60 Hz, with room left over for the frame itself.
  progressMs: 10,
}

export async function renderSong(
  song: Song,
  racks: Readonly<Record<string, Rack>>,
  options: SongRenderOptions,
): Promise<SongRenderResult> {
  const opts = { ...DEFAULTS, ...options }
  const sr = opts.sampleRate

  const end = songEnd(song)
  const arrangement = end > 0 ? Math.round(tempoMap(song, sr).frameAt(end)) : 0
  const total = arrangement > 0 ? arrangement + Math.ceil(opts.tailSeconds * sr) : BLOCK

  const player = new SongPlayer(song, racks, {
    sampleRate: sr,
    samples: opts.samples,
    seed: opts.seed,
    // Never: a bounce plays the arrangement once, whatever the transport was
    // set to while it was being written.
    loop: null,
    only: opts.only,
    routing: opts.routing,
    // Nothing is muted or unmuted part way through a bounce, so a track that
    // is not heard need not run at all -- which for a stem is every track
    // but one.
    onlyHeard: true,
  })

  // The limiter looks ahead, so everything comes out this many samples late.
  // Rendered that much longer and cut off the front again, or a loop would
  // start with a sliver of silence and end with its first moment in the
  // tail -- a click at every seam of a file whose one job is to tile.
  const latency = player.latency
  const rendered = total + latency
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  const bl = new Float32Array(BLOCK)
  const br = new Float32Array(BLOCK)
  let lastProgress = performance.now()

  for (let i = 0; i < rendered; i += BLOCK) {
    player.render(bl, br)
    // Where this block lands once the latency is taken off, and which part
    // of it survives: a block straddling the cut keeps only its later end.
    const from = Math.max(0, latency - i)
    const to = Math.min(BLOCK, rendered - i)
    if (to > from) {
      left.set(bl.subarray(from, to), i + from - latency)
      right.set(br.subarray(from, to), i + from - latency)
    }

    if (opts.onProgress && performance.now() - lastProgress >= opts.progressMs) {
      await opts.onProgress(i / rendered)
      // From when it came back, so time spent away is not charged to the render.
      lastProgress = performance.now()
    }
  }

  const trimmed = trimTail(left, right, {
    sampleRate: sr,
    fadeMs: opts.fadeMs,
    silenceDb: opts.silenceDb,
    // The arrangement is kept whole whatever is in it, so the file tiles.
    minFrames: arrangement,
  })
  await opts.onProgress?.(1)
  return { ...trimmed, sampleRate: sr }
}

export interface Stem {
  track: string
  name: string
  audio: SongRenderResult
}

/**
 * What a stem carries of its track's channel.
 *
 * - `raw`: the rack's own output, nothing of the desk.
 * - `channel`: through its strip -- EQ, pan and fader -- as it sits in the mix.
 * - `sends`: that, and its own share of the shared reverb and echo.
 *
 * Never the master bus. The limiter works on the whole mix, and a stem run
 * through it on its own would be squeezed by a limiter that, in the mix,
 * never touched it -- so stems that no longer add back up to the song.
 */
export type StemMix = 'raw' | 'channel' | 'sends'

export const STEM_ROUTING: Record<StemMix, Routing> = {
  raw: { strips: false, sends: false, master: false },
  channel: { strips: true, sends: false, master: false },
  sends: { strips: true, sends: true, master: false },
}

export type StemOptions = SongRenderOptions & { stemMix?: StemMix }

/**
 * One rendering per track, so a mix can be rebuilt or re-balanced elsewhere.
 *
 * A track that is not reaching the speakers gets no file rather than a file
 * of silence: mute and solo are decisions about the piece, and a set of stems
 * that quietly ignored them would not add back up to the mix they came from.
 *
 * Handed out one at a time, as each is finished, so a caller writing them to
 * files can encode each and let its audio go before the next is rendered: a
 * set of stems is the song's length once per track, and there is no need to
 * hold all of it at once. Each stem runs only its own rack (see `onlyHeard`),
 * so the set costs about what the mix does rather than the mix once per track.
 */
export async function* stemsOf(
  song: Song,
  racks: Readonly<Record<string, Rack>>,
  options: StemOptions,
): AsyncGenerator<Stem & { index: number; count: number }> {
  const mix = trackMix(song)
  const wanted = song.tracks.filter((t) => mix[t.id]?.audible)

  for (let i = 0; i < wanted.length; i++) {
    const track = wanted[i]
    const audio = await renderSong(song, racks, {
      ...options,
      only: [track.id],
      routing: STEM_ROUTING[options.stemMix ?? 'channel'],
      // Reported across the whole set rather than per track, so the bar goes
      // one way once instead of resetting for every stem.
      onProgress: options.onProgress
        ? (done) => options.onProgress!((i + done) / wanted.length)
        : undefined,
    })
    yield { track: track.id, name: track.name, audio, index: i, count: wanted.length }
  }
}

/** Every stem at once, for a caller that wants them all in hand. */
export async function renderStems(
  song: Song,
  racks: Readonly<Record<string, Rack>>,
  options: StemOptions,
): Promise<Stem[]> {
  const stems: Stem[] = []
  for await (const { track, name, audio } of stemsOf(song, racks, options)) stems.push({ track, name, audio })
  return stems
}
