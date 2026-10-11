import { Smoothed } from '../Smoothed'
import { Tpt } from '../Tpt'
import { DspModule } from './types'

const P_SPEED = 0
const P_ROUGH = 1
const P_TONE = 2
const P_RING = 3
const P_MODE = 4
const P_LEVEL = 5

const IN_SPEED = 0

const OUT = 0

const MODE_ROLL = 1

/** How far a speed of 1 turns a rolling thing each second: a barrel at a brisk push. */
const TURNS_AT_FULL = 3

/**
 * One thing moving across another: a crate dragged over boards, gravel
 * underfoot, a barrel rolling, a blade drawn from its sheath.
 *
 * The surface is grit and bumps. Moving across it, the grit is a hiss and
 * the bumps are knocks, and both follow Speed: faster is denser, louder and
 * brighter, and at a standstill it is silent. Rough trades a fine, even
 * surface -- sand, a smooth blade -- for a coarse one of fewer, bigger
 * knocks: stones, splinters, cobbles. Everything goes through one resonance,
 * Tone and Ring, which is the object being moved: low and ringing for a
 * metal drum, high and dry for a pebble.
 *
 * Roll adds the turning: a thump once a revolution and a swell with it, at a
 * rate that follows Speed, so pushing harder rolls faster.
 *
 * Speed's jack adds to the knob, so an envelope or a game's own speed is
 * what drags it.
 */
export class ScrapeModule extends DspModule {
  private body = new Tpt()
  private grit = 0
  /** A knock's own short ring, before the body. */
  private knock = 0
  private turn = 0
  private thump = 0
  private speed!: Smoothed
  private tone!: Smoothed
  private level!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.speed = new Smoothed(this.params[P_SPEED], sr, 20)
    this.tone = new Smoothed(this.params[P_TONE], sr, 20)
    this.level = new Smoothed(this.params[P_LEVEL], sr)
  }

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const speedIn = this.inputs[IN_SPEED]
    const out = this.outputs[OUT]
    this.speed.set(this.params[P_SPEED])
    this.tone.set(this.params[P_TONE])
    this.level.set(this.params[P_LEVEL])
    const rough = this.params[P_ROUGH]
    const ring = this.params[P_RING]
    const rolling = Math.round(this.params[P_MODE]) === MODE_ROLL
    // Fine surfaces have many small bumps; coarse ones fewer, bigger ones.
    const bumpsAtFull = 4000 * Math.pow(0.012, rough)
    const grain = 0.25 + 3.5 * rough
    const q = 0.7 + ring * 24

    for (let i = from; i < to; i++) {
      let v = this.speed.next() + speedIn[i]
      v = v < 0 ? 0 : v > 1.5 ? 1.5 : v

      // The grit: noise darkened at a crawl and bright at speed.
      const cutoff = 0.02 + 0.5 * v
      this.grit += ((this.random() * 2 - 1) - this.grit) * (cutoff > 0.9 ? 0.9 : cutoff)
      let x = this.grit * v * (1 - rough * 0.6) * 0.6

      // The bumps: as many a second as the surface has under the distance
      // covered, each a different height -- mostly small, now and then big.
      if (this.random() < (bumpsAtFull * v) / sr) {
        const u = this.random()
        this.knock += (this.random() < 0.5 ? -1 : 1) * Math.pow(u, grain) * (0.4 + v)
      }
      x += this.knock
      this.knock *= 0.6

      if (rolling) {
        this.turn += (TURNS_AT_FULL * v) / sr
        if (this.turn >= 1) {
          this.turn -= 1
          // The seam, the flat spot, the barrel's hoop: once a turn.
          this.thump += 0.8 * (0.3 + v)
        }
        x = x * (0.6 + 0.4 * Math.sin(2 * Math.PI * this.turn)) + this.thump
        this.thump *= 0.995
      }

      this.body.tune(this.tone.next() * (0.6 + 0.6 * v), q, sr)
      const y = this.body.process(x)
      // Some of the raw scrape alongside the ring, so a dry setting is still
      // a texture rather than nothing.
      out[i] = Math.tanh(y * (1 + ring) + x * 0.3) * this.level.next()
    }
  }
}
