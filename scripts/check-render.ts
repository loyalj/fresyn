/**
 * Checks for offline rendering, the WAV encoder and the zip writer.
 *
 * The point of the whole export path is that a render is reproducible, so
 * most of this is about seeds: the same seed must give the same samples, and
 * different takes must actually differ.
 *
 * Run with: npm run check:render
 */
import {
  DEFAULT_RENDER,
  renderPatch,
  renderVariation,
  variationSeed,
  variationValues,
} from '../src/audio/render'
import { encodeWav } from '../src/audio/wav'
import { makeZip } from '../src/audio/zip'
import { triggerPatch } from '../src/patch/defaultPatch'
import { defOf } from '../src/patch/defs'
import { initialValues } from '../src/patch/edit'
import type { Patch } from '../src/patch/types'

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const same = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** The stock rack with noise cabled into the mixer, so randomness is audible. */
function noisyPatch(): Patch {
  const p = triggerPatch()
  // The stock rack holds nothing random -- an oscillator, a filter, an LFO
  // and a mixer are all deterministic -- so a seed would have nothing to
  // change. Noise is the cheapest source that gives it something.
  p.modules.push({ id: 'noise1', type: 'noise', params: {} })
  p.cables.push({
    id: 'noise',
    from: { module: 'noise1', port: 'out' },
    to: { module: 'mix1', port: 'in3' },
  })
  return p
}

// --- reproducibility ---------------------------------------------------
console.log('\nreproducibility')
{
  const patch = noisyPatch()
  const values = initialValues(patch)

  const a = renderPatch(patch, values, { seed: 42 })
  const b = renderPatch(patch, values, { seed: 42 })
  const c = renderPatch(patch, values, { seed: 43 })

  check('a render makes sound', a.peak > 0.01, `peak=${a.peak.toFixed(4)}`)
  check('the same seed renders the same samples', same(a.left, b.left))
  check('a different seed renders different samples', !same(a.left, c.left))
  check('both channels are populated', b.right.length === b.left.length)
  check('nothing is out of range', a.peak <= 1.0001, `peak=${a.peak.toFixed(4)}`)
}

// --- shaping -----------------------------------------------------------
console.log('\nlength and tail')
{
  const patch = triggerPatch()
  const values = initialValues(patch)
  const out = renderPatch(patch, values, { duration: 4, gateSeconds: 0.05 })

  check('the silent tail is trimmed', out.seconds < 3, `${out.seconds.toFixed(3)}s of 4s`)
  check('something is left', out.seconds > 0.05, `${out.seconds.toFixed(3)}s`)
  check('the last sample is silent', out.left[out.left.length - 1] === 0)
  check(
    'the fade is short',
    Math.abs(out.left[out.left.length - 200]) >= 0,
    `fade ${DEFAULT_RENDER.fadeMs}ms`,
  )

  // A longer gate holds the envelope open, so the render runs longer.
  const held = renderPatch(patch, { ...values, 'env1.sustain': 0.8 }, {
    duration: 4,
    gateSeconds: 1.5,
  })
  check('a longer gate makes a longer render', held.seconds > out.seconds,
    `${held.seconds.toFixed(2)}s vs ${out.seconds.toFixed(2)}s`)

  const rate = renderPatch(patch, values, { sampleRate: 44100 })
  check('the sample rate is honoured', rate.sampleRate === 44100)
}

// --- variations --------------------------------------------------------
console.log('\nvariation batches')
{
  const patch = noisyPatch()
  const values = initialValues(patch)

  check('take seeds differ', variationSeed(7, 0) !== variationSeed(7, 1))
  check('take seeds are stable', variationSeed(7, 3) === variationSeed(7, 3))

  const takes = [0, 1, 2].map((i) => renderVariation(patch, values, { seed: 7 }, i, 0.1))
  check('every take renders', takes.every((t) => t.peak > 0.01))
  check('takes differ from each other', !same(takes[0].left, takes[1].left))
  check(
    'a take is reproducible',
    same(takes[1].left, renderVariation(patch, values, { seed: 7 }, 1, 0.1).left),
  )

  check('zero spread leaves knobs alone', variationValues(patch, values, 7, 0, 0) === values)

  const jittered = variationValues(patch, values, 7, 1, 0.1)
  check('spread moves knobs', jittered['lpf1.cutoff'] !== values['lpf1.cutoff'])
  check('switches are left alone', jittered['osc1.wave'] === values['osc1.wave'])

  // Jitter is applied in knob space, so nothing can leave its range.
  let outOfRange: string[] = []
  for (const m of patch.modules) {
    for (const spec of defOf(m.type).params) {
      const v = jittered[`${m.id}.${spec.id}`]
      if (v < spec.min - 1e-6 || v > spec.max + 1e-6) outOfRange.push(`${m.id}.${spec.id}=${v}`)
    }
  }
  check('jitter stays in range', outOfRange.length === 0, outOfRange.join(', '))

  // Even at full spread, on a patch with an exponential cutoff.
  const extreme = variationValues(patch, values, 7, 2, 0.5)
  const cutoff = extreme['lpf1.cutoff']
  check('an exponential knob stays in range', cutoff >= 20 && cutoff <= 18000, String(cutoff))
}

