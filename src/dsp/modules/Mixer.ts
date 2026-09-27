import { DcBlocker } from '../DcBlocker'
import { Smoothed } from '../Smoothed'
import { LiveLoudness } from '../Loudness'
import { DspModule, type Metering } from './types'

const CHANNELS = 8
const P_MASTER = CHANNELS * 2
const P_MUTE = P_MASTER + 1
const P_SOLO = P_MUTE + CHANNELS

const OUT_L = 0
const OUT_R = 1

/**
 * 8:2 mixer. Each channel is its own input jack, which is how a patch sums
 * signals at all: every other input in the rack takes exactly one cable, as
 * on hardware, so summing is a thing a module does rather than a thing a jack
 * does implicitly.
 *
 * The bus is the end of the chain -- a mixer nobody has patched onward goes
 * straight to the speakers -- so it leaves here conditioned: the offset that
 * eight channels can accumulate is blocked, and eight channels summing past
 * full scale saturate rather than clip. That is what the output stage used to
 * do, done where the signal is actually balanced.
 */
export class MixerModule extends DspModule implements Metering {
  /** This module meters itself; see `DspModule.meter`. */
  readonly meter: Metering = this

  private gainL: Smoothed[] = []
  private gainR: Smoothed[] = []
  private master!: Smoothed
  private dcL = new DcBlocker(this.ctx.sampleRate)
  private dcR = new DcBlocker(this.ctx.sampleRate)
  /** Last raw level/pan seen per channel, so pan gains are recomputed only on change. */
  private lastLevel = new Float32Array(CHANNELS).fill(NaN)
  private lastPan = new Float32Array(CHANNELS).fill(NaN)
  private lastOpen = new Float32Array(CHANNELS).fill(NaN)
  /** 1 for a channel the mute and solo buttons are letting through, else 0. */
  private open = new Float32Array(CHANNELS).fill(1)
  /** Peak per channel since the last report, with the stereo bus last. */
  private peaks = new Float32Array(CHANNELS + 1)
  /**
   * What is reported: those peaks, then the bus's loudness in LUFS --
   * momentary and short-term -- which the face shows beside the main meter.
   * On the end, so everything that reads the peaks by position still does.
   */
  private report = new Float32Array(CHANNELS + 3)
  private loudness = new LiveLoudness(this.ctx.sampleRate)

  /**
   * Peaks since the last call, then reset so the next report covers only the
   * window after it. The buffer is owned and reused: handing back a fresh
   * array thirty times a second would put a collection on the audio thread.
   */
  levels(): Float32Array {
    this.report.set(this.peaks)
    this.peaks.fill(0)
    // Silence reads as -Infinity, which is not a number a message can be
    // trusted to carry; the face shows anything this low as no reading.
    this.report[CHANNELS + 1] = Math.max(-99, this.loudness.momentary)
    this.report[CHANNELS + 2] = Math.max(-99, this.loudness.shortTerm)
    return this.report
  }

  prepare() {
    for (let c = 0; c < CHANNELS; c++) {
      this.gainL.push(new Smoothed(0, this.ctx.sampleRate))
      this.gainR.push(new Smoothed(0, this.ctx.sampleRate))
    }
    this.master = new Smoothed(this.params[P_MASTER], this.ctx.sampleRate)
    this.updateGains(true)
  }

  /**
   * Constant-power panning: the two gains are the sine and cosine of the same
   * angle, so a signal keeps its apparent loudness as it crosses the image
   * instead of dipping in the middle the way a linear pan does.
   */
  private updateGains(force: boolean) {
    // One solo anywhere on the console silences every channel that is not
    // soloed, so it has to be known before any channel can be judged.
    let soloing = false
    for (let c = 0; c < CHANNELS; c++) {
      if (this.params[P_SOLO + c] >= 0.5) {
        soloing = true
        break
      }
    }

    for (let c = 0; c < CHANNELS; c++) {
      const level = this.params[c * 2]
      const pan = this.params[c * 2 + 1]
      // Mute still mutes a soloed channel, as on a desk: solo says which
      // channels are in the running and mute says which are switched off.
      const open =
        this.params[P_MUTE + c] >= 0.5 || (soloing && this.params[P_SOLO + c] < 0.5) ? 0 : 1
      // Written before the early return below, because the meter reads it on
      // every sample whether or not anything changed this one.
      this.open[c] = open

      if (
        !force &&
        level === this.lastLevel[c] &&
        pan === this.lastPan[c] &&
        open === this.lastOpen[c]
      ) {
        continue
      }
      this.lastLevel[c] = level
      this.lastPan[c] = pan
      this.lastOpen[c] = open

      const angle = ((pan + 1) / 2) * (Math.PI / 2)
      // Folded into the fader gain rather than applied after it, so a mute
      // rides the same smoother a fader does. A gain that steps to zero is
      // heard as a click, and muting a channel is exactly when you do not
      // want a new noise.
      const gain = level * open
      this.gainL[c].set(gain * Math.cos(angle))
      this.gainR[c].set(gain * Math.sin(angle))
      if (force) {
        this.gainL[c].reset(gain * Math.cos(angle))
        this.gainR[c].reset(gain * Math.sin(angle))
      }
    }
  }

  process(slots: Float32Array) {
    // Trig only when a knob actually moved; the smoothers carry the rest.
    this.updateGains(false)
    this.master.set(this.params[P_MASTER])

    let l = 0
    let r = 0
    for (let c = 0; c < CHANNELS; c++) {
      const gl = this.gainL[c].next()
      const gr = this.gainR[c].next()
      const slot = this.ins[c]
      if (slot === 0) continue // unpatched: reads ground
      const x = slots[slot]
      l += x * gl
      r += x * gr

      // Post-fader and pre-pan, which is what the fader beside the meter is
      // setting: constant-power panning keeps the two gains' magnitude at the
      // fader value, so this is the channel's contribution to the bus however
      // it is placed in the image.
      // Post-fader, and post-mute with it: a strip that is switched off reads
      // dark, which is how you tell a muted channel from a silent one.
      const a = (x < 0 ? -x : x) * this.params[c * 2] * this.open[c]
      if (a > this.peaks[c]) this.peaks[c] = a
    }

    const m = this.master.next()
    const outL = Math.tanh(this.dcL.process(l * m))
    const outR = Math.tanh(this.dcR.process(r * m))
    slots[this.outs[OUT_L]] = outL
    slots[this.outs[OUT_R]] = outR

    const al = outL < 0 ? -outL : outL
    const ar = outR < 0 ? -outR : outR
    const bus = al > ar ? al : ar
    if (bus > this.peaks[CHANNELS]) this.peaks[CHANNELS] = bus
    this.loudness.push(outL, outR)
  }
}
