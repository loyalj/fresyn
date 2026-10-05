import { DelayLine } from '../DelayLine'
import { Smoothed } from '../Smoothed'
import { DspModule } from './types'

const P_DRIVE = 0
const P_WOW = 1
const P_FLUTTER = 2
const P_AGE = 3
const P_HISS = 4

/** Where the playback head sits, so wow and flutter can swing either way of it. */
const BASE_S = 0.006
/** How far wow and flutter can pull the head at full, in seconds. */
const WOW_S = 0.004
const FLUTTER_S = 0.0004
/** Wow is slow and lurching, flutter fast and fine: their rates, in hertz. */
const WOW_HZ = 0.55
const FLUTTER_HZ = 7.5
/** The top of the tape's response new, and how many octaves age takes off it. */
const TOP_HZ = 16000
const AGE_OCTAVES = 2.6
/** Hiss at full, against a full-scale signal: about -30 dB. */
const HISS_LEVEL = 0.03

/**
 * A tape machine: what recording something and playing it back does to it.
 *
 * - **Drive** pushes the signal into the tape's saturation, a soft tanh that
 *   rounds the peaks off and thickens everything below them.
 * - **Wow** is the slow, lurching drift of a capstan running unevenly -- a
 *   pitch that sags and swells over a couple of seconds -- and **Flutter** the
 *   fast fine wobble on top. Both move the playback head along a short delay
 *   line, so they bend the pitch exactly the way a real transport does.
 * - **Age** rolls the top end off, as worn tape and a dirty head do.
 * - **Hiss** is the noise floor, under the signal and dulled by Age with it.
 *
 * The head sits 6 ms behind what arrives, so the wobble can swing either way
 * of it: everything through a Tape is that much late.
 */
export class TapeModule extends DspModule {
  /** Works only on what reaches it -- bar its hiss, which keeps it awake. */
  readonly rests = true
  readonly memory = BASE_S + WOW_S + FLUTTER_S
  private line = new DelayLine((BASE_S + WOW_S + FLUTTER_S) * this.ctx.sampleRate + 4)
  private wowPhase = 0
  private flutterPhase = 0
  /** A slowly wandering value under the wow, so it never quite repeats. */
  private drift = 0
  private driftTarget = 0
  private lp1 = 0
  private lp2 = 0
  private drive!: Smoothed
  private wow!: Smoothed
  private flutter!: Smoothed

  prepare() {
    const sr = this.ctx.sampleRate
    this.drive = new Smoothed(this.params[P_DRIVE], sr)
    this.wow = new Smoothed(this.params[P_WOW], sr)
    this.flutter = new Smoothed(this.params[P_FLUTTER], sr)
    this.wowPhase = this.random()
    this.flutterPhase = this.random()
  }

  processBlock(from: number, to: number) {
    const input = this.inputs[0]
    const out = this.outputs[0]
    const sr = this.ctx.sampleRate
    this.drive.set(this.params[P_DRIVE])
    this.wow.set(this.params[P_WOW])
    this.flutter.set(this.params[P_FLUTTER])
    const hiss = this.params[P_HISS] * HISS_LEVEL
    // Two one-poles in a row: the roll-off of a worn tape is gentle but deep.
    const top = TOP_HZ * 2 ** (-this.params[P_AGE] * AGE_OCTAVES)
    const a = 1 - Math.exp((-2 * Math.PI * Math.min(top, sr * 0.45)) / sr)
    const wowStep = WOW_HZ / sr
    const flutterStep = FLUTTER_HZ / sr
    const base = BASE_S * sr
    const wowSpan = WOW_S * sr
    const flutterSpan = FLUTTER_S * sr
    const driftRate = 1 / (0.8 * sr)
    const line = this.line
    let lp1 = this.lp1
    let lp2 = this.lp2

    for (let i = from; i < to; i++) {
      let x = input[i]
      if (x - x !== 0) x = 0

      // Into the tape: driven, saturated, and brought back towards unity so
      // Drive changes the character more than the level.
      const g = 1 + this.drive.next() * 6
      const taped = Math.tanh(x * g) / Math.sqrt(g)
      line.push(taped)

      // The transport: a slow sine with a wandering offset, and a fast one.
      this.wowPhase += wowStep
      if (this.wowPhase >= 1) this.wowPhase -= 1
      this.flutterPhase += flutterStep * (0.9 + 0.2 * this.drift)
      if (this.flutterPhase >= 1) this.flutterPhase -= 1
      if (Math.abs(this.drift - this.driftTarget) < 0.01) this.driftTarget = this.random() * 2 - 1
      this.drift += (this.driftTarget - this.drift) * driftRate
      const w = 0.6 * Math.sin(2 * Math.PI * this.wowPhase) + 0.4 * this.drift
      const f = Math.sin(2 * Math.PI * this.flutterPhase)
      let y = line.read(base + w * wowSpan * this.wow.next() + f * flutterSpan * this.flutter.next())

      if (hiss > 0) y += (this.random() * 2 - 1) * hiss
      lp1 += (y - lp1) * a
      lp2 += (lp1 - lp2) * a
      out[i] = lp2
    }
    this.lp1 = Math.abs(lp1) < 1e-20 ? 0 : lp1
    this.lp2 = Math.abs(lp2) < 1e-20 ? 0 : lp2
  }
}
