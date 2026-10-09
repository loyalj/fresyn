import { Smoothed } from '../Smoothed'
import { DspModule, EdgeDetector } from './types'

const P_PITCH = 0
/** The nine drawbars sit at 1 to 9, in the order an organ lays them out. */
const P_BAR = 1
const P_PERC = 10
const P_PERC_DECAY = 11
const P_CLICK = 12
const P_LEVEL = 13

const IN_GATE = 0
const IN_PITCH = 1

/**
 * What each drawbar plays, against the 8' fundamental: the 16' sub, the 5 1/3'
 * fifth, then the 8', 4', 2 2/3', 2', 1 3/5', 1 1/3' and 1'.
 */
export const DRAWBAR_RATIOS = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8]
export const DRAWBAR_LABELS = ["16'", "5⅓'", "8'", "4'", "2⅔'", "2'", "1⅗'", "1⅓'", "1'"]
const BARS = DRAWBAR_RATIOS.length

/** The percussion's harmonic: the second (4') or the third (2 2/3'). */
const PERC_RATIOS = [0, 2, 3]
/** How loud the percussion strikes against a drawbar pulled all the way. */
const PERC_LEVEL = 1.2
/** How fast the keys open and close: a tonewheel organ is on or off. */
const KEY_S = 0.004
/** How long the key click lasts. */
const CLICK_S = 0.004
/** Everything summed is brought down by this, so a full registration does not clip. */
const MIX = 0.22
/** The highest a partial may sit, as a share of the sample rate: above it, it is left out. */
const TOP = 0.45

const TABLE = 4096
const SINE = new Float64Array(TABLE + 1)
for (let i = 0; i <= TABLE; i++) SINE[i] = Math.sin((2 * Math.PI * i) / TABLE)

/** A drawbar's position, 0 to 8, as a gain: each step is 3 dB, as on a Hammond. */
export function drawbarGain(position: number) {
  return position <= 0 ? 0 : 10 ** ((Math.min(8, position) - 8) * 3 / 20)
}

/**
 * A drawbar organ: nine sine tones at the pipe lengths an organ is
 * registered in, mixed by drawbars, as a tonewheel organ does it.
 *
 * Each drawbar is a harmonic of the note -- the sub an octave down, the
 * fifth, the fundamental, and on up to three octaves over -- and pulling one
 * out from 0 to 8 brings it up 3 dB a step. 888000000 is the first three
 * pulled all the way, the classic jazz registration; 008000000 is a flute.
 *
 * The keys open and close in a few milliseconds and click as they do, which
 * Click sets; Perc adds a decaying second or third harmonic to the start of
 * each note, the percussive "ping" that makes a tonewheel organ speak.
 *
 * Play it with a Keyboard: Gate and Pitch, as an Oscillator.
 */
export class OrganModule extends DspModule {
  readonly hasTrigger = true
  private phases = new Float64Array(BARS)
  private percPhase = 0
  private pitch!: Smoothed
  private bars: Smoothed[] = []
  private level!: Smoothed
  private edge = new EdgeDetector()
  private key = 0
  private perc = 0
  private clickLeft = 0
  private clickTone = 0
  private wasOpen = false
  private powFor = NaN
  private powIs = 1

  prepare() {
    const sr = this.ctx.sampleRate
    this.pitch = new Smoothed(this.params[P_PITCH], sr, 20)
    this.bars = []
    for (let b = 0; b < BARS; b++) this.bars.push(new Smoothed(drawbarGain(this.params[P_BAR + b]), sr))
    this.level = new Smoothed(this.params[P_LEVEL], sr)
    // Tonewheels never stop turning, so each starts wherever it happens to be.
    for (let b = 0; b < BARS; b++) this.phases[b] = this.random()
  }

  processBlock(from: number, to: number) {
    const gateIn = this.inputs[IN_GATE]
    const pitchIn = this.inputs[IN_PITCH]
    const out = this.outputs[0]
    const sr = this.ctx.sampleRate
    this.pitch.set(this.params[P_PITCH])
    for (let b = 0; b < BARS; b++) this.bars[b].set(drawbarGain(this.params[P_BAR + b]))
    this.level.set(this.params[P_LEVEL])
    const percRatio = PERC_RATIOS[Math.round(this.params[P_PERC])] ?? 0
    const percFall = Math.exp(-1 / (this.params[P_PERC_DECAY] * sr))
    const click = this.params[P_CLICK]
    const keyStep = 1 / (KEY_S * sr)
    const clickFor = Math.max(1, Math.round(CLICK_S * sr))
    const top = sr * TOP
    const phases = this.phases
    const bars = this.bars
    let key = this.key
    let perc = this.perc

    for (let i = from; i < to; i++) {
      const open = this.gateOpen || gateIn[i] > 0.5
      if (this.edge.rose(open ? 1 : 0)) {
        perc = 1
        this.clickLeft = clickFor
      } else if (!open && this.wasOpen) this.clickLeft = clickFor
      this.wasOpen = open
      if (open) key = key + keyStep > 1 ? 1 : key + keyStep
      else key = key - keyStep < 0 ? 0 : key - keyStep

      const exponent = pitchIn[i]
      if (exponent !== this.powFor) {
        this.powFor = exponent
        this.powIs = 2 ** exponent
      }
      const f = this.pitch.next() * this.powIs
      let sum = 0
      // Shut, the wheels are not heard: only the click can be.
      if (key > 0) for (let b = 0; b < BARS; b++) {
        const g = bars[b].next()
        const hz = f * DRAWBAR_RATIOS[b]
        let ph = phases[b] + hz / sr
        ph -= Math.floor(ph)
        phases[b] = ph
        if (g > 0 && hz < top) sum += g * sine(ph)
      }

      let y = sum * key
      if (percRatio > 0) {
        const hz = f * percRatio
        this.percPhase += hz / sr
        this.percPhase -= Math.floor(this.percPhase)
        if (hz < top) y += PERC_LEVEL * perc * key * sine(this.percPhase)
        perc *= percFall
      }

      // The click: a short burst of the contacts' noise, dulled a little.
      if (this.clickLeft > 0) {
        this.clickLeft--
        this.clickTone += ((this.random() * 2 - 1) - this.clickTone) * 0.5
        y += this.clickTone * click * 2.5 * (this.clickLeft / clickFor)
      }

      out[i] = y * MIX * this.level.next()
    }
    this.key = key
    this.perc = perc < 1e-6 ? 0 : perc
  }
}

/** One cycle of a sine from the table, `ph` 0 to 1. */
function sine(ph: number) {
  const x = ph * TABLE
  const i = x | 0
  return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i)
}
