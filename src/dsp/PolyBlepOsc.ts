import { clamp } from './util'

export type Waveform = 'saw' | 'pulse' | 'tri' | 'sine'

/**
 * The waveforms in the order the Wave and Shape switches step through them.
 *
 * The one list both sides read: the oscillator and the LFO turn a switch
 * position into a waveform with it, and `defs.ts` labels the switch from it,
 * so the panel can never name a wave the DSP does not play at that position.
 * It lives here rather than in `defs.ts` because the worklet bundles the DSP
 * and nothing else -- the definitions reach into this file, never the other
 * way, and the audio thread stays free of anything the UI brings with it.
 */
export const WAVEFORMS: Waveform[] = ['saw', 'pulse', 'tri', 'sine']

/**
 * Band-limited oscillator. The BLEP correction is not optional: a naive
 * `phase * 2 - 1` saw aliases hard above a few hundred Hz and makes every
 * patch built on it sound cheap for reasons that are difficult to hear
 * directly.
 */
export class PolyBlepOsc {
  private phase = 0
  private readonly invSampleRate: number
  private readonly nyquist: number

  /** Where inside this sample a scheduled restart lands, or -1 for none. */
  private syncPending = -1
  /** The same figure for a restart that fired on the previous sample. */
  private syncFired = -1
  /** Half that restart's step, and half its slope change, already per sample. */
  private syncStep = 0
  private syncBend = 0

  constructor(sampleRate: number) {
    this.invSampleRate = 1 / sampleRate
    this.nyquist = sampleRate * 0.5
  }

  /**
   * Hard sync, timed between samples.
   *
   * `crossing` says where inside the last sample interval the sync source
   * passed its threshold: 0 at the previous sample, 1 at this one. The
   * restart is placed one whole sample after that crossing rather than at
   * it, because a step needs a residual on both sides of itself and the
   * sample before the crossing has already been handed out. Deferring the
   * restart puts both sides in the future, where they can still be written.
   *
   * That costs a delay of exactly one sample on every sync edge, which is a
   * delay -- the same every cycle, so the rate the sync locks to is
   * untouched. What it replaces was the crossing rounded to the nearest
   * sample, which is jitter: a 165 Hz master is 290.9 samples long, so its
   * edges landed alternately early and late by up to half a sample, and a
   * sync edge that moves about is a sync edge smeared with noise.
   */
  syncAt(crossing: number) {
    this.syncPending = clamp(crossing, 0, 1)
  }

