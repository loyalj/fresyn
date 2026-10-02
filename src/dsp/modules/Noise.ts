import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_COLOR = 0
const P_LEVEL = 1

/**
 * White and pink noise. Pink matters for game audio out of proportion to how
 * simple it is: wind, rain, fire and surf all sit much closer to pink than to
 * white, and white noise through a filter never quite gets there.
 */
export class NoiseModule extends DspModule {
  private b0 = 0
  private b1 = 0
  private b2 = 0
  private level!: Smoothed

  prepare() {
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
  }

  processBlock(from: number, to: number) {
    this.level.set(this.params[P_LEVEL])
    const pink = Math.round(this.params[P_COLOR]) === 1
    const out = this.outputs[0]
    for (let i = from; i < to; i++) {
      const white = this.random() * 2 - 1
      let y = white

      if (pink) {
        // Paul Kellet's economy pink filter: three one-poles summed, which
        // tracks -3 dB/octave closely enough across the audible band.
        this.b0 = 0.99765 * this.b0 + white * 0.0990460
        this.b1 = 0.96300 * this.b1 + white * 0.2965164
        this.b2 = 0.57000 * this.b2 + white * 1.0526913
        y = (this.b0 + this.b1 + this.b2 + white * 0.1848) * 0.28
      }

      out[i] = y * this.level.next()
    }
  }
}
