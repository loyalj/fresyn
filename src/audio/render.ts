import type { SampleBank } from '../dsp/samples'
import { GraphEngine } from '../dsp/GraphEngine'
import { streamFor, streamSeed } from '../dsp/Rng'
import { compile } from '../patch/compile'
import { defOf } from '../patch/defs'
import { denormalize, normalize } from '../patch/param'
import type { Patch } from '../patch/types'

const BLOCK = 128

export interface RenderOptions {
  /** Audio for any Sampler in the patch. Without it they render silent. */
  samples: SampleBank | undefined
  sampleRate: number
  /** Longest the render may run, in seconds. */
  duration: number
  /** How long the gate is held before release. */
  gateSeconds: number
  seed: number
  /** Fade applied to the tail, to stop the trim from clicking. */
  fadeMs: number
  /** Trim anything quieter than this off the end. */
  silenceDb: number
}

export interface RenderResult {
  // Pinned to ArrayBuffer so these can be handed straight to an AudioBuffer
  // or a Blob; a SharedArrayBuffer-backed view is accepted by neither.
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
  sampleRate: number
  seed: number
  peak: number
  /** Length after trimming, in seconds. */
  seconds: number
}

export const DEFAULT_RENDER: RenderOptions = {
  // Undefined rather than an empty bank: a render that was given no audio and
  // a render whose audio is missing are the same thing to a Sampler, and both
  // of them are silence rather than a failure.
  samples: undefined,
  sampleRate: 48000,
  duration: 2,
  gateSeconds: 0.1,
  seed: 1,
  fadeMs: 4,
  silenceDb: -72,
}

/**
 * Render a patch offline, faster than realtime and with no audio device
 * involved.
 *
 * This runs the same `GraphEngine` the worklet does rather than going through
 * an `OfflineAudioContext`: the result is then identical to what the rack
 * plays, and it does not depend on message timing, which an offline context
 * gets wrong -- a message posted before `startRendering` is never delivered.
 */
export function renderPatch(
  patch: Patch,
  values: Record<string, number>,
  options: Partial<RenderOptions> = {},
): RenderResult {
  const opts = { ...DEFAULT_RENDER, ...options }
  const compiled = compile(patch)

  const params = compiled.params.slice()
  for (const [key, value] of Object.entries(values)) {
    const index = compiled.paramIndex[key]
    if (index !== undefined) params[index] = value
  }

  const engine = new GraphEngine(compiled, opts.sampleRate, params, opts.seed, opts.samples)
  // A render is what reaches the recorder, not what reaches the speakers.
  // With nothing patched to it the two are the same signal.
  engine.setTap('recorder')
  const total = Math.max(BLOCK, Math.ceil(opts.duration * opts.sampleRate))
  const gateFrames = Math.round(opts.gateSeconds * opts.sampleRate)

  const left = new Float32Array(total)
  const right = new Float32Array(total)
  const bl = new Float32Array(BLOCK)
  const br = new Float32Array(BLOCK)

  engine.setPlayed(true)
  let gateOpen = true

  for (let i = 0; i < total; i += BLOCK) {
    // The gate closes on a block boundary; at 128 samples that is under 3ms,
    // which is finer than any envelope this is driving.
    if (gateOpen && i >= gateFrames) {
      engine.setPlayed(false)
      gateOpen = false
    }
    engine.render(bl, br)
    const n = Math.min(BLOCK, total - i)
    left.set(bl.subarray(0, n), i)
    right.set(br.subarray(0, n), i)
  }

  return finish(left, right, opts)
}

export interface TrimOptions {
  sampleRate: number
  /** Fade applied to the tail, to stop the trim from clicking. */
  fadeMs: number
  /** Trim anything quieter than this off the end. */
  silenceDb: number
  /**
   * Never trim below this, and never fade inside it.
   *
   * What a song bounce needs. An arrangement's length is a decision somebody
   * made -- a bar with notes only in its first half is still a bar -- so
   * trimming the quiet end of it would produce a file that no longer tiles,
   * which for a piece of looping game music is the whole job. Everything past
   * it is release and reverb, and that is fair game.
   */
  minFrames?: number
}

