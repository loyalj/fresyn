import type { SampleData } from '../samples'
import { Smoothed } from '../Smoothed'
import { DspModule, GAME_SOUND, type SoundPlayer } from './types'

const P_LEVEL = 0

/** The most passes that sound at once: overlapping clips, and a tail fading under the next. */
export const CLIP_VOICES = 8

/**
 * How long a pass takes to come in and to go, in seconds. Short enough to
 * keep a stinger's attack, long enough that starting a file part way through
 * -- or cutting one at a clip's end -- does not click.
 */
const FADE = 0.003

interface Voice {
  key: string
  data: SampleData | null
  /** Read position, in the file's frames, fractional. */
  pos: number
  gain: number
  /** Whether it is fading out, to stop. */
  leaving: boolean
  active: boolean
}

/**
 * The song's audio clips on this track: each sound the playlist puts here,
 * at the file's own speed, from wherever the clip says.
 *
 * It is what makes a track an audio track. Everything after it is an ordinary
 * rack -- an EQ, a compressor keyed by the kick, a reverb -- so a voice-over
 * or a loop is processed the way any sound is. Unpatched, it goes straight
 * to the speakers. The song tells it what to play (see `SoundPlayer`); a game
 * can too, through `SongPlayer.playSound`.
 */
export class ClipsModule extends DspModule {
  private level!: Smoothed
  private readonly voices: Voice[] = Array.from({ length: CLIP_VOICES }, () => ({
    key: '',
    data: null,
    pos: 0,
    gain: 0,
    leaving: false,
    active: false,
  }))
  private readonly fadeStep = 1 / (FADE * this.ctx.sampleRate)

  readonly sounds: SoundPlayer = {
    play: (key, data, from) => this.start(key, data, from),
    stop: (key) => {
      for (const v of this.voices) if (v.active && v.key === key) v.leaving = true
    },
    sync: (wanted) => {
      for (const v of this.voices) {
        if (v.active && !v.leaving && !v.key.startsWith(GAME_SOUND) && !wanted.some((w) => w.key === v.key)) v.leaving = true
      }
      for (const w of wanted) this.start(w.key, w.sample, w.from)
    },
    stopAll: () => {
      for (const v of this.voices) if (v.active) v.leaving = true
    },
  }

  prepare() {
    this.level = new Smoothed(this.params[P_LEVEL], this.ctx.sampleRate)
  }

  /** A pass begun, unless it is already playing. */
  private start(key: string, data: SampleData | null, from: number) {
    if (!data || data.frames < 2) return
    const pos = from * data.rate
    if (!(pos >= 0 && pos < data.frames - 1)) return
    if (this.voices.some((v) => v.active && !v.leaving && v.key === key)) return
    // A free voice, else the quietest: a tail on its way out before anything
    // still sounding in full.
    let pick = this.voices.find((v) => !v.active)
    if (!pick) {
      pick = this.voices[0]
      for (const v of this.voices) if (v.gain < pick.gain || (v.leaving && !pick.leaving)) pick = v
    }
    pick.key = key
    pick.data = data
    pick.pos = pos
    pick.gain = 0
    pick.leaving = false
    pick.active = true
  }

  processBlock(from: number, to: number) {
    this.level.set(this.params[P_LEVEL])
    const outL = this.outputs[0]
    const outR = this.outputs[1]
    outL.fill(0, from, to)
    outR.fill(0, from, to)
    const step = this.fadeStep
    for (const v of this.voices) {
      if (!v.active || !v.data) continue
      const data = v.data
      const left = data.channels[0]
      // A mono file answers both sides.
      const right = data.channels[1] ?? left
      const last = data.frames - 1
      const inc = data.rate / this.ctx.sampleRate
      for (let i = from; i < to; i++) {
        if (v.leaving) {
          v.gain -= step
          if (v.gain <= 0) {
            v.active = false
            v.data = null
            break
          }
        } else if (v.gain < 1) v.gain = Math.min(1, v.gain + step)
        const k = Math.floor(v.pos)
        if (k >= last) {
          v.active = false
          v.data = null
          break
        }
        const frac = v.pos - k
        outL[i] += (left[k] + (left[k + 1] - left[k]) * frac) * v.gain
        outR[i] += (right[k] + (right[k + 1] - right[k]) * frac) * v.gain
        v.pos += inc
      }
    }
    for (let i = from; i < to; i++) {
      const g = this.level.next()
      outL[i] *= g
      outR[i] *= g
    }
  }
}
