import type { CompiledPatch } from '../patch/compile'
import type { Console, Eq3 } from '../song/types'
import { Desk, FULL_ROUTING, Strip, type Routing } from './Console'
import { curveAt, mapValue } from './automation'
import { GraphEngine, type AutoCurve, type EngineEvent } from './GraphEngine'
import { DEFAULT_SEED } from './Rng'
import { emptyBank, type SampleBank } from './samples'
import type { Capturing, Metering } from './modules/types'

/**
 * A rack per track, summed.
 *
 * The whole multi-track arrangement lives here rather than in the worklet, so
 * that it can be run headlessly: the same class plays the song through the
 * speakers, bounces it faster than realtime, and is what a game would load.
 * The worklet is a shell over it.
 *
 * Tracks are entirely independent below this point. Each one is an ordinary
 * `GraphEngine` running its own patch, with its own queue of scheduled notes
 * and its own DSP state, and nothing about one rack can reach another.
 */

export interface TrackSetup {
  id: string
  patch: CompiledPatch
  params?: ArrayLike<number>
}

/** An engine event with the track whose rack it is for. */
export type TrackEvent = EngineEvent & { track: string }

interface Track {
  id: string
  engine: GraphEngine
  /** Its channel on the song's console: EQ, pan, fader and sends. */
  strip: Strip
  /** Whether this track reaches the mix. Muted tracks still run; see below. */
  audible: boolean
}

/**
 * How one track reaches the mix: its fader and whether it is heard at all,
 * then everything else on its channel strip. The strip fields are optional
 * so that a caller that only knows about faders gets a flat, centred strip.
 */
export interface TrackMix {
  gain: number
  /**
   * What `gain` is the track's fader multiplied by: its folder, and a game's
   * own level. Absent is 1. An automated fader is multiplied by it too.
   */
  scale?: number
  audible: boolean
  pan?: number
  eq?: Eq3
  space?: number
  delay?: number
}

/** What the meters on the Mix view read, since the last time they asked. */
export interface MixLevels {
  /** Each track's peak after its strip, by id. */
  tracks: Record<string, number>
  master: number
  /** The master's loudness in LUFS, the last 400 ms and the last 3 s. */
  momentary: number
  shortTerm: number
}

/**
 * Past this a track's output is a fault, not a signal: ten thousand times
 * full scale. Nothing working comes within miles of it.
 */
const BAD = 1e4

/**
 * The track the desk's automation is sent to: no track can have it, since
 * ids are never empty. Its keys are the targets themselves -- `strip/<id>/
 * pan`, `master/level` -- see `song/automation`.
 */
export const DESK = ''

/** A desk control a curve is moving, read from its key once. */
interface DeskAuto {
  key: string
  curve: AutoCurve
  /** The track whose strip it is, or '' for the master and the returns. */
  track: string
  /** For a strip, its field; otherwise `master`, `space` or `delay`. */
  bus: string
  /** The strip's field, or the bus's: `level`, `size` and the like. */
  what: string
}

function readDeskKey(key: string): { track: string; bus: string; what: string } | null {
  const parts = key.split('/')
  if (parts[0] === 'strip' && parts.length === 3) return { track: parts[1], bus: 'strip', what: parts[2] }
  if ((parts[0] === 'master' || parts[0] === 'space' || parts[0] === 'delay') && parts.length === 2) {
    return { track: '', bus: parts[0], what: parts[1] }
  }
  return null
}

/** A strip's settings, written over in place so the desk's automation allocates nothing per block. */
type StripMix = TrackMix & { eq: Eq3 }
const blankStrip = (): StripMix => ({ gain: 1, audible: true, eq: { low: 0, mid: 0, high: 0 } })
function copyStrip(into: StripMix, from: TrackMix | undefined) {
  into.gain = from?.gain ?? 1
  into.scale = from?.scale
  into.audible = from?.audible ?? true
  into.pan = from?.pan
  into.space = from?.space
  into.delay = from?.delay
  into.eq.low = from?.eq?.low ?? 0
  into.eq.mid = from?.eq?.mid ?? 0
  into.eq.high = from?.eq?.high ?? 0
}

