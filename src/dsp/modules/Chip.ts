import { DspModule } from './types'

const P_WAVE = 0
const P_PITCH = 1
const P_SWEEP = 2
const P_DECAY = 3
const P_LEVEL = 4

const IN_GATE = 0
const IN_PITCH = 1

const OUT = 0

const WAVE_TRIANGLE = 3
const WAVE_NOISE = 4
const WAVE_METAL = 5

/** The pulse widths the first three positions of Wave give, as the NES has them. */
const DUTIES = [0.125, 0.25, 0.5]

/** The NES's clock, NTSC: every pitch it can play is this divided by a whole number. */
const CPU_HZ = 1789773

/** The noise channel's sixteen speeds, in clock cycles per step, slowest last. */
const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068]

/** The Pitch knob's range, which the noise speeds are spread across. */
const LOW_HZ = 27.5
const HIGH_HZ = 4186

/**
 * The 2A03, the sound chip in the NES: the voice of a generation of games,
 * with the quirks that make it sound like one.
 *
 * Wave picks a channel. Three pulses, at the widths the chip has -- 12.5%
 * thin and nasal, 25% the classic lead, 50% hollow. The triangle, which the
 * chip builds out of thirty-two steps, so it has a grit no clean triangle
 * has. And the noise, a 15-bit shift register: hiss in its long mode, and in
 * its short one (Metal) a 93-step loop that rings with a pitch of its own --
 * the clank behind a thousand explosions and coins.
 *
 * Pitch goes through the chip's own divider, so a note is the nearest one
 * the hardware could actually play: in tune in the middle and drifting out
 * at the top, as it did. Level has the chip's sixteen steps, and Decay is
 * its envelope -- sixteen steps down from a gate -- rather than a smooth one.
 * Sweep bends the pitch from every gate, by octaves a second: the jump, the
 * laser, the power-up.
 *
 * Gate starts a note; nothing patched there and it plays for ever. Pitch's
 * jack is a volt an octave, so a Keyboard plays it.
 */
export class ChipModule extends DspModule {
  private phase = 0
  /** The triangle's step, 0..31. */
  private step = 0
  private lfsr = 1
  /** Clock cycles carried over between samples for the noise. */
  private noiseClock = 0
  private wasHigh = false
  /** Seconds since the gate opened, for Sweep and Decay. */
  private age = 0

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const gate = this.inputs[IN_GATE]
    const pitchIn = this.inputs[IN_PITCH]
    const out = this.outputs[OUT]
    const wave = Math.round(this.params[P_WAVE])
    const sweep = this.params[P_SWEEP]
    const decay = this.params[P_DECAY]
    // The chip's sixteen levels.
    const volume = Math.round(Math.min(1, Math.max(0, this.params[P_LEVEL])) * 15)
    const gated = this.ins[IN_GATE] !== 0
    const base = this.params[P_PITCH]

    for (let i = from; i < to; i++) {
      const high = !gated || gate[i] > 0.5
      if (high && !this.wasHigh) this.age = 0
      this.wasHigh = high
      if (!high) {
        out[i] = 0
        continue
      }

      // The envelope: sixteen steps down across Decay, or none.
      let env = 15
      if (decay > 0) env = Math.max(0, 15 - Math.floor((this.age / decay) * 15))
      const amp = (volume * env) / 225

      let hz = base * Math.pow(2, pitchIn[i] + sweep * this.age)
      hz = hz < 8 ? 8 : hz > 16000 ? 16000 : hz
      this.age += 1 / sr

      let y: number
      if (wave === WAVE_NOISE || wave === WAVE_METAL) {
        // Pitch picks one of the sixteen speeds, low knob slow.
        const t = Math.log(hz / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ)
        let k = Math.round((1 - t) * 15)
        k = k < 0 ? 0 : k > 15 ? 15 : k
        this.noiseClock += CPU_HZ / sr
        const period = NOISE_PERIODS[k]
        const tap = wave === WAVE_METAL ? 6 : 1
        while (this.noiseClock >= period) {
          this.noiseClock -= period
          const bit = (this.lfsr ^ (this.lfsr >> tap)) & 1
          this.lfsr = (this.lfsr >> 1) | (bit << 14)
        }
        y = this.lfsr & 1 ? -amp : amp
      } else if (wave === WAVE_TRIANGLE) {
        // The divider for the triangle runs at half the pulse's rate.
        let timer = Math.round(CPU_HZ / (32 * hz) - 1)
        timer = timer < 2 ? 2 : timer > 2047 ? 2047 : timer
        const real = CPU_HZ / (32 * (timer + 1))
        this.phase += (real * 32) / sr
        while (this.phase >= 1) {
          this.phase -= 1
          this.step = (this.step + 1) & 31
        }
        const level = this.step < 16 ? 15 - this.step : this.step - 16
        y = (level / 7.5 - 1) * amp
      } else {
        let timer = Math.round(CPU_HZ / (16 * hz) - 1)
        timer = timer < 8 ? 8 : timer > 2047 ? 2047 : timer
        const real = CPU_HZ / (16 * (timer + 1))
        const dt = real / sr
        const duty = DUTIES[wave < 0 ? 0 : wave > 2 ? 2 : wave]
        this.phase += dt
        if (this.phase >= 1) this.phase -= 1
        const p = this.phase
        y = p < duty ? 1 : -1
        // Each edge smoothed across a sample either side, so a high note
        // does not fold back into the audible band as a whine.
        y += blep(p, dt)
        let fall = p - duty
        if (fall < 0) fall += 1
        y -= blep(fall, dt)
        y *= amp
      }
      out[i] = y
    }
  }
}

/** The two-sample polynomial correction for a step of 2 at phase 0. */
function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt
    return 2 * x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + 2 * x + 1
  }
  return 0
}
