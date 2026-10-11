import { DelayLine } from '../DelayLine'
import { Tpt } from '../Tpt'
import { DspModule } from './types'

const P_SPEED = 0
const P_DISTANCE = 1
const P_RANGE = 2
const P_AIR = 3

const IN = 0
const IN_TRIG = 1
const IN_POS = 2

const OUT_L = 0
const OUT_R = 1

/** Metres a second. */
const SOUND = 343

/** The Range and Distance knobs' tops, which the delay is built to reach. */
const MAX_RANGE = 300
const MAX_DISTANCE = 100

/**
 * A sound going past: a car, a jet, an arrow, a bee, a whoosh.
 *
 * The sound travels along a straight line that passes Distance metres from
 * the listener, from Range metres off on one side to Range on the other.
 * Everything a passing sound does falls out of that geometry together. The
 * delay is how long the sound takes to arrive, and it shrinks as the sound
 * approaches and grows as it leaves -- which is the Doppler shift itself,
 * the pitch high coming in and dropping as it passes. Level falls with
 * distance, the air takes the top off far away (by Air), and the sound
 * pans across from one side to the other.
 *
 * Unpatched it passes again and again at Speed. A rising edge at Trig
 * sends it past once, from the start. Or patch Pos, -1 to 1 along the line,
 * and a game's own position for the thing drives it: the shift comes from
 * how fast Pos moves.
 */
export class DopplerModule extends DspModule {
  private line = new DelayLine(((Math.hypot(MAX_RANGE, MAX_DISTANCE) / SOUND) + 0.05) * this.ctx.sampleRate)
  /**
   * Where it was, sample by sample, as far back as the sound can take to
   * arrive: what is heard now left the source when it was somewhere else,
   * and that is the position the delay, the level and the pan answer to.
   */
  private track = new DelayLine(((Math.hypot(MAX_RANGE, MAX_DISTANCE) / SOUND) + 0.05) * this.ctx.sampleRate)
  /** Last sample's delay, which this sample's search starts from. */
  private delay = 0
  private airL = new Tpt()
  /** Where along the line it is, in metres; negative is the left. */
  private x = 0
  private started = false
  private wasHigh = false
  /** Pos, smoothed, so a CV stepping does not click the delay. */
  private pos = 0

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const input = this.inputs[IN]
    const trig = this.inputs[IN_TRIG]
    const posIn = this.inputs[IN_POS]
    const outL = this.outputs[OUT_L]
    const outR = this.outputs[OUT_R]
    const speed = this.params[P_SPEED]
    const distance = Math.max(0.5, this.params[P_DISTANCE])
    const range = Math.max(1, this.params[P_RANGE])
    const air = this.params[P_AIR]
    const triggered = this.ins[IN_TRIG] !== 0
    const positioned = this.ins[IN_POS] !== 0
    const posK = 1 - Math.exp(-1 / (0.02 * sr))
    if (!this.started) {
      this.x = positioned ? (posIn[from] < -1 ? -1 : posIn[from] > 1 ? 1 : posIn[from]) * range : -range
      this.pos = this.x / range
      // As though it had been sitting there all along: an empty history
      // would put it beside the listener -- loud, close and centred -- for
      // as long as the sound takes to arrive from where it really is.
      this.track.fill(this.x)
      this.started = true
    }

    for (let i = from; i < to; i++) {
      if (positioned) {
        let p = posIn[i]
        p = p < -1 ? -1 : p > 1 ? 1 : p
        this.pos += (p - this.pos) * posK
        this.x = this.pos * range
      } else {
        const high = trig[i] > 0.5
        if (high && !this.wasHigh) this.x = -range
        this.wasHigh = high
        this.x += speed / sr
        if (this.x > range) {
          // Round again, or wait at the far end for the next trigger.
          this.x = triggered ? range : -range
        }
      }

      this.line.push(input[i])
      this.track.push(this.x)
      // The delay is how long ago the sound now arriving set off, and that
      // depends on where the source was then: a fixed point, found in a
      // few steps from last sample's answer because nothing here moves
      // faster than sound.
      let d = this.delay
      let xe = this.x
      for (let k = 0; k < 3; k++) {
        xe = d >= 1 ? this.track.read(d) : this.x
        d = (Math.hypot(xe, distance) / SOUND) * sr
      }
      this.delay = d
      const r = Math.hypot(xe, distance)
      const heard = this.line.read(d)
      // Level by the inverse of distance, at one where it is closest.
      const gain = distance / r
      // Air: the top coming off with distance. Up close, open to 18 kHz.
      // A Q of a half: as steep as it can be without overshooting an edge.
      this.airL.tune(18000 / (1 + (r * air) / 8), 0.5, sr)
      this.airL.process(heard)
      const y = this.airL.low * gain
      // Equal power across the field, by the angle it is heard from.
      const pan = xe / r
      const angle = ((pan + 1) * Math.PI) / 4
      outL[i] = y * Math.cos(angle)
      outR[i] = y * Math.sin(angle)
    }
  }
}
