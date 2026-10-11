import { pulseSamples } from '../util'
import { DspModule } from './types'

const P_FALL = 0
const P_BOUNCE = 1
const P_SPREAD = 2

const IN_DROP = 0

const OUT_GATE = 0
const OUT_VEL = 1
const OUT_HEIGHT = 2
const OUT_END = 3

/** Once the bounces come this close together, the ball has come to rest. */
const REST_GAP_S = 0.004
/** Or once they are this soft. */
const REST_VEL = 0.01

/**
 * A ball dropped: impacts that come faster and softer until it settles.
 * Coins, ping-pong, a dropped can, shell casings, debris after a blast.
 *
 * Each rising edge at Drop -- or the panel's button -- lets go of the ball.
 * It takes Fall to hit the ground the first time, and every bounce comes
 * back with Bounce of the speed it hit with: so each gap is Bounce times
 * the last, and each hit Bounce times as hard, which is the accelerating
 * rattle a real bounce makes. Spread jitters both, for a stone tumbling
 * rather than a ball.
 *
 * Gate pulses on every impact. Vel holds how hard the last one was, 0 to 1,
 * for a VCA or a filter, so later bounces are quieter; Height is where the
 * ball is, 0 on the ground to 1 where it was dropped from; End pulses once
 * it has come to rest.
 */
export class BounceModule extends DspModule {
  readonly hasTrigger = true
  private running = false
  /** Seconds into the current flight, and how long it lasts. */
  private flight = 0
  private gap = 0
  /** How hard it last hit, and how hard it will hit next. */
  private vel = 0
  private nextVel = 1
  /** The peak of the current flight, as a share of the drop. */
  private peak = 1
  /** The first flight is a fall from the top, not a hop from the ground. */
  private falling = true
  private wasHigh = false
  private pulse = 0
  private endPulse = 0

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const drop = this.inputs[IN_DROP]
    const gateOut = this.outputs[OUT_GATE]
    const velOut = this.outputs[OUT_VEL]
    const heightOut = this.outputs[OUT_HEIGHT]
    const endOut = this.outputs[OUT_END]
    const fall = this.params[P_FALL]
    const bounce = this.params[P_BOUNCE]
    const spread = this.params[P_SPREAD]
    const width = pulseSamples(sr)

    for (let i = from; i < to; i++) {
      const high = this.gateOpen || drop[i] > 0.5
      if (high && !this.wasHigh) {
        this.running = true
        this.falling = true
        this.flight = 0
        this.gap = fall
        this.peak = 1
        this.nextVel = 1
      }
      this.wasHigh = high

      let height = 0
      if (this.running) {
        this.flight += 1 / sr
        if (this.flight >= this.gap) {
          // An impact.
          this.flight -= this.gap
          this.vel = this.nextVel
          this.pulse = width
          // Back up with Bounce of the speed: a hop of twice the fall time
          // at that speed, and a peak of the speed squared.
          const up = Math.min(0.99, bounce * (1 + (this.random() * 2 - 1) * spread * 0.3))
          this.gap = (this.falling ? 2 * fall : this.gap) * up
          this.falling = false
          this.nextVel = this.vel * up
          this.peak = this.nextVel * this.nextVel
          if (this.gap < REST_GAP_S || this.nextVel < REST_VEL) {
            this.running = false
            this.endPulse = width
          }
        }
        if (this.running) {
          const t = this.flight / this.gap
          // A parabola: falling from the top the first time, and a hop up
          // and back down every time after.
          height = this.falling ? 1 - t * t : this.peak * (1 - (2 * t - 1) * (2 * t - 1))
        }
      }

      gateOut[i] = this.pulse > 0 ? 1 : 0
      if (this.pulse > 0) this.pulse--
      endOut[i] = this.endPulse > 0 ? 1 : 0
      if (this.endPulse > 0) this.endPulse--
      velOut[i] = this.vel
      heightOut[i] = height
    }
  }
}
