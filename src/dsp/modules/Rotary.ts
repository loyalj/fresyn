import { lowpass, Section } from '../Biquad'
import { DelayLine } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_SPEED = 0
const P_RAMP = 1
const P_DRIVE = 2
const P_BALANCE = 3
const P_WIDTH = 4
const P_MIX = 5

const IN_SIGNAL = 0
const IN_FAST = 1

const OUT_L = 0
const OUT_R = 1

/** Where the horn and the drum split the sound, as the cabinet's crossover does. */
const CROSSOVER_HZ = 800
/** Each rotor's two speeds, in turns a second: the horn's and the drum's are a little apart. */
const HORN_SLOW = 0.83
const HORN_FAST = 6.75
const DRUM_SLOW = 0.67
const DRUM_FAST = 5.7
/** The drum is heavy: it takes this many times as long as the horn to change speed. */
const DRUM_INERTIA = 2.5
/**
 * How far each rotor's mouth swings towards and away from a microphone, as a
 * time, which is what bends the pitch: the horn's half a millisecond, the
 * drum's a fifth of that, since what sweeps it is a baffle rather than a horn.
 */
const HORN_SWING_S = 0.00045
const DRUM_SWING_S = 0.0001
const BASE_S = 0.001
/** How much quieter each rotor is pointing away from a microphone than towards it. */
const HORN_DEPTH = 0.65
const DRUM_DEPTH = 0.3

/**
 * A rotary speaker -- the Leslie: a horn and a drum spinning in a cabinet,
 * heard through a pair of microphones.
 *
 * The highs go to the horn and the lows to the drum, and each spins at its
 * own speed. As a rotor swings towards a microphone the sound gets louder and
 * its pitch rises; swinging away, quieter and lower. Two microphones either
 * side hear the same rotor at different points in its turn, which is what
 * spreads it across the stereo field.
 *
 * Speed is chorale (slow) or tremolo (fast), and the Fast jack switches it
 * too, from a gate. Neither rotor changes speed at once: the horn takes Ramp
 * to get there and the heavier drum longer still, and that wind-up and
 * wind-down is the sound of one. It starts at slow.
 *
 * Drive is the cabinet's valve amplifier pushed, the growl of an organ dug in.
 */
export class RotaryModule extends DspModule {
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
  private horn = new DelayLine((BASE_S + HORN_SWING_S) * this.ctx.sampleRate + 4)
  private drum = new DelayLine((BASE_S + DRUM_SWING_S) * this.ctx.sampleRate + 4)
  private split = new Section()
  private hornAngle = 0
  private drumAngle = 0
  private hornSpeed = HORN_SLOW
  private drumSpeed = DRUM_SLOW
  private drive!: Smoothed
  private balance!: Smoothed
  private width!: Smoothed
  private mix!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    lowpass(this.split, sr, CROSSOVER_HZ, Math.SQRT1_2)
    this.drive = new Smoothed(this.params[P_DRIVE], sr)
    this.balance = new Smoothed(this.params[P_BALANCE], sr)
    this.width = new Smoothed(this.params[P_WIDTH], sr)
    this.mix = new Smoothed(this.params[P_MIX], sr)
    this.hornAngle = this.random()
    this.drumAngle = this.random()
  }

  processBlock(from: number, to: number) {
    const input = this.inputs[IN_SIGNAL]
    const fastIn = this.inputs[IN_FAST]
    const outL = this.outputs[OUT_L]
    const outR = this.outputs[OUT_R]
    const sr = this.ctx.sampleRate
    const switchedFast = Math.round(this.params[P_SPEED]) === 1
    const ramp = this.params[P_RAMP] * sr
    const hornRate = 1 / ramp
    const drumRate = 1 / (ramp * DRUM_INERTIA)
    this.drive.set(this.params[P_DRIVE])
    this.balance.set(this.params[P_BALANCE])
    this.width.set(this.params[P_WIDTH])
    this.mix.set(this.params[P_MIX])
    const base = BASE_S * sr
    const hornSwing = HORN_SWING_S * sr
    const drumSwing = DRUM_SWING_S * sr
    const tau = 2 * Math.PI

    for (let i = from; i < to; i++) {
      let x = input[i]
      if (x - x !== 0) x = 0
      const fast = switchedFast || fastIn[i] > 0.5
      this.hornSpeed += ((fast ? HORN_FAST : HORN_SLOW) - this.hornSpeed) * hornRate
      this.drumSpeed += ((fast ? DRUM_FAST : DRUM_SLOW) - this.drumSpeed) * drumRate
      this.hornAngle += this.hornSpeed / sr
      if (this.hornAngle >= 1) this.hornAngle -= 1
      this.drumAngle += this.drumSpeed / sr
      if (this.drumAngle >= 1) this.drumAngle -= 1

      // The amplifier, then the crossover: lows to the drum, the rest to the horn.
      const g = 1 + this.drive.next() * 8
      const driven = Math.tanh(x * g) / Math.sqrt(g)
      const low = this.split.process(driven)
      this.horn.push(driven - low)
      this.drum.push(low)

      // The microphones sit either side, Width of a quarter turn apart.
      const offset = this.width.next() * 0.25
      const h = this.hornAngle * tau
      const d = this.drumAngle * tau
      const hl = h + offset * tau
      const hr = h - offset * tau
      const dl = d + offset * tau
      const dr = d - offset * tau
      const hornL = this.horn.read(base + hornSwing * Math.sin(hl)) * (1 - HORN_DEPTH * 0.5 * (1 - Math.cos(hl)))
      const hornR = this.horn.read(base + hornSwing * Math.sin(hr)) * (1 - HORN_DEPTH * 0.5 * (1 - Math.cos(hr)))
      const drumL = this.drum.read(base + drumSwing * Math.sin(dl)) * (1 - DRUM_DEPTH * 0.5 * (1 - Math.cos(dl)))
      const drumR = this.drum.read(base + drumSwing * Math.sin(dr)) * (1 - DRUM_DEPTH * 0.5 * (1 - Math.cos(dr)))

      // Equal power between the two rotors, both at full in the middle.
      const b = this.balance.next() * (Math.PI / 2)
      const hg = Math.SQRT2 * Math.sin(b)
      const dg = Math.SQRT2 * Math.cos(b)
      const mix = this.mix.next()
      const dry = x * (1 - mix)
      outL[i] = dry + (hornL * hg + drumL * dg) * mix
      outR[i] = dry + (hornR * hg + drumR * dg) * mix
    }
  }
}
