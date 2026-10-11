import { Smoothed } from '../Smoothed'
import { DspModule, type Feed } from './types'

const P_LEVEL = 0

const NO_FEED = new Float32Array(0)

/**
 * Another track's audio, straight out of its rack: what a sidechain listens
 * to. Patch it into a Compressor's Key and the bass ducks under the kick.
 *
 * Which track is its text, by id, so the rack it sits in names the track
 * rather than a place in the song. It hears the rack before its channel --
 * before the fader, the pan and the mute -- as a sidechain usually does, so
 * a muted kick still pumps the bass. Silent until it is pointed at a track,
 * for a track that has gone, and for one that would close a loop.
 */
export class TrackInModule extends DspModule {
  readonly hears = true
  /** Its own, not the track's: each Track In may hear a different track. Bound by the song. */
  feed: Feed = { l: NO_FEED, r: NO_FEED, base: 0 }
  private level!: Smoothed

  prepare() {
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
  }

  processBlock(from: number, to: number) {
    this.level.set(this.params[P_LEVEL])
    const outL = this.outputs[0]
    const outR = this.outputs[1]
    const { l, r, base } = this.feed
    if (l.length === 0) {
      outL.fill(0, from, to)
      outR.fill(0, from, to)
      this.level.reset(this.params[P_LEVEL])
      return
    }
    for (let i = from; i < to; i++) {
      const g = this.level.next()
      outL[i] = l[base + i] * g
      outR[i] = r[base + i] * g
    }
  }
}
