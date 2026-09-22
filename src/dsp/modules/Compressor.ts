import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_THRESHOLD = 0
const P_RATIO = 1
const P_ATTACK = 2
const P_RELEASE = 3
const P_MAKEUP = 4

const IN_SIGNAL = 0
const IN_KEY = 1

const OUT_SIGNAL = 0
const OUT_GR = 1

/** Floor under the detector, so silence is a number rather than -Infinity. */
const FLOOR = 1e-9

/** 20 / ln(10), for turning an amplitude into decibels without a log10 call. */
const DB = 8.685889638065035

/**
 * Turns the loud parts down, so the quiet parts can come up.
 *
 * The rack could shape a sound but never control it: an impact was as loud as
 * its envelope happened to make it, and a layer that peaked on one render
 * peaked somewhere else on the next. This is the module that decides how hard
 * something hits rather than leaving it to whatever the oscillator did.
 *
 * **Threshold** is the level it starts working at and **Ratio** is how hard:
 * at 4 a sound going 8 dB over comes out 2 dB over. Ratio at its top is
 * effectively a limiter -- nothing meaningful gets past the threshold -- which
 * is why there is no separate limiter module.
 *
 * **Attack** is the one to reach for on percussive material. Short and the
 * transient is caught and flattened; long and the click comes through at full
 * height before the body is turned down, which is what makes an impact sound
 * like it hit something hard. It is a tone control as much as a level one.
 *
 * The **Key** input is what makes it more than a level control. Patch another
 * signal in and that decides when it ducks while this one stays the signal
 * being ducked -- an engine that dips under every gunshot, a room tone that
 * gets out of the way of a footstep. With nothing patched it listens to its
 * own input, which is ordinary compression.
 *
 * **GR** says how hard it is working, as a control voltage: zero when it is
 * doing nothing, and rising towards one as it clamps down. Patch it at a
 * filter's CV for a sound that dulls as it is pushed, or at a VCA to drive
 * something else from this one's dynamics.
 */
export class CompressorModule extends DspModule {
  /** Gain reduction currently applied, in dB. Never negative. */
  private reduction = 0
  private makeup!: Smoothed

  /** Attack and release turned into one-pole coefficients, and what for. */
  private attackFor = -1
  private attackCoeff = 1
  private releaseFor = -1
  private releaseCoeff = 1

  prepare() {
    this.makeup = new Smoothed(this.params[P_MAKEUP], this.ctx.sampleRate)
  }

  process(slots: Float32Array) {
    this.makeup.set(this.params[P_MAKEUP])

    const x = slots[this.ins[IN_SIGNAL]]
    // Ground reads zero and never crosses the threshold, so an unpatched Key
    // is the same as no Key at all -- but the branch is on the wiring rather
    // than on the value, or a silent moment in a patched sidechain would hand
    // the detector back to the signal for as long as it lasted.
    const key = this.ins[IN_KEY]
    const detector = key === 0 ? x : slots[key]

    // Peak rather than RMS. Sound effects are transients, and an averaging
    // detector hears a gunshot as quiet because most of it is over quickly.
    const level = detector < 0 ? -detector : detector
    const db = Math.log(level + FLOOR) * DB

    let ratio = this.params[P_RATIO]
    if (!(ratio >= 1)) ratio = 1
    const over = db - this.params[P_THRESHOLD]
    const target = over > 0 ? over * (1 - 1 / ratio) : 0

    // Attack while the reduction is deepening and release while it is easing
    // off, which is what makes those two knobs mean what their names say.
    const coeff = target > this.reduction ? this.attack() : this.release()
    this.reduction += (target - this.reduction) * coeff

    const gain = Math.exp((this.makeup.next() - this.reduction) / DB)
    slots[this.outs[OUT_SIGNAL]] = x * gain

    // Reported as the fraction of the signal taken away rather than as
    // decibels, because everything that reads a control voltage in this rack
    // is scaled nought to one. 6 dB of reduction arrives as 0.5.
    slots[this.outs[OUT_GR]] = 1 - Math.exp(-this.reduction / DB)
  }

  /**
   * Time constants cost an `exp` each, and both knobs sit still for millions
   * of samples at a stretch, so each is worked out when it changes and kept.
   */
  private attack() {
    const t = this.params[P_ATTACK]
    if (t !== this.attackFor) {
      this.attackFor = t
      this.attackCoeff = coeffFor(t, this.ctx.sampleRate)
    }
    return this.attackCoeff
  }

  private release() {
    const t = this.params[P_RELEASE]
    if (t !== this.releaseFor) {
      this.releaseFor = t
      this.releaseCoeff = coeffFor(t, this.ctx.sampleRate)
    }
    return this.releaseCoeff
  }
}

/** One-pole coefficient reaching 1 - 1/e of the way in `seconds`. */
function coeffFor(seconds: number, sampleRate: number) {
  const n = seconds * sampleRate
  if (!(n > 1)) return 1
  return 1 - Math.exp(-1 / n)
}
