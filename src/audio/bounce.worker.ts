import { bankFrom } from '../dsp/samples'
import { encodeAudio } from './encoders'
import { PROGRESS_MS, progress, serve } from './offlineServe'
import { renderSong, stemsOf } from './renderSong'
import { zipParts, type ZipEntry } from './zip'

/**
 * Bouncing the arrangement: the whole mix, or a file per track. See
 * `offline.ts` for the page's side and the protocol.
 *
 * A worker of its own, apart from the one that renders takes, because this
 * is the one that needs the encoders -- and under the dev server, the first
 * worker to import `wasm-media-encoders` makes Vite re-optimise its
 * dependencies and reload the page. Better that a first bounce does that
 * than every first batch of takes.
 */
serve(async (request) => {
  switch (request.kind) {
    case 'song': {
      const audio = await renderSong(request.song, request.racks, {
        sampleRate: request.sampleRate,
        samples: bankFrom(request.samples),
        progressMs: PROGRESS_MS,
        onProgress: (done) => progress({ stage: 'render', done }),
      })
      progress({ stage: 'encode', done: 1 })
      const file = await encodeAudio([audio.left, audio.right], audio.sampleRate, request.encode)
      return {
        blob: new Blob([file.bytes], { type: file.mime }),
        extension: file.extension,
        mime: file.mime,
        peak: audio.peak,
        seconds: audio.seconds,
      }
    }

    case 'stems': {
      // Each stem is encoded the moment it is rendered and its PCM let go,
      // so a bounce holds one track's audio at a time and not the whole set.
      const entries: ZipEntry[] = []
      for await (const stem of stemsOf(request.song, request.racks, {
        stemMix: request.stemMix,
        sampleRate: request.sampleRate,
        samples: bankFrom(request.samples),
        progressMs: PROGRESS_MS,
        onProgress: (done) => progress({ stage: 'render', done }),
      })) {
        progress({ stage: 'encode', done: (stem.index + 1) / stem.count, index: stem.index, count: stem.count })
        const file = await encodeAudio([stem.audio.left, stem.audio.right], stem.audio.sampleRate, request.encode)
        // Numbered, so they sort into the order the tracks are in rather than
        // alphabetically -- which is the order anybody will want to line them up.
        const name = request.names[stem.track] ?? 'track'
        entries.push({ name: `${String(stem.index + 1).padStart(2, '0')} ${name}.${file.extension}`, data: file.bytes })
      }
      return {
        zip: entries.length ? new Blob(zipParts(entries), { type: 'application/zip' }) : null,
        count: entries.length,
      }
    }

    default:
      throw new Error(`the bounce worker does not run ${request.kind}`)
  }
})
