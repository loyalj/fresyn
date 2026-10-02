import { Smoothed } from '../Smoothed'
import { clamp, pulseSamples } from '../util'
import { DspModule, EdgeDetector } from './types'

const P_START = 0
const P_LENGTH = 1
const P_SPEED = 2
const P_CV_AMOUNT = 3
const P_FADE = 4
const P_LEVEL = 5
const P_LOOP = 6
const P_DIRECTION = 7

const IN_GATE = 0
const IN_PITCH = 1

const OUT_L = 0
const OUT_R = 1
const OUT_END = 2

/**
 * Plays a piece of audio the rack did not make.
 *
 * The only module here that has an outside: everything else in this rack is
 * arithmetic, and this one is a file somebody dropped on it. The audio itself
 * lives in the engine's sample bank rather than in the patch -- see
 * `samples.ts` for why -- and arrives here as a pointer the engine sets, so
 * the audio thread never looks anything up.
 *
 * **Nothing loaded is a first-class state.** A Sampler with no audio is
 * silent and costs nothing, because that is how it spends its first minute on
 * the rack and every minute in a patch whose file has gone missing.
 *
 * **Gate.** A rising edge starts the region playing. In one-shot that is the
 * whole story and the length of the gate is irrelevant. In loop the region
 * repeats while the gate is held, and letting go does not cut it off: the
 * current pass finishes, which means it ends through the same fade as any
 * other pass rather than stopping mid-wave with a click.
 */
export class SamplerModule extends DspModule {
  readonly hasTrigger = true

  private gate = new EdgeDetector()
  private playing = false
  /** Whether a held gate is still asking for another pass. */
  private looping = false
  /** Read position, in source frames, fractional. */
  private pos = 0
  private ending = 0
  private readonly endPulse = pulseSamples(this.ctx.sampleRate)
  private readonly invSampleRate = 1 / this.ctx.sampleRate
  private level!: Smoothed

  prepare() {
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
  }

  processBlock(start: number, end: number) {
    // Stepped on every sample, playing or not, so a level set between notes
    // has arrived by the next one rather than gliding in over its attack.
    this.level.set(this.params[P_LEVEL])
    const gateIn = this.inputs[IN_GATE]
    const pitch = this.inputs[IN_PITCH]
    const outL = this.outputs[OUT_L]
    const outR = this.outputs[OUT_R]
    const outEnd = this.outputs[OUT_END]
    const sample = this.sample

    if (!sample || sample.frames < 2) {
      for (let i = start; i < end; i++) {
        this.level.next()
        // Read every sample, loaded or not: an edge detector that only ran
        // while audio was present would report the first press after a file
        // lands as a rising edge that already happened.
        this.gate.rose(this.gateOpen || gateIn[i] > 0.5 ? 1 : 0)
        if (this.ending > 0) this.ending--
        this.playing = false
        outL[i] = 0
        outR[i] = 0
        outEnd[i] = 0
      }
      return
    }

    const last = sample.frames - 1
    const from = clamp(this.params[P_START], 0, 1) * last
    // Length is a fraction of what is left after Start rather than of the
    // whole file, so that Length at full always means "to the end" wherever
    // Start has been put.
    const span = (last - from) * clamp(this.params[P_LENGTH], 0, 1)
    const to = from + span

    const reverse = this.params[P_DIRECTION] >= 0.5
    const loop = this.params[P_LOOP] >= 0.5
    const speed = this.params[P_SPEED]
    const cvAmount = this.params[P_CV_AMOUNT]
    const fade = this.params[P_FADE]
    const left = sample.channels[0]
    // A mono file answers both jacks with the same signal, so a patch wired
    // for stereo does not go half silent when the file turns out to be mono.
    const right = sample.channels[1] ?? left

    for (let n = start; n < end; n++) {
      const level = this.level.next()
      const open = this.gateOpen || gateIn[n] > 0.5
      const fired = this.gate.rose(open ? 1 : 0)
      if (this.ending > 0) this.ending--

      if (fired && span > 0) {
        this.playing = true
        this.looping = loop
        this.pos = reverse ? to : from
      }
      // Letting go stops the repeating, not the pass that is playing.
      if (!open) this.looping = false

      if (!this.playing) {
        outL[n] = 0
        outR[n] = 0
        outEnd[n] = this.ending > 0 ? 1 : 0
        continue
      }

      // Source frames per output sample. The rate ratio is what keeps a
      // 44.1 kHz file at its own pitch on a 48 kHz rack; Speed and the Pitch
      // jack are the musical part on top of it. Written out rather than as
      // `expCv`, which would multiply Speed by the CV before the rate ratio
      // instead of after: the same number, but not to the last bit, and
      // renders are held to that.
      const step = sample.rate * this.invSampleRate * speed * Math.pow(2, pitch[n] * cvAmount)
      const inc = reverse ? -step : step

      // A fade measured in output time rather than in source frames, so it
      // lasts the same few milliseconds however fast the sample is being
      // played.
      const fadeFrames = fade * this.ctx.sampleRate * Math.abs(inc)
      let gain = level
      if (fadeFrames > 0) {
        const inFrom = (this.pos - from) / fadeFrames
        const inTo = (to - this.pos) / fadeFrames
        const edge = inFrom < inTo ? inFrom : inTo
        if (edge < 1) gain *= edge < 0 ? 0 : edge
      }

      const i = Math.floor(this.pos)
      const frac = this.pos - i
      const a = clamp(i, 0, last)
      const b = a < last ? a + 1 : a

      outL[n] = (left[a] + (left[b] - left[a]) * frac) * gain
      outR[n] = (right[a] + (right[b] - right[a]) * frac) * gain

      this.pos += inc
      const done = reverse ? this.pos <= from : this.pos >= to
      if (done) {
        if (this.looping) {
          this.pos += reverse ? span : -span
        } else {
          this.playing = false
          this.ending = this.endPulse
        }
      }

      outEnd[n] = this.ending > 0 ? 1 : 0
    }
  }
}
