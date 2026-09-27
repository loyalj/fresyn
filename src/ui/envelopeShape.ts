import { Envelope } from '../dsp/Envelope'

export interface EnvelopeParams {
  delay: number
  attack: number
  hold: number
  decay: number
  sustain: number
  release: number
}

export interface EnvelopeShape {
  /** Level per column, 0..1. */
  values: Float32Array
  /** Stage boundaries as fractions of the width, for the dividers. */
  marks: number[]
}

/** Attack aims past 1.0 and stops at 1.0, so it arrives in ln(6) time constants. */
const ATTACK_SPAN = Math.log(6)
/**
 * Far enough down an exponential decay to read as finished: three time
 * constants is 5%, about -26 dB. Further than that is real, but on a linear
 * picture it is a flat line along the floor, and every column spent on it is
 * one taken from the part of the curve you can actually see.
 */
const TAIL_SPAN = 3
/** Below this a sustain is silence, which is what the envelope treats it as. */
const SILENT = 1e-3

/**
 * The curve, produced by running the same envelope the audio thread runs.
 *
 * Drawing it from straight line segments instead would be easier and would
 * quietly lie: these stages are exponential, and the picture would stop
 * matching the sound as soon as either changed.
 */
export function envelopeShape(p: EnvelopeParams, points = 240): EnvelopeShape {
  const attackSpan = p.attack * ATTACK_SPAN
  const decaySpan = p.decay * TAIL_SPAN
  // With no sustain the envelope is over when its decay is: it goes idle
  // there, and a release from silence has nothing to do. So the picture ends
  // there too, rather than spending half its width on a line along the floor.
  const oneShot = p.sustain < SILENT
  const releaseSpan = oneShot ? 0 : p.release * TAIL_SPAN

  const held = p.delay + attackSpan + p.hold + decaySpan
  // A sustain segment proportional to the rest, so it reads as a stage
  // without swamping a long envelope or vanishing from a short one.
  const sustainSpan = oneShot ? 0 : Math.max(held, releaseSpan) * 0.25
  const total = held + sustainSpan + releaseSpan

  const values = new Float32Array(points)
  if (!(total > 0)) return { values, marks: [] }

  // One sample per column: the envelope is run at whatever rate makes the
  // whole shape exactly `points` long.
  const env = new Envelope(points / total)
  env.delay = p.delay
  env.attack = p.attack
  env.hold = p.hold
  env.decay = p.decay
  env.sustain = p.sustain
  env.release = p.release
  env.gateOn()

  const releaseAt = oneShot ? -1 : Math.round(((held + sustainSpan) / total) * points)
  for (let i = 0; i < points; i++) {
    if (i === releaseAt) env.gateOff()
    values[i] = env.next()
  }

  const at = (seconds: number) => seconds / total
  // The end of the decay is the right-hand edge of a one-shot, and a mark
  // there would just be drawn over the frame.
  const marks = [at(p.delay), at(p.delay + attackSpan), at(p.delay + attackSpan + p.hold)]
  if (!oneShot) marks.push(at(held), at(held + sustainSpan))
  return { values, marks }
}
