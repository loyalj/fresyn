import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_SIZE = 0
const P_DENSITY = 1
const P_POSITION = 2
const P_SPRAY = 3
const P_PITCH = 4
const P_SPREAD = 5
const P_MIX = 6

const IN_SIGNAL = 0
const IN_POS = 1
const IN_PITCH = 2

const OUT_L = 0
const OUT_R = 1

/**
 * How much history the buffer holds. Position and Spray are both measured
 * against it, so it is also the furthest back a grain can reach.
 *
 * Two seconds. Long enough to scatter grains across a whole impact or a spoken
 * word, short enough that eight of these in a rack is three megabytes rather
 * than thirty.
 */
const BUFFER_SECONDS = 2

/**
 * How many grains may sound at once.
 *
 * Size times Density is how many overlap in principle, which at the top of
 * both knobs is a hundred. Past about thirty the ear stops counting and starts
 * hearing texture, so the rest would be arithmetic nobody can detect.
 */
const MAX_GRAINS = 32

const WINDOW_STEPS = 2048

/**
 * A Hann window, sampled once and shared by every grain in every instance.
 *
 * Read by interpolation rather than computed per sample: a cosine for each of
 * thirty-two grains on every sample is thirty-two transcendentals where a
 * table lookup and a multiply will do, and the shape is the same every time.
 *
 * The window is what makes granular synthesis sound like anything at all. A
 * grain cut square out of a buffer starts and ends on a discontinuity, and a
 * hundred of those a second is not a texture, it is a buzz at the grain rate.
 */
const WINDOW = (() => {
  const w = new Float32Array(WINDOW_STEPS + 1)
  for (let i = 0; i <= WINDOW_STEPS; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW_STEPS)
  }
  return w
})()

/**
 * Chops what arrives at it into short overlapping grains and plays them back
 * scattered in time, pitch and space.
 *
 * This is the module that makes a sound *keep going*. Everything else in the
 * rack shapes an event: a trigger, an envelope, a decay. A granulator takes a
 * fraction of a second of material and makes as much of it as you want,
 * never quite repeating -- which is the whole problem with procedural sound
 * effects. Wind, rain, fire, crowds, engines and rubble are all this.
 *
 * It granulates its **input** rather than a file, because nothing in this rack
 * loads files and because a cable is more useful than one anyway. It is always
 * recording the last couple of seconds of whatever reaches In; the grains are
 * read from somewhere behind the write head, and **Position** is how far
 * behind. So a Noise into it is wind, an Oscillator is a shimmering drone, an
 * impact is the debris that follows it, and a Delay before it is a cloud of a
 * cloud.
 *
 * **Size** and **Density** are the two that decide what it *is*. Short grains
 * packed close are a texture with a pitch of their own; long grains spread
 * apart are a landscape of recognisable fragments. Everything else scatters:
 * **Spray** in time, **Pitch** in frequency, **Spread** across the stereo
 * image.
 *
 * Each grain takes its settings when it starts and keeps them until it ends,
 * which is why a control voltage at **Pitch** steps between grains rather than
 * bending them. That is the behaviour you want -- a cloud of different pitches
 * rather than one sliding one -- and it is also what a Sample & Hold is for.
 */
export class GranularModule extends DspModule {
  /** The last `BUFFER_SECONDS` of input, written round and round. */
  private buffer = new Float32Array(0)
  private length = 0
  private write = 0

  /**
   * The grain pool, as parallel arrays rather than objects.
   *
   * Thirty-two grains are visited on every sample at audio rate. Objects
   * would be thirty-two pointer chases into scattered memory per sample, and
   * anything that allocated would hand the audio thread a collection.
   */
  private gPos = new Float64Array(MAX_GRAINS)
  private gRate = new Float64Array(MAX_GRAINS)
  private gAge = new Float32Array(MAX_GRAINS)
  private gLife = new Float32Array(MAX_GRAINS)
  private gL = new Float32Array(MAX_GRAINS)
  private gR = new Float32Array(MAX_GRAINS)
  private gOn = new Uint8Array(MAX_GRAINS)

  /** Counts up to 1 at Density, and a grain starts each time it wraps. */
  private phase = 0

  private dry!: Smoothed
  private wet!: Smoothed

  prepare() {
    this.length = Math.max(1, Math.round(BUFFER_SECONDS * this.ctx.sampleRate))
    this.buffer = new Float32Array(this.length)
    this.write = 0
    this.phase = 0
    this.gOn.fill(0)
    this.dry = new Smoothed(1 - this.params[P_MIX], this.ctx.sampleRate)
    this.wet = new Smoothed(this.params[P_MIX], this.ctx.sampleRate)
  }