export class SongEngine {
  private tracks: Track[] = []
  private byId = new Map<string, Track>()
  private samples: SampleBank = emptyBank()
  private scratchL = new Float32Array(0)
  private scratchR = new Float32Array(0)
  /**
   * The clock every track shares.
   *
   * Held here as well as in each engine because a track added part way
   * through a song has to start counting from where the others already are,
   * not from zero -- otherwise its first scheduled note, stamped in the
   * arrangement's frames, would be thousands of samples in its own past.
   */
  private frame = 0
  /** Whose scopes and meters are reported; the rack on the bench. */
  private watched = ''
  /** The send buses, the shared effects and the master bus. */
  private desk: Desk
  private routing: Routing = FULL_ROUTING
  /** The mix and the desk as the song has them, which the desk's automation is laid over. */
  private baseMix: Readonly<Record<string, TrackMix>> = {}
  private baseConsole: Console | null = null
  /** The desk's automation still to come, oldest first. */
  private deskQueue: (EngineEvent & { kind: 'auto' })[] = []
  private deskAutos = new Map<string, DeskAuto>()
  private deskHeld = new Set<string>()
  /** The strips, or the desk (''), the automation moved last block: put back once it lets go. */
  private deskTouched = new Set<string>()
  /** What this block put back or moved, to send to the strips and the desk. */
  private deskNow = new Set<string>()
  /** What this block's automation moved: next block's `deskTouched`, swapped so neither is made anew. */
  private deskMoved = new Set<string>()
  /** Each strip's settings as this block has them, kept between blocks. */
  private stripScratch = new Map<string, StripMix>()
  private consoleScratch: Console | null = null

  constructor(
    private readonly sampleRate: number,
    tracks: readonly TrackSetup[] = [],
    private seed: number = DEFAULT_SEED,
    samples?: SampleBank,
  ) {
    if (samples) this.samples = samples
    this.desk = new Desk(sampleRate, seed)
    for (const t of tracks) this.setTrack(t.id, t.patch, t.params)
  }

  get currentFrame() {
    return this.frame
  }

  /**
   * How many samples behind the clock the output runs: the master limiter's
   * lookahead, whatever the routing, so a stem lines up with the mix. The
   * same for the speakers, a bounce and a game, since all three run this
   * class -- but a caller that needs a note on exactly its frame in a file
   * (a loop that has to tile) should drop this many samples off the front.
   */
  get latency() {
    return this.desk.latency
  }

  get trackIds() {
    return this.tracks.map((t) => t.id)
  }

  /**
   * Counts every change to which tracks there are and which is watched: what
   * a report laid out in shared memory has to be laid out again for.
   */
  revision = 0

  /**
   * Add a track, or rewire one that is already running.
   *
   * A track that already exists is rebuilt in place, which keeps its DSP
   * state: editing the patch on the bench while the song plays must not reset
   * the filter or cut the envelope, exactly as it does not in a single rack.
   */
  setTrack(id: string, patch: CompiledPatch, params?: ArrayLike<number>) {
    const existing = this.byId.get(id)
    if (existing) {
      existing.engine.rebuild(patch, params)
      return
    }

    this.revision++
    const engine = new GraphEngine(patch, this.sampleRate, params, this.seed, this.samples)
    // Caught up to the others before it renders a sample.
    engine.seek(this.frame)
    const track: Track = { id, engine, strip: new Strip(this.sampleRate), audible: true }
    this.tracks.push(track)
    this.byId.set(id, track)
    if (!this.watched) this.watched = id
  }

  removeTrack(id: string) {
    this.revision++
    this.tracks = this.tracks.filter((t) => t.id !== id)
    this.byId.delete(id)
    if (this.watched === id) this.watched = this.tracks[0]?.id ?? ''
  }

  /**
   * How each track reaches the mix.
   *
   * Solo and mute are already resolved by the caller into one audible flag
   * per track, because what "soloed" means is a question about the song and
   * not about the audio thread.
   */
  setMix(mix: Readonly<Record<string, TrackMix>>) {
    this.baseMix = mix
    for (const track of this.tracks) {
      const m = mix[track.id]
      track.strip.set(m ?? { gain: 1 }, !this.mixed)
      track.audible = m ? m.audible : true
    }
    this.mixed = true
  }
  /** Set once the first mix has arrived, after which strips glide rather than jump. */
  private mixed = false

  /** The song's desk: the shared effects and the master bus. */
  setConsole(console: Console) {
    this.baseConsole = console
    this.desk.set(console)
  }

