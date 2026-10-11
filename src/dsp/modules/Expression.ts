import { compileExpr, ExprMachine, VAR_A, VAR_B, VAR_T, VAR_X, VAR_Y } from '../Expr'
import { DspModule, type Metering } from './types'

const P_MODE = 0
const P_A = 1
const P_B = 2
const P_RATE = 3

const IN_X = 0
const IN_Y = 1
const IN_RESET = 2

const OUT = 0

export const MODE_BYTEBEAT = 1

/** What a new Expression computes: a wavefolder on X, with A and B on it. */
export const DEFAULT_FORMULA = 'sin(pi * x) * a + b'

/** In math mode the answer is a control voltage, held inside this. */
const LIMIT = 10

/**
 * A formula typed on the panel, worked out on every sample.
 *
 * In math mode it reads X and Y from its jacks, A and B from its knobs and
 * t in seconds since Reset, and puts out whatever the formula says: a
 * waveshaper (`sin(pi * x)`), a mixer with a curve on it, an LFO of any
 * shape (`saw(t * 2) * a`), a comparison (`x > y`), a relationship between
 * two CVs that no module has.
 *
 * In bytebeat mode t is a whole number counting up at Rate -- 8000 a second,
 * as the old one-liners expect -- and the answer's low eight bits are the
 * sample, so `t*(t>>5|t>>8)` is music, of a sort.
 *
 * A formula that will not compile never reaches here: the panel keeps the
 * last one that did.
 */
export class ExpressionModule extends DspModule {
  private machine = new ExprMachine()
  /** Samples since Reset. */
  private clock = 0
  private wasHigh = false
  private held = 0
  private heldTick = -1
  private readonly report = new Float32Array(4)
  readonly meter: Metering = {
    // The last values rather than peaks: the panel puts a dot where the
    // formula is, not where it has been loudest.
    levels: () => this.report,
  }

  constructor(ctx: ConstructorParameters<typeof DspModule>[0]) {
    super(ctx)
    this.setText('')
  }

  seedFrom(seed: number, id: string) {
    super.seedFrom(seed, id)
    this.machine.reseed(Math.floor(this.random() * 4294967296))
  }

  setText(text: string) {
    if (text === this.text && this.machine.program) return
    this.text = text
    const compiled = compileExpr(text.trim() ? text : DEFAULT_FORMULA)
    // Off the audio path: this runs when the rack is rebuilt, never per
    // sample. A formula that does not compile is silence.
    this.machine.program = compiled.ok ? compiled.program : null
  }

  processBlock(from: number, to: number) {
    const sr = this.ctx.sampleRate
    const xIn = this.inputs[IN_X]
    const yIn = this.inputs[IN_Y]
    const reset = this.inputs[IN_RESET]
    const out = this.outputs[OUT]
    const bytebeat = Math.round(this.params[P_MODE]) === MODE_BYTEBEAT
    const rate = this.params[P_RATE]
    const m = this.machine
    const vars = m.vars
    vars[VAR_A] = this.params[P_A]
    vars[VAR_B] = this.params[P_B]
    let y = 0

    for (let i = from; i < to; i++) {
      const high = reset[i] > 0.5
      if (high && !this.wasHigh) {
        this.clock = 0
        this.heldTick = -1
      }
      this.wasHigh = high
      vars[VAR_X] = xIn[i]
      vars[VAR_Y] = yIn[i]

      if (bytebeat) {
        // Worked out once per tick and held between: the old players ran at
        // 8 kHz, and the steps are part of the sound.
        const tick = Math.floor((this.clock * rate) / sr)
        if (tick !== this.heldTick) {
          this.heldTick = tick
          vars[VAR_T] = tick
          this.held = ((m.run() | 0) & 255) / 127.5 - 1
        }
        y = this.held
      } else {
        vars[VAR_T] = this.clock / sr
        y = m.run()
        y = y > LIMIT ? LIMIT : y < -LIMIT ? -LIMIT : y
      }
      out[i] = y
      this.clock++
    }

    const r = this.report
    r[0] = vars[VAR_X]
    r[1] = vars[VAR_Y]
    r[2] = bytebeat ? this.heldTick : this.clock / sr
    r[3] = y
  }
}