/**
 * Trim the silent tail, fade what is left, and report the peak.
 *
 * Shared with the song bounce, which wants exactly this and nothing else: a
 * piece ends when its last reverb tail has died away, and where that is
 * cannot be worked out from the arrangement.
 */
export function trimTail(left: Float32Array, right: Float32Array, opts: TrimOptions) {
  const threshold = Math.pow(10, opts.silenceDb / 20)
  const floor = Math.min(left.length, Math.max(BLOCK, opts.minFrames ?? 0))

  let end = left.length
  while (end > floor) {
    const i = end - 1
    if (Math.abs(left[i]) > threshold || Math.abs(right[i]) > threshold) break
    end--
  }

  // Only the part beyond the arrangement may be faded. With nothing left past
  // it there is nothing to fade and nothing to click: the cut is exactly where
  // the piece ends, which is where the next pass of a loop begins.
  const fade = Math.min(Math.round((opts.fadeMs / 1000) * opts.sampleRate), end - floor)
  const l = left.subarray(0, end)
  const r = right.subarray(0, end)

  for (let i = 0; i < fade; i++) {
    // (i + 1) so the very last sample lands on exactly zero.
    const g = (i + 1) / fade
    const at = end - fade + i
    l[at] *= 1 - g
    r[at] *= 1 - g
  }

  let peak = 0
  for (let i = 0; i < end; i++) {
    const a = Math.max(Math.abs(l[i]), Math.abs(r[i]))
    if (a > peak) peak = a
  }

  return {
    left: l.slice() as Float32Array<ArrayBuffer>,
    right: r.slice() as Float32Array<ArrayBuffer>,
    peak,
    seconds: end / opts.sampleRate,
  }
}

function finish(left: Float32Array, right: Float32Array, opts: RenderOptions): RenderResult {
  const trimmed = trimTail(left, right, opts)
  return { ...trimmed, sampleRate: opts.sampleRate, seed: opts.seed }
}

/** The seed for one take in a batch. */
export function variationSeed(seed: number, index: number): number {
  return streamSeed(seed, `take${index}`)
}

/**
 * Knob positions for one take.
 *
 * Jitter is applied in normalised knob space rather than to the raw value, so
 * it respects each parameter's curve: a tenth of the travel means the same
 * musical amount at the bottom of a cutoff sweep as at the top, which moving
 * the value by a tenth of its range does not.
 */
export function variationValues(
  patch: Patch,
  values: Record<string, number>,
  seed: number,
  index: number,
  spread: number,
): Record<string, number> {
  if (spread <= 0) return values

  const rng = streamFor(seed, `spread${index}`)
  const out = { ...values }

  // Walked in patch order so a given take always jitters the same way.
  for (const m of patch.modules) {
    for (const spec of defOf(m.type).params) {
      // Switches are left alone: a footstep that randomly becomes a sine wave
      // is not a variation of the same sound. So are played parameters, for
      // the same reason -- a batch varies the patch, not the performance, and
      // a keyboard note that wandered would give eight different notes rather
      // than eight versions of one.
      if (spec.steps || spec.played) continue
      const key = `${m.id}.${spec.id}`
      const current = out[key] ?? spec.default
      const t = normalize(spec, current) + (rng() * 2 - 1) * spread
      out[key] = denormalize(spec, t)
    }
  }
  return out
}

/** One take of a batch: its own seed, and its own jittered knobs. */
export function renderVariation(
  patch: Patch,
  values: Record<string, number>,
  options: Partial<RenderOptions>,
  index: number,
  spread: number,
): RenderResult {
  const base = { ...DEFAULT_RENDER, ...options }
  const seed = variationSeed(base.seed, index)
  return renderPatch(patch, variationValues(patch, values, base.seed, index, spread), {
    ...base,
    seed,
  })
}