  process(slots: Float32Array) {
    const sr = this.ctx.sampleRate
    const x = slots[this.ins[IN_SIGNAL]]

    // Recorded before anything is read, so a grain starting on this sample can
    // reach the sample that arrived on it.
    this.buffer[this.write] = x
    this.write = this.write + 1 === this.length ? 0 : this.write + 1

    let density = this.params[P_DENSITY]
    if (!(density > 0)) density = 0
    this.phase += density / sr
    // A while rather than an if: past the sample rate over two, more than one
    // grain is due per sample, and dropping the rest would quietly cap Density.
    while (this.phase >= 1) {
      this.phase -= 1
      this.startGrain(slots, sr)
    }

    let l = 0
    let r = 0
    for (let i = 0; i < MAX_GRAINS; i++) {
      if (this.gOn[i] === 0) continue

      const age = this.gAge[i]
      const life = this.gLife[i]
      if (age >= life) {
        this.gOn[i] = 0
        continue
      }

      // The window, interpolated between table entries: a grain is rarely a
      // whole number of table steps long, and stepping the window instead
      // would put a staircase on every grain's edges.
      const at = (age / life) * WINDOW_STEPS
      const wi = at | 0
      const env = WINDOW[wi] + (WINDOW[wi + 1] - WINDOW[wi]) * (at - wi)

      // The buffer, interpolated the same way. Without this, any Pitch but
      // zero reads between samples and rounds, which is heard as a rasp.
      const p = this.gPos[i]
      const i0 = p | 0
      const i1 = i0 + 1 === this.length ? 0 : i0 + 1
      const s = this.buffer[i0] + (this.buffer[i1] - this.buffer[i0]) * (p - i0)

      const g = s * env
      l += g * this.gL[i]
      r += g * this.gR[i]

      let next = p + this.gRate[i]
      if (next >= this.length) next -= this.length
      else if (next < 0) next += this.length
      this.gPos[i] = next
      this.gAge[i] = age + 1
    }

    // Grains that overlap sum, so the more of them there are the louder the
    // cloud. The square root is the right correction for grains that are not
    // in step with each other; grains that *are* -- everything at one Position
    // with no Spray and no Pitch -- add up faster than that, and the saturator
    // below is what catches those rather than a correction that would leave
    // every ordinary setting too quiet.
    const overlap = Math.min(MAX_GRAINS, Math.max(1, this.params[P_SIZE] * density))
    const norm = 1 / Math.sqrt(overlap)

    const mix = this.params[P_MIX]
    this.dry.set(1 - mix)
    this.wet.set(mix)
    const d = this.dry.next() * x
    const w = this.wet.next()

    // Only the grains are saturated. Putting the dry signal through it too
    // would mean a granulator at Mix 0 quietly distorted whatever was passing
    // through it, which is not what a mix control at zero should do.
    slots[this.outs[OUT_L]] = d + Math.tanh(l * norm) * w
    slots[this.outs[OUT_R]] = d + Math.tanh(r * norm) * w
  }

  /** Take a free voice, if there is one, and point it at the buffer. */
  private startGrain(slots: Float32Array, sr: number) {
    let slot = -1
    for (let i = 0; i < MAX_GRAINS; i++) {
      if (this.gOn[i] === 0) {
        slot = i
        break
      }
    }
    // All of them sounding: drop this grain rather than stealing one. Stealing
    // cuts a window off part way through, which is the click the window exists
    // to prevent, and at this density one missing grain is inaudible.
    if (slot < 0) return

    // At least two samples, or the window has no room to open and shut.
    const life = Math.max(2, Math.round(this.params[P_SIZE] * sr))

    // How far behind the write head to read. The control voltage and Spray
    // both push further back, never forward: ahead of the write head is
    // whatever the buffer held a lap ago, which has nothing to do with the
    // sound going in now.
    const seconds =
      this.params[P_POSITION] +
      slots[this.ins[IN_POS]] * BUFFER_SECONDS +
      this.random() * this.params[P_SPRAY] * BUFFER_SECONDS

    let back = Math.round(seconds * sr)
    if (back < 1) back = 1
    else if (back > this.length - 1) back = this.length - 1

    let start = this.write - back
    if (start < 0) start += this.length

    // Octaves, as everything else in this rack scales pitch.
    const octaves = this.params[P_PITCH] + slots[this.ins[IN_PITCH]]

    // Constant power, so a grain thrown to one side is no quieter than one
    // left in the middle -- the same law the mixer pans by.
    const pan = (this.random() * 2 - 1) * this.params[P_SPREAD]
    const angle = ((pan + 1) / 2) * (Math.PI / 2)

    this.gPos[slot] = start
    this.gRate[slot] = Math.pow(2, octaves)
    this.gAge[slot] = 0
    this.gLife[slot] = life
    this.gL[slot] = Math.cos(angle)
    this.gR[slot] = Math.sin(angle)
    this.gOn[slot] = 1
  }
}