  process(freq: number, wave: Waveform, pulseWidth: number): number {
    // Clamped, because the wrap below moves the phase by one period at most.
    // Above the sample rate a phase step exceeds a whole cycle, one wrap
    // leaves the phase past the end of it, and the remainder accumulates
    // every sample after that -- a saw walks off to 1e8 within a second.
    // There is no waveform left to represent up there anyway.
    //
    // Negative is allowed, and means the wave runs backwards. Nothing asks
    // for that on purpose; linear FM deep enough to push the frequency below
    // zero does, and letting it through is the whole of what "through zero"
    // means. The alternative is to stop at zero, where the pitch folds back
    // up again and a bell turns into a growl at exactly the index that was
    // making it sound like a bell.
    const dt = clamp(freq, -this.nyquist, this.nyquist) * this.invSampleRate
    const pw = clamp(pulseWidth, 0.02, 0.98)

    const resumed = this.syncFired
    this.syncFired = -1

    // Where a restart lands has to be settled before anything is corrected:
    // it decides which of the cycle's own discontinuities still happen.
    const restart = this.syncPending
    this.syncPending = -1
    let step = 0
    let bend = 0
    let preempted = false
    if (restart >= 0) {
      const reached = this.phase + restart * dt
      // The wave gets to the sync point without wrapping on the way, so a
      // wrap correction on this sample would be for an edge the restart
      // arrives in time to cancel.
      preempted = dt >= 0 ? reached < 1 : reached >= 0
      const leaving = wrapPhase(reached)
      // Half the jump, because a residual is scaled for a jump of 2. What the
      // wave is abandoning is what decides it: sync from the end of a saw
      // cycle is barely a step at all, and sync from the middle is a cliff.
      step = (naive(0, wave, pw) - naive(leaving, wave, pw)) / 2
      // The corner it leaves behind, in output per cycle, converted to per
      // sample the way the triangle converts its own corners.
      bend = ((slopeAt(0, wave, pw) - slopeAt(leaving, wave, pw)) / 2) * dt
    }

    // The start-of-cycle residual is a fiction on the sample after a restart
    // -- the phase is near zero because the sync put it there, not because
    // the wave wrapped -- and on a sample whose wrap a restart preempts.
    //
    // A wrap the restart does not preempt, because it happened first inside
    // the same sample, loses the second half of its own residual here. That
    // is the one case this does not get exactly right, and it is a mild one:
    // for the two to collide the wave has to be within a sample of starting
    // over anyway, which is precisely when the step the sync makes is too
    // small to hear.
    const nearWrap = dt >= 0 ? this.phase > 1 - dt : this.phase < -dt
    const wraps = resumed < 0 && !(preempted && nearWrap)

    let out = naive(this.phase, wave, pw)

    switch (wave) {
      case 'sine':
        break

      case 'saw':
        if (wraps) out -= polyBlep(this.phase, dt)
        break

      case 'pulse': {
        // The falling edge sits at `pw`, so its residual is read at the phase
        // measured from there -- `phase - pw`, wrapped. Reading it at
        // `phase + pw` instead happens to agree when the pulse is square and
        // is wrong at every other width, which costs about 8 dB of alias
        // rejection and leaves the falling edge uncorrected.
        let sinceFall = this.phase - pw
        if (sinceFall < 0) sinceFall += 1

        if (wraps) out += polyBlep(this.phase, dt)
        out -= polyBlep(sinceFall, dt)
        break
      }

      case 'tri': {
        // A triangle has no step to correct, but its two corners are slope
        // discontinuities, and polyBLAMP rounds those the way polyBLEP rounds
        // a step. The slope changes by the same amount at each corner, in
        // opposite directions.
        const slope = 2 / (pw * (1 - pw))
        let sinceCorner = this.phase - pw
        if (sinceCorner < 0) sinceCorner += 1

        if (wraps) out += (slope / 2) * dt * polyBlamp(this.phase, dt)
        out -= (slope / 2) * dt * polyBlamp(sinceCorner, dt)
        break
      }
    }

    // A restart's residual spans the sample on either side of it: `resumed`
    // is the far half of the one before, `restart` the near half of this
    // one. Left uncorrected this step is the loudest aliasing the rack makes,
    // because it is a full-scale cliff repeating at a rate that belongs to
    // neither oscillator.
    if (resumed >= 0) {
      const u = 1 - resumed
      out += this.syncStep * blepAfter(u) + this.syncBend * blampAfter(u)
    }
    if (restart >= 0) {
      out += step * blepBefore(-restart) + bend * blampBefore(-restart)
      this.syncStep = step
      this.syncBend = bend
      this.syncFired = restart
      // The new cycle starts `restart` samples after this one, so the next
      // sample is `1 - restart` of a sample into it.
      this.phase = wrapPhase((1 - restart) * dt)
    } else {
      this.phase = wrapPhase(this.phase + dt)
    }

    return out
  }
}

/** The waveform itself, with none of its discontinuities rounded off. */
function naive(phase: number, wave: Waveform, pw: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase)
    case 'saw':
      return 2 * phase - 1
    case 'pulse':
      return phase < pw ? 1 : -1
    case 'tri':
      // Straight from the phase rather than by integrating the pulse: the
      // result is exactly +/-1 wide and exactly zero-mean at every width and
      // every rate. The integrator this replaced had to leak to stay bounded,
      // which erased the shape below about 20 Hz, and still accumulated the
      // pulse's own DC into an offset that grew with frequency -- 261 at
      // 2 kHz with the width at 0.9.
      return phase < pw ? (2 * phase) / pw - 1 : 1 - (2 * (phase - pw)) / (1 - pw)
  }
}