  /**
   * Which parts of the desk a render goes through. Everything, for the
   * speakers, a bounce and a game; less for a stem, which is the track on its
   * own with as much of its channel as was asked for.
   */
  setRouting(routing: Routing) {
    this.routing = routing
  }

  /** Peaks since the last call, and the master's loudness, for the Mix view's meters. */
  mixLevels(): MixLevels {
    const tracks: Record<string, number> = {}
    for (const t of this.tracks) {
      tracks[t.id] = t.strip.peak
      t.strip.peak = 0
    }
    const master = this.desk.peak
    this.desk.peak = 0
    return {
      tracks,
      master,
      momentary: Math.max(-99, this.desk.loudness.momentary),
      shortTerm: Math.max(-99, this.desk.loudness.shortTerm),
    }
  }

  /** Which track's scopes and meters are worth reporting. */
  watch(id: string) {
    if (id !== this.watched) this.revision++
    this.watched = id
  }

  /**
   * `mixLevels` into a block of floats rather than an object: each track's
   * peak in the order of `trackIds`, then the master's peak, momentary and
   * short-term loudness. Nothing allocated, for a report written to shared
   * memory thirty times a second. Hands back how many were written.
   */
  writeMixLevels(out: Float32Array, at: number): number {
    let k = at
    for (const t of this.tracks) {
      out[k++] = t.strip.peak
      t.strip.peak = 0
    }
    out[k++] = this.desk.peak
    this.desk.peak = 0
    out[k++] = Math.max(-99, this.desk.loudness.momentary)
    out[k++] = Math.max(-99, this.desk.loudness.shortTerm)
    return k - at
  }

  setSamples(samples: SampleBank) {
    this.samples = samples
    for (const t of this.tracks) t.engine.setSamples(samples)
  }

  setSeed(seed: number) {
    this.seed = seed
    for (const t of this.tracks) t.engine.setSeed(seed)
  }

  setParam(trackId: string, index: number, value: number) {
    this.byId.get(trackId)?.engine.setParam(index, value)
  }

  /**
   * Take a knob -- or, on the `DESK` track, a desk control -- from its
   * automation, or give it back: see `GraphEngine.holdKnob`.
   */
  hold(trackId: string, key: string, on: boolean) {
    if (trackId !== DESK) {
      this.byId.get(trackId)?.engine.holdKnob(key, on)
      return
    }
    if (on) this.deskHeld.add(key)
    else this.deskHeld.delete(key)
  }

  /** Every knob and desk control back to where the song has it, and nothing held. */
  clearAutomation() {
    for (const t of this.tracks) t.engine.clearAutomation()
    this.deskQueue.length = 0
    this.deskAutos.clear()
    this.deskHeld.clear()
    this.applyDesk()
  }

  private automateDesk(key: string, curve: AutoCurve | null) {
    if (!curve) {
      this.deskAutos.delete(key)
      return
    }
    const at = readDeskKey(key)
    if (at) this.deskAutos.set(key, { key, curve, ...at })
  }

  /**
   * The desk as the song has it, with whatever automation has hold of it
   * laid over: the strips and the desk it moves, and any it moved last time
   * and has since let go of, put back. Once a render, which live and in a
   * bounce is a block -- and every control here glides, so that is as smooth
   * as turning it.
   */
  private applyDesk() {
    const now = this.deskNow
    const moved = this.deskMoved
    now.clear()
    moved.clear()
    // Everything touched last block starts again from the song's settings,
    // so a control the automation has let go of goes back to them.
    for (const id of this.deskTouched) this.resetDesk(id, now)
    for (const a of this.deskAutos.values()) {
      if (this.deskHeld.has(a.key)) continue
      const v = mapValue(a.curve.map, curveAt(a.curve, this.frame))
      if (a.track) {
        const base = this.baseMix[a.track]
        if (!base) continue
        if (!now.has(a.track)) this.resetDesk(a.track, now)
        moved.add(a.track)
        const m = this.stripScratch.get(a.track)!
        const what = a.what
        if (what === 'gain') m.gain = v * (base.scale ?? 1)
        else if (what === 'pan' || what === 'space' || what === 'delay') m[what] = v
        else if (what === 'high' || what === 'mid' || what === 'low') m.eq[what] = v
        continue
      }
      if (!this.baseConsole) continue
      if (!now.has('')) this.resetDesk('', now)
      moved.add('')
      const c = this.consoleScratch!
      const what = a.what
      if (a.bus === 'master') {
        if (what === 'high' || what === 'mid' || what === 'low') c.master.eq[what] = v
        else if (what === 'level' || what === 'balance') c.master[what] = v
      } else if (a.bus === 'space') {
        if (what === 'size' || what === 'decay' || what === 'damping' || what === 'level') c.space[what] = v
      } else if (a.bus === 'delay') {
        if (what === 'time' || what === 'feedback' || what === 'damping' || what === 'level') c.delay[what] = v
      }
    }
    for (const id of now) {
      if (id) {
        const m = this.stripScratch.get(id)
        if (m) this.byId.get(id)?.strip.set(m)
      } else if (this.consoleScratch) this.desk.set(this.consoleScratch)
    }
    // What was moved is what has to be put back once it is let go of.
    this.deskMoved = this.deskTouched
    this.deskTouched = moved
  }

