/**
 * When a metronome clicks, and how each click sounds: the counting behind the
 * Metronome utility, apart from any audio so the checks can hold it to time.
 *
 * Tempo counts quarter notes, as it does everywhere in the app; a beat is the
 * time signature's own unit, so 6/8 at 120 clicks six eighths a bar, a quarter
 * of a second apart.
 */
import { beatSeconds, type Signature } from './timing'

/** What a click is: the bar's first beat, any other beat, or a subdivision between beats. */
export type ClickKind = 'accent' | 'beat' | 'sub'

export interface Click {
  /** When it sounds, in the clock's own seconds. */
  time: number
  kind: ClickKind
  /** Which beat of the bar it belongs to, from 0. */
  beat: number
}

export interface MetronomeSettings {
  bpm: number
  sig: Signature
  /** Clicks per beat: 1 is the beat alone, 3 is triplets. */
  subdivision: number
  /** Whether the bar's first beat is a different click. */
  accent: boolean
}

/**
 * The count, from a start time on. Asked for every click before a time,
 * each call carrying on from where the last stopped, so a scheduler can keep
 * a short way ahead of the audio and a tempo change lands on the next click
 * rather than jolting the one in progress.
 */
export class ClickCounter {
  private next: number
  /** Clicks so far in this bar, counting subdivisions. */
  private step = 0

  constructor(start: number) {
    this.next = start
  }

  /** Every click due before `until`, under the settings as they are now. */
  until(until: number, s: MetronomeSettings): Click[] {
    const out: Click[] = []
    const perBeat = Math.max(1, Math.round(s.subdivision))
    const beats = Math.max(1, Math.round(s.sig.beats))
    const gap = beatSeconds(s.bpm, s.sig) / perBeat
    // A bar that has got shorter under it -- the signature changed -- starts again.
    if (this.step >= beats * perBeat) this.step = 0
    while (this.next < until) {
      const beat = Math.floor(this.step / perBeat)
      const onBeat = this.step % perBeat === 0
      const kind: ClickKind = !onBeat ? 'sub' : beat === 0 && s.accent ? 'accent' : 'beat'
      out.push({ time: this.next, kind, beat })
      this.next += gap
      this.step = (this.step + 1) % (beats * perBeat)
    }
    return out
  }
}

/** How each sound plays each kind of click: a pitch, how long it rings, and how loud. */
export const CLICK_SOUNDS = {
  click: { accent: [2000, 0.03, 1], beat: [1400, 0.03, 0.7], sub: [1000, 0.02, 0.35] },
  wood: { accent: [1100, 0.06, 1], beat: [800, 0.06, 0.75], sub: [600, 0.04, 0.4] },
  beep: { accent: [1760, 0.08, 0.9], beat: [880, 0.08, 0.65], sub: [660, 0.05, 0.3] },
} as const satisfies Record<string, Record<ClickKind, readonly [number, number, number]>>

export type ClickSound = keyof typeof CLICK_SOUNDS
