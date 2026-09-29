import type { WavDepth } from './wav'

/**
 * Audio out, in whichever format it is wanted in.
 *
 * WAV and FLAC are written here, synchronously. OGG Vorbis and MP3 are the
 * reference encoders -- libvorbis and LAME -- compiled to WebAssembly by the
 * `wasm-media-encoders` package, and fetched only the first time one is
 * asked for: most sessions never write either, and they are a few hundred
 * kilobytes. The fetching is in `encoders.ts`, which only the browser build
 * can read; everything here runs under Node's checks too.
 */
export type AudioFormat = 'wav' | 'flac' | 'ogg' | 'mp3'

export interface EncodeOptions {
  format: AudioFormat
  /** WAV: 16, 24 or 32 (float). FLAC: 16 or 24. */
  bitDepth: WavDepth
  /**
   * How good a lossy file is, 0..10, higher better. Mapped onto each
   * encoder's own scale: Vorbis quality 0..10, LAME's VBR V9..V0.
   */
  quality: number
}

export interface Encoded {
  bytes: Uint8Array<ArrayBuffer>
  extension: string
  mime: string
}

export const FORMATS: { id: AudioFormat; name: string; lossy: boolean }[] = [
  { id: 'wav', name: 'WAV', lossy: false },
  { id: 'flac', name: 'FLAC', lossy: false },
  { id: 'ogg', name: 'OGG Vorbis', lossy: true },
  { id: 'mp3', name: 'MP3', lossy: true },
]

/** The rates LAME writes an MP3 at without resampling it. */
export const MP3_RATES = [32000, 44100, 48000]

/** Whether this format can be written at this rate as it stands. */
export function formatTakesRate(format: AudioFormat, sampleRate: number): boolean {
  return format !== 'mp3' || MP3_RATES.includes(sampleRate)
}

/** Only what is used of an encoder from `wasm-media-encoders`. */
export interface LossyEncoder {
  configure(options: { channels: number; sampleRate: number; vbrQuality?: number }): void
  encode(samples: Float32Array[]): Uint8Array
  finalize(): Uint8Array
}

/** Frames handed to the encoder at a time, so its buffers stay small. */
const CHUNK = 1 << 16

/**
 * PCM through a loaded encoder. Separate from the loading, so a check can
 * run it under Node with the encoder built there.
 */
export function encodeLossy(
  encoder: LossyEncoder,
  channels: Float32Array[],
  sampleRate: number,
  format: 'ogg' | 'mp3',
  quality: number,
): Uint8Array<ArrayBuffer> {
  const q = Math.max(0, Math.min(10, quality))
  encoder.configure({
    channels: channels.length,
    sampleRate,
    // Vorbis counts up to 10; LAME counts down from 9.999 to 0 (V0, the best).
    vbrQuality: format === 'ogg' ? q : Math.min(9.999, 10 - q),
  })
  const parts: Uint8Array[] = []
  let total = 0
  // The encoder owns what it hands back, until its next call: copied at once.
  const keep = (chunk: Uint8Array) => {
    if (!chunk.length) return
    parts.push(chunk.slice())
    total += chunk.length
  }
  const frames = channels[0]?.length ?? 0
  for (let at = 0; at < frames; at += CHUNK) {
    // Held inside full scale: past it, both encoders wrap rather than clip.
    keep(encoder.encode(channels.map((c) => clampCopy(c.subarray(at, Math.min(frames, at + CHUNK))))))
  }
  keep(encoder.finalize())
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function clampCopy(c: Float32Array): Float32Array {
  const out = new Float32Array(c.length)
  for (let i = 0; i < c.length; i++) out[i] = c[i] > 1 ? 1 : c[i] < -1 ? -1 : c[i]
  return out
}
