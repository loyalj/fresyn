import { DcBlocker } from '../DcBlocker'
import { Smoothed } from '../Smoothed'
import { LiveLoudness } from '../Loudness'
import { panLeft, panRight } from '../util'
import { DspModule, type Metering } from './types'

const CHANNELS = 8
const P_MASTER = CHANNELS * 2
const P_MUTE = P_MASTER + 1
const P_SOLO = P_MUTE + CHANNELS

const OUT_L = 0
const OUT_R = 1

/** How long the loudness goes on being measured after a report asks for it. */
const LISTEN_SAMPLES = 48000

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
  /** Works only on what reaches it, so it may rest; see `DspModule.rests`. */
  readonly rests = true
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
   * Samples left for which the loudness is worth measuring: some after each
   * report, so it runs while a panel is showing it and not otherwise. Four
   * K-weighting filters a sample was a tenth of the rack on a song, spent on
   * every track's mixer for the one meter on screen -- and on every mixer in
   * a bounce, where nothing reads it at all.
   */
  private listening = 0
  /** Channels with anything to do this block, in order; see `processBlock`. */
  private live = new Int32Array(CHANNELS)

  /**
   * Peaks since the last call, then reset so the next report covers only the
   * window after it. The buffer is owned and reused: handing back a fresh
   * array thirty times a second would put a collection on the audio thread.
   */
  levels(): Float32Array {
    // Long enough to cover the gap to the next report, and the three
    // seconds short-term loudness is measured over once it has started.
    this.listening = LISTEN_SAMPLES * (this.ctx.sampleRate / 48000)
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

      // Folded into the fader gain rather than applied after it, so a mute
      // rides the same smoother a fader does. A gain that steps to zero is
      // heard as a click, and muting a channel is exactly when you do not
      // want a new noise.
      const gain = level * open
      const l = gain * panLeft(pan)
      const r = gain * panRight(pan)
      this.gainL[c].set(l)
      this.gainR[c].set(r)
      if (force) {
        this.gainL[c].reset(l)
        this.gainR[c].reset(r)
      }
    }
  }

  processBlock(from: number, to: number) {
    // Trig only when a knob actually moved; the smoothers carry the rest.
    this.updateGains(false)
    this.master.set(this.params[P_MASTER])

    // The channels worth visiting this block: every patched one, and an
    // unpatched one only while its fader is still gliding. An unpatched
    // channel adds nothing, and a settled smoother hands back what it did
    // last time, so skipping the rest changes no sample.
    const live = this.live
    let count = 0
    for (let c = 0; c < CHANNELS; c++) {
      if (this.ins[c] !== 0 || !this.gainL[c].settled || !this.gainR[c].settled) live[count++] = c
    }

    const ins = this.inputs
    const outL = this.outputs[OUT_L]
    const outR = this.outputs[OUT_R]
    const peaks = this.peaks
    const listening = this.listening > 0
    for (let i = from; i < to; i++) {
      let l = 0
      let r = 0
      for (let k = 0; k < count; k++) {
        const c = live[k]
        const gl = this.gainL[c].next()
        const gr = this.gainR[c].next()
        if (this.ins[c] === 0) continue // unpatched: reads ground
        const x = ins[c][i]
        l += x * gl
        r += x * gr

        // Post-fader and pre-pan, which is what the fader beside the meter is
        // setting: constant-power panning keeps the two gains' magnitude at
        // the fader value, so this is the channel's contribution to the bus
        // however it is placed in the image.
        // Post-fader, and post-mute with it: a strip that is switched off
        // reads dark, which is how you tell a muted channel from a silent one.
        const a = (x < 0 ? -x : x) * this.params[c * 2] * this.open[c]
        if (a > peaks[c]) peaks[c] = a
      }

      const m = this.master.next()
      const yl = Math.tanh(this.dcL.process(l * m))
      const yr = Math.tanh(this.dcR.process(r * m))
      outL[i] = yl
      outR[i] = yr

      const al = yl < 0 ? -yl : yl
      const ar = yr < 0 ? -yr : yr
      const bus = al > ar ? al : ar
      if (bus > peaks[CHANNELS]) peaks[CHANNELS] = bus
      if (listening) this.loudness.push(yl, yr)
    }
    if (listening) this.listening -= to - from
  }
}
