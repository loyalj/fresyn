import { encodeLossy, type EncodeOptions, type Encoded, type LossyEncoder } from './encode'
import { encodeFlac, type FlacDepth } from './flac'
import { encodeWav } from './wav'
// Static, so the bundler can leave out the package's base64 copies of the
// binaries, which only its other entry points use. This whole file is
// fetched only when a bounce is asked for, inside the bounce worker.
import { createEncoder } from 'wasm-media-encoders'
// Only the binaries' URLs, which cost nothing until one is fetched. Static
// rather than `import()`ed: the worker is bundled as a single IIFE, which
// has nowhere to put a chunk split off by a dynamic import.
import mp3Url from 'wasm-media-encoders/wasm/mp3?url'
import oggUrl from 'wasm-media-encoders/wasm/ogg?url'

/**
 * Encoding in the browser: `encode.ts`'s formats, with the WebAssembly
 * encoders fetched as Vite assets. Kept apart from `encode.ts` because the
 * `?url` imports below mean nothing outside Vite.
 */
export async function encodeAudio(channels: Float32Array[], sampleRate: number, opts: EncodeOptions): Promise<Encoded> {
  switch (opts.format) {
    case 'wav':
      return { bytes: encodeWav(channels, sampleRate, opts.bitDepth), extension: 'wav', mime: 'audio/wav' }
    case 'flac': {
      const depth: FlacDepth = opts.bitDepth === 16 ? 16 : 24
      return { bytes: encodeFlac(channels, sampleRate, depth), extension: 'flac', mime: 'audio/flac' }
    }
    case 'ogg':
    case 'mp3': {
      const encoder = await loadEncoder(opts.format)
      return {
        bytes: encodeLossy(encoder, channels, sampleRate, opts.format, opts.quality),
        extension: opts.format,
        mime: opts.format === 'ogg' ? 'audio/ogg' : 'audio/mpeg',
      }
    }
  }
}

/**
 * An encoder, built from its WebAssembly on first use and kept. The binaries
 * are separate files Vite copies next to the page, fetched by URL, rather
 * than inlined as base64 into the script.
 */
const loading = new Map<'ogg' | 'mp3', Promise<LossyEncoder>>()
function loadEncoder(format: 'ogg' | 'mp3'): Promise<LossyEncoder> {
  let p = loading.get(format)
  if (!p) {
    p = (async () => {
      const wasm = format === 'ogg' ? oggUrl : mp3Url
      return (await createEncoder(format === 'ogg' ? 'audio/ogg' : 'audio/mpeg', wasm)) as LossyEncoder
    })()
    // A failed fetch is tried again next time rather than remembered.
    p.catch(() => loading.delete(format))
    loading.set(format, p)
  }
  return p
}
