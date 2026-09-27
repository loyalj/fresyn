import type { CompiledPatch } from '../patch/compile'
import type { Console, Eq3 } from '../song/types'
import { Desk, FULL_ROUTING, Strip, type Routing } from './Console'
import { GraphEngine, type EngineEvent } from './GraphEngine'
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

    const engine = new GraphEngine(patch, this.sampleRate, params, this.seed, this.samples)
    // Caught up to the others before it renders a sample.
    engine.seek(this.frame)
    const track: Track = { id, engine, strip: new Strip(this.sampleRate), audible: true }
    this.tracks.push(track)
    this.byId.set(id, track)
    if (!this.watched) this.watched = id
  }

  removeTrack(id: string) {
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
    this.watched = id
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
    for (const e of events) this.byId.get(e.track)?.engine.schedule(e)
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
  }

  clearSchedule() {
    for (const t of this.tracks) t.engine.clearSchedule()
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

    if (this.scratchL.length < n) {
      this.scratchL = new Float32Array(n)
      this.scratchR = new Float32Array(n)
    }
    // Exact-length views, because a track's engine fills whatever it is given
    // and the scratch may be longer than this block.
    const sl = this.scratchL.subarray(0, n)
    const sr = this.scratchR.subarray(0, n)

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