// --- wav ---------------------------------------------------------------
console.log('\nwav encoding')
{
  const frames = 1000
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    left[i] = Math.sin((i / frames) * Math.PI * 8) * 0.5
    right[i] = -left[i]
  }

  for (const depth of [16, 24] as const) {
    const wav = encodeWav([left, right], 48000, depth)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4))
    const bytesPerSample = depth / 8

    check(`${depth}-bit: RIFF/WAVE header`, tag(0) === 'RIFF' && tag(8) === 'WAVE')
    check(`${depth}-bit: fmt and data chunks`, tag(12) === 'fmt ' && tag(36) === 'data')
    check(`${depth}-bit: PCM, 2 channels`, view.getUint16(20, true) === 1 && view.getUint16(22, true) === 2)
    check(`${depth}-bit: sample rate`, view.getUint32(24, true) === 48000)
    check(`${depth}-bit: bit depth`, view.getUint16(34, true) === depth)
    check(
      `${depth}-bit: byte rate`,
      view.getUint32(28, true) === 48000 * 2 * bytesPerSample,
    )
    check(
      `${depth}-bit: data size matches`,
      view.getUint32(40, true) === frames * 2 * bytesPerSample,
    )
    check(`${depth}-bit: file length matches`, wav.length === 44 + frames * 2 * bytesPerSample)
    check(
      `${depth}-bit: RIFF size matches`,
      view.getUint32(4, true) === wav.length - 8,
    )

    // Decode the first channel back and compare within one quantisation step.
    const scale = depth === 16 ? 32767 : 8388607
    let worst = 0
    for (let i = 0; i < frames; i++) {
      const at = 44 + i * 2 * bytesPerSample
      const v =
        depth === 16
          ? view.getInt16(at, true)
          : (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16))
      worst = Math.max(worst, Math.abs(v / scale - left[i]))
    }
    check(`${depth}-bit: samples survive the round trip`, worst < 2 / scale, `worst=${worst.toExponential(2)}`)
  }

  // Clipping must read as clipping, not wrap to the opposite rail.
  const hot = encodeWav([new Float32Array([2, -2]), new Float32Array([2, -2])], 48000, 16)
  const hv = new DataView(hot.buffer, hot.byteOffset, hot.byteLength)
  check('overshoot clamps rather than wraps', hv.getInt16(44, true) === 32767 && hv.getInt16(48, true) === -32767)
}

// --- zip ---------------------------------------------------------------
console.log('\nzip writing')
{
  const files = [0, 1, 2].map((i) => ({
    name: `take_${i}.wav`,
    data: encodeWav([new Float32Array(200).fill(0.25 * (i + 1))], 48000, 16),
  }))
  const zip = makeZip(files)
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)

  check('starts with a local file header', view.getUint32(0, true) === 0x04034b50)

  // End of central directory is the last 22 bytes when there is no comment.
  const eocd = zip.length - 22
  check('ends with the central directory record', view.getUint32(eocd, true) === 0x06054b50)
  check('records every entry', view.getUint16(eocd + 10, true) === files.length)

  const cdOffset = view.getUint32(eocd + 16, true)
  check('the central directory is where it says', view.getUint32(cdOffset, true) === 0x02014b50)
  check(
    'the central directory size adds up',
    view.getUint32(eocd + 12, true) === zip.length - 22 - cdOffset,
  )

  // Walk the central directory and read each entry back out of the archive.
  let at = cdOffset
  let recovered = 0
  for (let i = 0; i < files.length; i++) {
    const nameLen = view.getUint16(at + 28, true)
    const localAt = view.getUint32(at + 42, true)
    const name = String.fromCharCode(...zip.subarray(at + 46, at + 46 + nameLen))
    const size = view.getUint32(at + 24, true)

    const localNameLen = view.getUint16(localAt + 26, true)
    const dataAt = localAt + 30 + localNameLen + view.getUint16(localAt + 28, true)
    const stored = zip.subarray(dataAt, dataAt + size)

    if (name === files[i].name && size === files[i].data.length && stored.every((b, k) => b === files[i].data[k])) {
      recovered++
    }
    at += 46 + nameLen
  }
  check('every entry reads back byte for byte', recovered === files.length, `${recovered}/${files.length}`)

  check('an empty archive is still valid', makeZip([]).length === 22)
}

console.log(failures === 0 ? '\nall clear' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