/** Its slope, in output per cycle. Only a sync ever asks off a corner. */
function slopeAt(phase: number, wave: Waveform, pw: number): number {
  switch (wave) {
    case 'sine':
      return 2 * Math.PI * Math.cos(2 * Math.PI * phase)
    case 'saw':
      return 2
    case 'pulse':
      return 0
    case 'tri':
      return phase < pw ? 2 / pw : -2 / (1 - pw)
  }
}

/**
 * Step-discontinuity residual, scaled for a jump of 2 as the phase rises.
 *
 * `t` is how far the phase has come since the discontinuity, always measured
 * forwards. Which side of it the sample sits on is then a matter of which way
 * the wave is travelling: `(t - 1) / dt` is a sample or less in the past when
 * dt is positive, and the same distance in the future when it is negative. A
 * wave running backwards also meets the step the other way round, so the
 * residual comes back negated and no caller has to know.
 */
function polyBlep(t: number, dt: number): number {
  if (dt > 0) {
    if (t < dt) return blepAfter(t / dt)
    if (t > 1 - dt) return blepBefore((t - 1) / dt)
  } else if (dt < 0) {
    if (t < -dt) return -blepBefore(t / dt)
    if (t > 1 + dt) return -blepAfter((t - 1) / dt)
  }
  return 0
}

/**
 * Slope-discontinuity residual: the integral of `polyBlep`, so a corner of
 * slope change `s` is corrected by `(s / 2) * dt * polyBlamp(...)`.
 *
 * Negated for a backwards wave like the step above, and for a reason that is
 * easy to talk yourself out of. A corner is a V either way round -- time
 * reversal does not turn a minimum into a maximum -- so the correction has to
 * come out with the same sign in both directions. The `dt` the callers
 * multiply by has already changed sign by then, so this has to change it
 * back. Leaving it alone pushes the correction the wrong way and roughly
 * doubles the error it was there to remove: a triangle under deep linear FM
 * reached 2.09 out of a designed 1.3.
 */
function polyBlamp(t: number, dt: number): number {
  if (dt > 0) {
    if (t < dt) return blampAfter(t / dt)
    if (t > 1 - dt) return blampBefore((t - 1) / dt)
  } else if (dt < 0) {
    if (t < -dt) return -blampBefore(t / dt)
    if (t > 1 + dt) return -blampAfter((t - 1) / dt)
  }
  return 0
}

/** Back into [0, 1). One step either way is all a clamped rate can need. */
function wrapPhase(phase: number): number {
  if (phase >= 1) return phase - 1
  if (phase < 0) return phase + 1
  return phase
}

/**
 * The residuals themselves, against the distance from the discontinuity in
 * samples. A cycle reads that distance off its own phase, which is what the
 * two above are for; a sync lands between samples and measures it directly.
 *
 * Which side you are on is the caller's to say, not something to infer from
 * the sign: the step residual is discontinuous at zero -- the naive waveform
 * jumps there and this jumps the other way by as much to meet it -- so a
 * distance that comes out as exactly zero, which a wrapped phase of exactly
 * 1.0 does produce, would otherwise take the wrong half and invert the
 * correction. That turned a pulse edge into a sample at full scale twice
 * over.
 */
function blepBefore(u: number): number {
  return u * u + u + u + 1
}

function blepAfter(u: number): number {
  return u + u - u * u - 1
}

function blampBefore(u: number): number {
  const x = u + 1
  return (x * x * x) / 3
}

function blampAfter(u: number): number {
  const x = u - 1
  return (-x * x * x) / 3
}
