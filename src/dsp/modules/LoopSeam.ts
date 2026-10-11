import { DspModule } from './types'

const P_LENGTH = 0
const P_FADE = 1

const IN_L = 0
const IN_R = 1
const IN_REC = 2

const OUT_L = 0
const OUT_R = 1

/** The Length and Fade knobs' tops, which the buffer is built to hold. */
export const SEAM_MAX_LENGTH = 20
export const SEAM_MAX_FADE = 2

/** How long the switch from the live sound to the loop takes, the first time round. */
const SWITCH_S = 0.02

/**
 * A loop's length and crossfade in samples, as the module rounds them. The
 * render uses this too, so the file it saves is exactly one loop.
 */
export function seamFrames(length: number, fade: number, sampleRate: number) {
  const loop = Math.max(2, Math.round(Math.min(SEAM_MAX_LENGTH, length) * sampleRate))
  const cross = Math.max(1, Math.min(Math.floor(loop / 2), Math.round(Math.min(SEAM_MAX_FADE, fade) * sampleRate)))
  return { loop, cross }
}

/**
 * Turns whatever reaches it into a seamless loop: ambience, a drone, an
 * engine at idle, ready to repeat in a game with no click and no gap.
 *
 * It records Length of its input, and Fade more, and from then on plays the
 * recording round and round. The seam is hidden by a crossfade: the first
 * Fade of each pass blends from the sound just past the end into the start,
 * so the end of a pass leads straight into the next pass's opening. While it
 * records, the input passes through; a rising edge at Rec, or a turn of
 * Length or Fade, records again.
 *
 * A render of a rack with a Loop Seam in it skips the recording and saves
 * exactly one pass: no fade on the tail and no trim, so the file tiles.
 */
export class LoopSeamModule extends DspModule {
  private bufL = new Float32Array(Math.ceil((SEAM_MAX_LENGTH + SEAM_MAX_FADE) * this.ctx.sampleRate) + 4)
  private bufR = new Float32Array(this.bufL.length)
  private recording = true
  private written = 0
  private at = 0
  private loop = 0
  private cross = 0
  private switching = 0
  private wasRec = false
  private tunedLength = NaN
  private tunedFade = NaN

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const inL = this.inputs[IN_L]
    // R normals to L, so a mono sound needs one cable.
    const inR = this.ins[IN_R] !== 0 ? this.inputs[IN_R] : inL
    const rec = this.inputs[IN_REC]
    const outL = this.outputs[OUT_L]
    const outR = this.outputs[OUT_R]
    const length = this.params[P_LENGTH]
    const fade = this.params[P_FADE]
    if (length !== this.tunedLength || fade !== this.tunedFade) {
      this.tunedLength = length
      this.tunedFade = fade
      const f = seamFrames(length, fade, sr)
      this.loop = f.loop
      this.cross = f.cross
      this.restart()
    }
    const switchFrames = Math.round(SWITCH_S * sr)
    const bufL = this.bufL
    const bufR = this.bufR

    for (let i = from; i < to; i++) {
      const r = rec[i] > 0.5
      if (r && !this.wasRec) this.restart()
      this.wasRec = r
      const l = inL[i]
      const rr = inR[i]

      if (this.recording) {
        bufL[this.written] = l
        bufR[this.written] = rr
        this.written++
        outL[i] = l
        outR[i] = rr
        if (this.written >= this.loop + this.cross) {
          this.recording = false
          this.at = 0
          this.switching = switchFrames
        }
        continue
      }

      // A pass is the recording from its start, with the first Fade of it
      // blended from what came just after its end: so the end of a pass
      // leads straight into the next pass's opening.
      const k = this.at
      let yl: number
      let yr: number
      if (k < this.cross) {
        const w = ((k + 0.5) / this.cross) * (Math.PI / 2)
        const a = Math.sin(w)
        const b = Math.cos(w)
        yl = bufL[k] * a + bufL[this.loop + k] * b
        yr = bufR[k] * a + bufR[this.loop + k] * b
      } else {
        yl = bufL[k]
        yr = bufR[k]
      }
      if (this.switching > 0) {
        const g = this.switching / switchFrames
        yl = yl * (1 - g) + l * g
        yr = yr * (1 - g) + rr * g
        this.switching--
      }
      outL[i] = yl
      outR[i] = yr
      if (++this.at >= this.loop) this.at = 0
    }
  }

  private restart() {
    this.recording = true
    this.written = 0
    this.at = 0
    this.switching = 0
  }
}