  /** A strip's settings -- or with '', the desk's -- back to the song's, in the scratch, and marked for this block. */
  private resetDesk(id: string, now: Set<string>) {
    now.add(id)
    if (id) {
      let m = this.stripScratch.get(id)
      if (!m) this.stripScratch.set(id, (m = blankStrip()))
      copyStrip(m, this.baseMix[id])
      return
    }
    if (!this.baseConsole) return
    if (!this.consoleScratch) this.consoleScratch = copyConsole(this.baseConsole)
    else copyConsoleInto(this.consoleScratch, this.baseConsole)
  }

  /** Hear one slot of a track's rack in place of its output, or -1 to stop: see `GraphEngine.listenAt`. */
  listenAt(trackId: string, slot: number) {
    for (const t of this.tracks) t.engine.listenAt(t.id === trackId ? slot : -1)
  }

  setModuleGate(trackId: string, moduleId: string, open: boolean) {
    this.byId.get(trackId)?.engine.setModuleGate(moduleId, open)
  }

  /** An event for one track, at an exact sample of the shared clock. */
  schedule(trackId: string, event: EngineEvent) {
    this.byId.get(trackId)?.engine.schedule(event)
  }

  /**
   * A window of events for any number of tracks, in the order given.
   *
   * Order matters within a track and nowhere else: two events landing on one
   * sample are applied in the order they arrived, which is what keeps a
   * release sorted before the press that follows it.
   */
  scheduleMany(events: readonly TrackEvent[]) {
    for (const e of events) {
      if (e.track === DESK) {
        if (e.kind !== 'auto') continue
        // Oldest first, as a track's queue is kept.
        const q = this.deskQueue
        let i = q.length
        while (i > 0 && q[i - 1].frame > e.frame) i--
        q.splice(i, 0, e)
        continue
      }
      this.byId.get(e.track)?.engine.schedule(e)
    }
  }

  /**
   * Hold every trigger in every rack open. Offline renders of a single sound
   * use it; a song plays notes instead.
   */
  setGate(open: boolean) {
    for (const t of this.tracks) t.engine.setGate(open)
  }

  seek(frame: number) {
    this.frame = frame
    for (const t of this.tracks) t.engine.seek(frame)
    this.deskQueue.length = 0
  }

  clearSchedule() {
    for (const t of this.tracks) t.engine.clearSchedule()
    this.deskQueue.length = 0
  }

  /** Drop every track's queued events from a frame on. See `GraphEngine.dropFrom`. */
  dropFrom(frame: number) {
    for (const t of this.tracks) t.engine.dropFrom(frame)
    const q = this.deskQueue
    let i = q.length
    while (i > 0 && q[i - 1].frame >= frame) i--
    q.length = i
  }

  allNotesOff() {
    for (const t of this.tracks) t.engine.allNotesOff()
  }

  /** Scopes on the watched track, so a rack off the bench costs nothing. */
  get captures(): { id: string; mod: Capturing }[] {
    return this.byId.get(this.watched)?.engine.captures ?? []
  }

  get meters(): { id: string; mod: Metering }[] {
    return this.byId.get(this.watched)?.engine.meters ?? []
  }

