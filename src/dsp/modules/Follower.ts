import { pulseSamples, tauStep } from '../util'
import { DspModule } from './types'

const P_ATTACK = 0
const P_RELEASE = 1
const P_GAIN = 2
const P_THRESHOLD = 3
const P_MODE = 4

const OUT = 0
const OUT_INV = 1
const OUT_GATE = 2
const OUT_TRIG = 3

const MODE_RMS = 1

/**
 * How long RMS mode averages power over before Attack and Release see it. The
 * average has to rise and fall alike -- averaged with a fast attack and a slow
 * release, the square of a sine sits near its peaks and reads as its peak.
 */
const RMS_WINDOW = 0.01

/**
 * The Gate closes again only once Out has fallen this far below Threshold, so
 * a level hovering right at it does not chatter open and shut.
 */
const HYSTERESIS = 0.8

/**
 * Envelope follower: how loud whatever reaches it is, as a control voltage.
 *
 * The input is rectified -- its size, whichever way it swings -- and then
 * smoothed, rising at Attack and falling at Release, the way a compressor's
 * detector or a VU meter's needle does. Peak mode follows the size of the
 * wave itself, quick to catch a drum hit; RMS follows its power, averaged
 * over ten milliseconds, steadier and closer to how loud it sounds.
 *
 * Out is that level times Gain, kept between 0 and 1, so a kick through it is
 * a CV that jumps with every hit and dies away with it. Inv is one minus
 * that: the same kick ducking something. Gate is high while Out is above
 * Threshold, and Trig fires once each time it opens, so a sound can strike
 * something else -- a snare hit firing an envelope, or a voice opening a
 * filter only while it speaks.
 */
export class FollowerModule extends DspModule {
  private level = 0
  private power = 0
  private open = false
  private trigLeft = 0

  processBlock(from: number, to: number) {
    const input = this.inputs[0]
    const out = this.outputs[OUT]
    const inv = this.outputs[OUT_INV]
    const gate = this.outputs[OUT_GATE]
    const trig = this.outputs[OUT_TRIG]
    const sr = this.ctx.sampleRate
    const up = tauStep(this.params[P_ATTACK] * sr)
    const down = tauStep(this.params[P_RELEASE] * sr)
    const gain = this.params[P_GAIN]
    const threshold = this.params[P_THRESHOLD]
    const rms = Math.round(this.params[P_MODE]) === MODE_RMS
    const pulse = pulseSamples(sr)
    const average = tauStep(RMS_WINDOW * sr)
    let level = this.level
    let power = this.power
    let open = this.open
    let trigLeft = this.trigLeft

    for (let i = from; i < to; i++) {
      const x = input[i]
      let target: number
      if (rms) {
        power += (x * x - power) * average
        target = Math.sqrt(power)
      } else target = x < 0 ? -x : x
      level += (target - level) * (target > level ? up : down)
      let y = level * gain
      if (y > 1) y = 1
      out[i] = y
      inv[i] = 1 - y

      if (!open && y > threshold && threshold < 1) {
        open = true
        trigLeft = pulse
      } else if (open && y < threshold * HYSTERESIS) open = false
      gate[i] = open ? 1 : 0
      trig[i] = trigLeft > 0 ? 1 : 0
      if (trigLeft > 0) trigLeft--
    }
    // Denormals: a level decaying towards zero for ever would end up there.
    this.level = level < 1e-20 ? 0 : level
    this.power = power < 1e-20 ? 0 : power
    this.open = open
    this.trigLeft = trigLeft
  }
}
