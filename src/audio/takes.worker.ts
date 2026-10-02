import { bankFrom } from '../dsp/samples'
import { normalize } from './normalize'
import type { RenderedTake } from './offline'
import { reply, serve } from './offlineServe'
import { renderVariation } from './render'
import { peakEnvelope } from './waveform'
import { encodeWav } from './wav'
import { zipParts } from './zip'

/**
 * The recorder's renders: a batch of takes of the patch on the bench, and
 * the WAVs they are saved as. See `offline.ts` for the page's side and the
 * protocol, and `bounce.worker.ts` for why this is a worker of its own.
 */

/** Columns in a take's drawn waveform. */
const WAVE_COLUMNS = 200

serve(async (request) => {
  switch (request.kind) {
    case 'takes': {
      const { settings } = request
      const samples = bankFrom(request.samples)
      for (let i = 0; i < settings.count; i++) {
        const take = renderVariation(
          request.patch,
          request.values,
          {
            sampleRate: settings.sampleRate,
            duration: settings.duration,
            gateSeconds: settings.gateSeconds,
            seed: settings.seed,
            // A take has to contain whatever a Sampler is playing, so the
            // offline pass gets the same audio the live rack has.
            samples,
          },
          i,
          settings.spread,
        )
        // Levelled here, before anything is drawn or heard, so the take
        // you audition is the take that gets saved.
        const level = normalize(take.left, take.right, take.sampleRate, settings.normalize)
        const out: RenderedTake = {
          index: i,
          seed: take.seed,
          seconds: take.seconds,
          peak: level.peak,
          sampleRate: take.sampleRate,
          left: level.left,
          right: level.right,
          envelope: peakEnvelope(level.left, level.right, WAVE_COLUMNS) as Float32Array<ArrayBuffer>,
          limited: level.limited,
        }
        // Sent as each is done, its audio handed over rather than copied.
        reply({ type: 'take', take: out }, [out.left.buffer, out.right.buffer, out.envelope.buffer])
      }
      return { count: settings.count }
    }

    case 'wavs': {
      const written = request.files.map((f) => ({
        name: f.name,
        data: encodeWav([f.left, f.right], f.sampleRate, f.bitDepth),
      }))
      if (!request.zip && written.length === 1) {
        return { blob: new Blob([written[0].data], { type: 'audio/wav' }) }
      }
      return { blob: new Blob(zipParts(written), { type: 'application/zip' }) }
    }

    default:
      throw new Error(`the takes worker does not run ${request.kind}`)
  }
})