  /**
   * Render every track and sum what is audible.
   *
   * A muted track is rendered and then not added, rather than skipped.
   * Skipping would save the only real cost here, but it would also stop that
   * track's clock, drop whatever the transport had already queued against it,
   * and leave its LFOs and delay tails frozen -- so unmuting would drop a
   * note and come back out of phase. Keeping every rack running is worth more
   * than the arithmetic it costs; a track that is genuinely too expensive to
   * keep running is one to freeze rather than to mute.
   */
  render(left: Float32Array, right: Float32Array) {
    const n = left.length
    left.fill(0)
    right.fill(0)

    // Exactly this long, because a track's engine fills whatever it is given.
    // Remade only when the length changes, which live is never.
    if (this.scratchL.length !== n) {
      this.scratchL = new Float32Array(n)
      this.scratchR = new Float32Array(n)
    }
    const sl = this.scratchL
    const sr = this.scratchR

    // The desk's automation, due by the start of this render.
    if (this.deskQueue.length) {
      let k = 0
      while (k < this.deskQueue.length && this.deskQueue[k].frame <= this.frame) {
        const e = this.deskQueue[k++]
        this.automateDesk(e.key, e.curve)
      }
      if (k) this.deskQueue.splice(0, k)
    }
    if (this.deskAutos.size || this.deskTouched.size) this.applyDesk()

    const routing = this.routing
    this.desk.begin(n)
    const spaceBus = this.desk.spaceBus
    const delayBus = this.desk.delayBus

    for (const track of this.tracks) {
      track.engine.render(sl, sr)
      if (!track.audible) continue
      // A stem with none of its channel: the rack, exactly as it left it --
      // bar the same guard as below, since a stem is summed as well.
      if (!routing.strips) {
        for (let i = 0; i < n; i++) {
          const l = sl[i]
          const r = sr[i]
          left[i] += l > -BAD && l < BAD ? l : 0
          right[i] += r > -BAD && r < BAD ? r : 0
        }
        continue
      }

      const s = track.strip
      const eqFlat = s.eq.flat
      const sending = routing.sends && (s.space.target > 0 || s.delay.target > 0 || !s.space.settled || !s.delay.settled)
      let peak = s.peak
      for (let i = 0; i < n; i++) {
        let l = sl[i]
        let r = sr[i]
        // One broken track must not take the song with it. A NaN summed into
        // the mix is NaN on the master, and sent to the Space or the Delay it
        // is inside their feedback for good; a runaway feedback patch at a
        // few thousand times full scale is, to the limiter, the same thing.
        // So anything that is not a number or is wildly past anything a rack
        // makes is dropped here, before it reaches the strip or a send. The
        // negated comparisons are what catch NaN, which fails every one.
        if (!(l > -BAD && l < BAD)) l = 0
        if (!(r > -BAD && r < BAD)) r = 0
        if (!eqFlat) {
          s.eq.process(l, r)
          l = s.eq.l
          r = s.eq.r
        }
        // A rack is stereo, so pan is a balance: turning right takes the left
        // side down and leaves the right where it is.
        const g = s.gain.next()
        const p = s.pan.next()
        l *= g * (p > 0 ? 1 - p : 1)
        r *= g * (p < 0 ? 1 + p : 1)
        left[i] += l
        right[i] += r
        if (sending) {
          // Post-fader, as a send usually is: pulling a track down pulls its
          // reverb down with it.
          const m = (l + r) * 0.5
          spaceBus[i] += m * s.space.next()
          delayBus[i] += m * s.delay.next()
        }
        const a = l > r ? (l > -r ? l : -r) : r > -l ? r : -l
        if (a > peak) peak = a
      }
      s.peak = peak
    }

    this.desk.finish(left, right, n, routing)
    this.frame += n
  }
}

/** A desk's settings, copied deep enough to change one control of. */
function copyConsole(c: Console): Console {
  return {
    master: { ...c.master, eq: { ...c.master.eq } },
    space: { ...c.space },
    delay: { ...c.delay },
  }
}

/** The same, written over a copy already made. */
function copyConsoleInto(into: Console, c: Console) {
  into.master.eq.low = c.master.eq.low
  into.master.eq.mid = c.master.eq.mid
  into.master.eq.high = c.master.eq.high
  into.master.balance = c.master.balance
  into.master.level = c.master.level
  into.master.limiter = c.master.limiter
  into.space.size = c.space.size
  into.space.decay = c.space.decay
  into.space.damping = c.space.damping
  into.space.level = c.space.level
  into.delay.time = c.delay.time
  into.delay.feedback = c.delay.feedback
  into.delay.damping = c.delay.damping
  into.delay.level = c.delay.level
}
