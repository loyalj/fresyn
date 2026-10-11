import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_LEVEL = 0

/**
 * Whatever the song routes to this track: the channels whose output goes
 * here, and the sends turned up to it, summed in stereo after their faders.
 *
 * It is what makes a track a bus. Everything after it is an ordinary rack --
 * any effect, in any order, with LFOs and macros on its knobs -- so a bus is
 * built and automated exactly the way a sound is. Silent anywhere nothing is
 * routed to it: in a rack on its own, or a track nothing feeds.
 */
export class BusInModule extends DspModule {
  readonly listens = true
  private level!: Smoothed

  prepare() {
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
  }

  processBlock(from: number, to: number) {
    this.level.set(this.params[P_LEVEL])
    const outL = this.outputs[0]
    const outR = this.outputs[1]
    const feed = this.feed
    if (!feed || feed.l.length === 0) {
      outL.fill(0, from, to)
      outR.fill(0, from, to)
      this.level.reset(this.params[P_LEVEL])
      return
    }
    const { l, r, base } = feed
    for (let i = from; i < to; i++) {
      const g = this.level.next()
      outL[i] = l[base + i] * g
      outR[i] = r[base + i] * g
    }
  }
}
