import type { CompiledPad, CompiledPatch } from '../patch/compile'
import { MODULE_FACTORIES, type DspModule } from './modules'
import { BLOCK, type Capturing, type Metering, type Playable } from './modules/types'
import { DEFAULT_SEED } from './Rng'
import { emptyBank, type SampleBank } from './samples'

/**
 * Something to do to the rack at an exact sample.
 *
 * A note is one event and not a parameter write followed by a gate, because
 * the two would be applied a block apart and the gap is audible. `param` is
 * here for automation, which nothing writes yet; `gate` is how a roll plays
 * the patches that have no keyboard in them -- a coin, a laser -- where the
 * pitch means nothing and only the trigger does.
 */
export type EngineEvent =
  | { frame: number; kind: 'noteOn'; module: string; pitch: number; velocity: number }
  | { frame: number; kind: 'noteOff'; module: string; pitch?: number }
  | { frame: number; kind: 'gate'; module: string; open: boolean }
  | { frame: number; kind: 'param'; index: number; value: number }

/** The most notes a rack sounds at once; the top of the Voices knob. */
export const MAX_VOICES = 8

/** Below this, a released voice counts as having finished: -80 dB. */
const SILENCE = 1e-4
/** And it has to stay there this long, so a note between cycles is not cut. */
const SILENT_FOR = 0.05

/** Ground: the block every unpatched input reads, and nothing ever writes. */
const GROUND = 0

/** What a resting module counts as silence: -120 dB. */
const QUIET = 1e-6
/**
 * How long a module that may rest must be fed nothing and say nothing
 * before it does: long enough that a tail has really died away, not a gap
 * between two notes.
 */
const QUIET_FOR = 0.25

/**
 * Executes a compiled patch on the audio thread.
 *
 * **Blocks.** Every cable is a block of samples, and each module works
 * through a whole block of them in one call. The graph used to be stepped a
 * sample at a time instead -- every module called once per sample -- and
 * that call was most of the cost of the rack: forty kinds of module behind
 * one call site is a call the JIT cannot inline, made 48,000 times a second
 * per module. In a block, each module's loop is its own code, and runs as
 * fast as straight-line arithmetic does.
 *
 * **Feedback.** A modular rack has to be able to patch a module's output back
 * into something upstream, and hear it one sample later rather than one block
 * later -- a block of delay in a loop is a different sound, a comb at 375 Hz.
 * So the modules a feedback cable spans are stepped a sample at a time, as
 * every module used to be, while the rest of the rack runs in blocks. The
 * cable reads a copy of its source one sample behind: see `fbDst`.
 *
 * **The grid.** Blocks are laid on the transport's own frames -- block N is
 * frames 128N to 128N+127 -- whatever lengths a caller renders in. Events
 * split a block where they land, and voices and pads are put to sleep only at
 * the end of one, so how a render is chopped up changes nothing that is
 * heard: a song rendered 37 samples at a time is the same song, to the bit.
 */
export class GraphEngine {
  private paramValues: Float32Array
  private modules: DspModule[] = []
  /** Each module's id, in the same order. */
  private ids: string[] = []
  /** Audio the patch refers to by hash. Empty until something is loaded. */
  private samples: SampleBank = emptyBank()
  /** Modules with a trigger of their own, in patch order. */
  private triggerable: DspModule[] = []
  /** The subset of those a performer plays, which is what a render holds. */
  private played: DspModule[] = []
  /**
   * Modules that record their input for the UI, with the id to report them
   * under. Collected by interface so the engine never names a module type.
   */
  captures: { id: string; mod: Capturing }[] = []
  /** Modules that publish levels for their own panel, with their ids. */
  meters: { id: string; mod: Metering }[] = []
  /**
   * Modules a note can be played on, by id. A map rather than a list because
   * every event names the module it is for.
   */
  private playables = new Map<string, Playable>()
  /**
   * Samples rendered since the transport was last moved.
   *
   * Kept here rather than in the worklet so that an offline bounce and the
   * live rack share one clock. A song rendered faster than realtime has to
   * land its notes on exactly the samples the speakers put them on, and it
   * cannot if the counting happens somewhere only one of them goes.
   */
  private frame = 0
  /** Pending events, soonest first, from `queueHead` on. */
  private queue: EngineEvent[] = []
  private queueHead = 0
  private byId = new Map<string, DspModule>()
  /** Bus slots summed into the speaker pair, split for a tight inner loop. */
  private monL = new Int32Array(0)
  private monR = new Int32Array(0)
  private monSlotL = 0
  private monSlotR = 0
  private renderSlotL = 0
  private renderSlotR = 0
  /**
   * Which pair leaves the graph. The speakers hear the main mixes; an offline
   * render hears the recorder's input instead, which is how a render can be
   * a single channel while the room still hears the whole rack.
   */
  private tap: 'speakers' | 'recorder' = 'speakers'
  private outL = 0
  private outR = 0
  private seed: number
  private readonly ctx: { sampleRate: number }

  // --- buffers ---------------------------------------------------------
  //
  // One block of samples per slot, end to end in a single array, and a view
  // onto each: a module's ports are bound to those views, so a cable is two
  // modules sharing one. A block is indexed by where it sits on the grid, so
  // sample N of the transport is always index N % 128.

  /** Slots, blocks of `BLOCK`, in one array. */
  private buf = new Float32Array(0)
  /** A view per slot onto `buf`. */
  private views: Float32Array[] = []
  /** How many slots there are, including the copies feedback cables read. */
  private slotTotal = 0
  /**
   * Where on the grid the last sample was written: what "the sample before"
   * means for the first sample of the next stretch, which is how a feedback
   * cable, or a module that has been asleep, knows what it last said.
   */
  private lastIndex = BLOCK - 1
  /** The same, as it was when the stretch being rendered began. */
  private before = BLOCK - 1
  /** Where the stretch being rendered began. */
  private stretchFrom = 0
  /**
   * Where on the grid the current block's first stretch began, or -1 before
   * one has: what the voices' silence is counted from.
   */
  private periodFrom = -1

  // --- the schedule ----------------------------------------------------
  //
  // The execution order, cut into steps. Most steps are one module run over
  // the whole stretch; a step that a feedback cable spans is a run of modules
  // stepped together, a sample at a time.

  /** Per step: its first module and one past its last. */
  private stepFrom = new Int32Array(0)
  private stepTo = new Int32Array(0)
  /** Per step: 1 when its modules go a sample at a time. */
  private stepLoop = new Uint8Array(0)
  /**
   * Each feedback cable's copy and what it copies: the slot a module reads
   * and the one it was patched from. The copy is refreshed a sample at a time
   * with its source's previous sample -- the one-sample delay a feedback
   * cable has always had.
   */
  private fbDst = new Int32Array(0)
  private fbSrc = new Int32Array(0)
  /**
   * The whole rack a sample at a time, for a patch the blocks cannot run
   * exactly: a sleeping pad woken through its Trig jack by something that
   * runs after it. Also a check's switch, since stepped the engine renders
   * exactly what a sample-at-a-time rack always did.
   */
  private stepwise = false
  /** Every rack stepped a sample at a time; for checks. See `stepwise`. */
  static forceStepwise = false

  // --- voices ----------------------------------------------------------
  //
  // A chord is several copies of the part of the rack a note passes through,
  // summed where they reach the part every note shares. The compiler marks
  // which modules are which; everything below is how the copies are kept.
  //
  // Voice 0 is the rack as it has always been. Its modules are the ones in
  // `modules` and `byId`, and with the Voices knob at one nothing else is
  // ever woken -- so a single line plays exactly the samples it always did,
  // and every patch saved before chords existed sounds the same.

  /** Per module, in execution order: 1 if it runs once per voice. */
  private polyFlag = new Uint8Array(0)
  /** Per module: its instance for each voice, or empty for a shared one. */
  private voiceMods: DspModule[][] = []
  /**
   * Per module: inputs fed from the shared part of the rack, which each voice
   * is handed a copy of before it runs. Everything else a voice reads, it
   * wrote itself.
   */
  private bcast: Int32Array[] = []
  /** Per module: outputs the shared part reads, which the voices sum into. */
  private sumOuts: Int32Array[] = []
  /** A buffer per voice, so each one's cables carry its own note. */
  private voiceBufs: Float32Array[] = []
  private voiceViews: Float32Array[][] = []
  /**
   * How many voices have been built: as many as the Voices knob has asked
   * for, and never fewer once built. A voice is a copy of every module a note
   * passes through, and a copy of a Delay is two seconds of line, so a rack
   * set to one voice no longer carries seven more nobody can play.
   */
  private built = 1
  /** Per per-voice module: its input slots, for binding a voice built later. */
  private polyInSlots: Int32Array[] = []
  /**
   * Each per-voice module's copies for voices 1 and up, by module id: kept
   * across an edit, and how every copy of one module is gated at once.
   */
  private polyById = new Map<string, DspModule[]>()
  private hasPoly = false
  private rootId = ''
  private rootIndex = -1
  private rootGateSlot = 0
  /** The Gate jack, as it read last sample. */
  private rootGateWas = false
  /**
   * A key held on the panel, or a gate held by a render. With the jack, the
   * two are one hand, exactly as they are one gate on a single keyboard.
   */
  private panelHeld = false
  /** The voice the latest note went to. */
  private newest = 0
  private voicesParam = -1
  private noteParam = -1
  /** The Voices knob as last seen, so a turn of it can be noticed. */
  private voiceCount = 1

  private held = new Uint8Array(MAX_VOICES)
  /** Opened by a hand -- the panel, or the Gate jack -- rather than a note. */
  private byHand = new Uint8Array(MAX_VOICES)
  private active = new Uint8Array(MAX_VOICES)
  private pitchOf = new Float64Array(MAX_VOICES)
  private onAt = new Float64Array(MAX_VOICES)
  private offAt = new Float64Array(MAX_VOICES)
  private silent = new Int32Array(MAX_VOICES)
  /**
   * Where in the block each voice started running -- 0, or the sample a hand
   * on the Gate jack woke it -- and the last sample in the block it was
   * audible at, or -1: what `settleVoices` judges it by.
   */
  private voiceFrom = new Int32Array(MAX_VOICES)
  private loudAt = new Int32Array(MAX_VOICES).fill(-1)
  /**
   * Where a voice's silence was last started over by a press or a release in
   * this block, or -1: before then, however quiet it was does not count.
   */
  private quietFrom = new Int32Array(MAX_VOICES).fill(-1)
  /** Which voices are running, in the order they are processed. */
  private activeList: number[] = []
  /** Orders presses and releases, for choosing which voice to take. */
  private stamp = 0
  private readonly silentFrames: number

  // --- pads -----------------------------------------------------------
  //
  // A Drum Kit's pads are sixteen racks laid into the patch, and a beat
  // plays two or three of them at a time. Running the rest would cost most
  // of a core for silence, so a pad sleeps -- its modules skipped -- from the
  // moment it has been let go of and gone quiet, the same rule a voice
  // finishes by, until a note or a gate wakes it.

  private pads: CompiledPad[] = []
  /** Per module, in execution order: its pad plus one, or 0 for none. */
  private padOf = new Int16Array(0)
  private padAwake = new Uint8Array(0)
  /** A note is holding it, from its press to its release. */
  private padHeld = new Uint8Array(0)
  /** A hand is holding it: its Trigger's own gate, open from the panel or a render. */
  private padGate = new Uint8Array(0)
  private padSilent = new Int32Array(0)
  /**
   * Where in the block each pad is running from: 0 when it was already
   * awake, the sample after the one its Trig jack went high on, or `BLOCK`
   * while it sleeps. Settled once per stretch, by the first of its modules
   * to run; `padSpan` says which stretch that was.
   */
  private padFrom = new Int32Array(0)
  private padSpan = new Int32Array(0)
  /** Per pad: its Trig jack is written before any of its modules run. */
  private padTrigFirst = new Uint8Array(0)
  /** The pad each waking module belongs to, by id. */
  private padByModule = new Map<string, number>()
  /** Counts stretches, so a pad can tell a new one from the one it is in. */
  private spanId = 0

  // --- resting ---------------------------------------------------------
  //
  // An effect fed silence works out silence, sample after sample, on every
  // track with nothing playing -- a reverb, a chorus and a mixer idling on
  // each rack of a song were most of what an idle song cost. A module that
  // may rest (see `DspModule.rests`) and has been fed nothing and said
  // nothing for `QUIET_FOR` is skipped, putting out silence, until the sample
  // something arrives at one of its jacks, which it runs from. It is only put
  // to rest where voices are put to sleep, so this too is the same in any
  // block size.

  /** The shared modules that may rest, by place in the order. */
  private restable = new Int32Array(0)
  /** Per entry in `restable`: how many quiet samples it must count first. */
  private restAfter = new Int32Array(0)
  private readonly restFrames: number

  /** What a track's notes are handed to when the rack has voices. */
  private readonly voicePlayable: Playable = {
    noteOn: (pitch, velocity) => this.voiceOn(pitch, velocity, false),
    noteOff: (pitch) => this.voiceOff(pitch),
  }

  /**
   * `initialParams` must be applied before the modules are prepared, not
   * after. A module reads its parameters once at prepare() to seed its
   * smoothers, so setting them afterwards makes every knob glide from the
   * patch default to its loaded value -- an audible swoop on every patch load.
   */
  constructor(
    compiled: CompiledPatch,
    sampleRate: number,
    initialParams?: ArrayLike<number>,
    seed: number = DEFAULT_SEED,
    samples?: SampleBank,
  ) {
    this.seed = seed
    this.ctx = { sampleRate }
    this.silentFrames = Math.round(sampleRate * SILENT_FOR)
    this.restFrames = Math.round(sampleRate * QUIET_FOR)
    this.paramValues = new Float32Array(compiled.params)
    if (samples) this.samples = samples
    this.apply(compiled, initialParams)
  }

  /**
   * Point the rack at a new set of samples.
   *
   * A file dropped on a panel must reach a running rack without rebuilding
   * it: a rebuild would be audible, and the module that wants the audio is
   * usually the one being listened to. So the bank is replaced and every
   * module's pointer re-resolved -- a walk over a handful of modules, not a
   * lookup per sample.
   */
  setSamples(samples: SampleBank) {
    this.samples = samples
    for (const mod of this.modules) this.resolveSample(mod)
    for (const copies of this.polyById.values()) for (const mod of copies) this.resolveSample(mod)
  }

  private resolveSample(mod: DspModule) {
    mod.sample = mod.sampleId ? (this.samples.get(mod.sampleId) ?? null) : null
  }

  /**
   * Swap in a recompiled patch, keeping the DSP state of every module that
   * survived. Rebuilding from scratch on each edit would reset filter states,
   * restart LFOs and cut off envelopes, so patching a cable while a sound is
   * playing would click and drop out -- the rack has to keep running through
   * an edit the way hardware does.
   */
  rebuild(compiled: CompiledPatch, params?: ArrayLike<number>) {
    this.apply(compiled, params)
  }

  private apply(compiled: CompiledPatch, params?: ArrayLike<number>) {
    const surviving = this.byId

    this.paramValues = new Float32Array(compiled.params)
    if (params) {
      const n = Math.min(params.length, this.paramValues.length)
      for (let i = 0; i < n; i++) this.paramValues[i] = params[i]
    }

    this.monL = Int32Array.from(compiled.monitors, (m) => m.l)
    this.monR = Int32Array.from(compiled.monitors, (m) => m.r)
    this.monSlotL = compiled.monitorSlotL
    this.monSlotR = compiled.monitorSlotR
    this.renderSlotL = compiled.renderSlotL
    this.renderSlotR = compiled.renderSlotR
    this.setTap(this.tap)
    this.modules = []
    this.ids = []
    this.triggerable = []
    this.played = []
    this.captures = []
    this.meters = []
    this.playables.clear()
    const next = new Map<string, DspModule>()
    // Each module's pad, by its place in the compiled list: carried over to
    // its place in ours as it is pushed, in case anything is skipped.
    const padOfCompiled = new Int16Array(compiled.modules.length)
    compiled.pads?.forEach((pad, k) => {
      for (const i of pad.modules) padOfCompiled[i] = k + 1
    })
    const padOf: number[] = []

    for (let index = 0; index < compiled.modules.length; index++) {
      const m = compiled.modules[index]
      const factory = MODULE_FACTORIES[m.type]
      if (!factory) continue // the compiler already warned; stay silent at audio rate

      // Reuse the running instance when the slot still holds the same kind of
      // module, so its internal state carries across the edit.
      const existing = surviving.get(m.id)
      const reused = existing && existing.type === m.type
      const mod = reused ? existing : factory(this.ctx)
      mod.type = m.type

      mod.ins = Int32Array.from(m.ins)
      mod.outs = Int32Array.from(m.outs)
      // A view, not a copy: parameter writes land here without any per-sample
      // message traffic.
      mod.params = this.paramValues.subarray(m.paramBase, m.paramBase + m.paramCount)
      mod.sampleId = m.sample ?? ''
      this.resolveSample(mod)
      // Only a fresh module is prepared; preparing a reused one would reseed
      // its smoothers and undo the point of keeping it. The same goes for its
      // random stream: restarting it on every cable drag would make the noise
      // audibly jump.
      if (!reused) {
        mod.seedFrom(this.seed, m.id)
        mod.prepare()
      }

      this.modules.push(mod)
      this.ids.push(m.id)
      padOf.push(padOfCompiled[index])
      next.set(m.id, mod)
      if (mod.hasTrigger) this.triggerable.push(mod)
      if (mod.isPlayed) this.played.push(mod)
      if (mod.capture) this.captures.push({ id: m.id, mod: mod.capture })
      if (mod.meter) this.meters.push({ id: m.id, mod: mod.meter })
      if (mod.playable) this.playables.set(m.id, mod.playable)
    }

    // Nothing to carry: a module that survived the edit is the same object and
    // still holds its own gate, and a module that has just arrived starts
    // closed. That is the whole of it now that each Trigger is played on its
    // own key -- a new unit inheriting somebody else's held gate is exactly
    // what should not happen.

    this.byId = next
    const inSlots = this.layOut(compiled.slotCount)
    this.applyPads(compiled.pads ?? [], padOf)
    this.applyVoices(compiled, inSlots)
    for (let i = 0; i < this.modules.length; i++) {
      if (!this.polyFlag[i]) this.bind(this.modules[i], inSlots[i], this.views)
    }

    // Everything wakes on an edit, so a module rewired while it rested hears
    // its new cables straight away.
    const restable: number[] = []
    for (let i = 0; i < this.modules.length; i++) {
      const mod = this.modules[i]
      mod.resting = false
      mod.quietRun = 0
      if (mod.rests && !this.polyFlag[i] && !this.padOf[i]) restable.push(i)
    }
    this.restable = Int32Array.from(restable)
    this.restAfter = Int32Array.from(restable, (i) => this.restFrames + Math.round(this.modules[i].memory * this.ctx.sampleRate))
    this.heldWhole = new Uint8Array(this.modules.length)
  }

  /**
   * Cut the execution order into steps, give every feedback cable a copy to
   * read, and size the buffers. Hands back each module's input slots with
   * those copies in place of the cables they stand for.
   */
  private layOut(slotCount: number): Int32Array[] {
    const mods = this.modules
    const n = mods.length
    // Who writes each slot, by place in the order.
    const writer = new Int32Array(slotCount).fill(-1)
    for (let m = 0; m < n; m++) for (const s of mods[m].outs) writer[s] = m

    // A cable is feedback when what it reads runs later than the module
    // reading it, or is the module itself: last sample's value is all there
    // is. Everything between the two ends is stepped together.
    const reach = new Int32Array(n).fill(-1)
    const dst: number[] = []
    const src: number[] = []
    const inSlots: Int32Array[] = []
    let total = slotCount
    for (let m = 0; m < n; m++) {
      const ins = Int32Array.from(mods[m].ins)
      for (let k = 0; k < ins.length; k++) {
        const s = ins[k]
        if (s === GROUND || s >= slotCount || writer[s] < m) continue
        ins[k] = total
        dst.push(total++)
        src.push(s)
        if (writer[s] > reach[m]) reach[m] = writer[s]
      }
      inSlots.push(ins)
    }
    this.fbDst = Int32Array.from(dst)
    this.fbSrc = Int32Array.from(src)

    const from: number[] = []
    const to: number[] = []
    const loop: number[] = []
    for (let m = 0; m < n; ) {
      if (reach[m] < m) {
        from.push(m)
        to.push(m + 1)
        loop.push(0)
        m++
        continue
      }
      // From the module reading the cable to the one writing it, grown until
      // nothing inside reaches past the end.
      let end = reach[m] + 1
      for (let k = m; k < end; k++) if (reach[k] + 1 > end) end = reach[k] + 1
      from.push(m)
      to.push(end)
      loop.push(1)
      m = end
    }
    this.stepFrom = Int32Array.from(from)
    this.stepTo = Int32Array.from(to)
    this.stepLoop = Uint8Array.from(loop)

    if (total !== this.slotTotal) {
      // New slots start from silence, as a fresh slot array always did.
      this.slotTotal = total
      this.buf = new Float32Array(total * BLOCK)
      this.views = viewsOf(this.buf, total)
      this.voiceBufs = []
      this.voiceViews = []
    }
    return inSlots
  }

  /** Point a module's ports at a set of blocks. */
  private bind(mod: DspModule, inSlots: Int32Array, views: Float32Array[]) {
    mod.inputs = Array.from(inSlots, (s) => views[s])
    mod.outputs = Array.from(mod.outs, (s) => views[s])
  }

  /**
   * Every pad starts awake after an edit: one that was sounding carries on,
   * and one that was not falls asleep again a moment later.
   */
  private applyPads(pads: CompiledPad[], padOf: number[]) {
    this.pads = pads
    this.padOf = Int16Array.from(padOf)
    this.padAwake = new Uint8Array(pads.length).fill(1)
    this.padHeld = new Uint8Array(pads.length)
    this.padGate = new Uint8Array(pads.length)
    this.padSilent = new Int32Array(pads.length)
    this.padFrom = new Int32Array(pads.length)
    this.padSpan = new Int32Array(pads.length).fill(-1)
    this.padTrigFirst = new Uint8Array(pads.length)
    this.padByModule.clear()
    pads.forEach((pad, k) => {
      for (const id of pad.wake) this.padByModule.set(id, k)
    })

    // A pad can wake part way through a block only if its Trig jack has been
    // written by the time its first module runs, which it is whenever what
    // feeds the jack runs earlier -- as it does unless something in the pad
    // feeds back into what triggers it. Otherwise the rack goes a sample at a
    // time, which is how every rack used to go.
    this.stepwise = GraphEngine.forceStepwise
    for (let k = 0; k < pads.length; k++) {
      const trig = pads[k].trig
      if (trig === GROUND) continue
      let first = this.modules.length
      for (let m = 0; m < this.modules.length; m++) {
        if (this.padOf[m] === k + 1) {
          first = m
          break
        }
      }
      let writer = -1
      for (let m = 0; m < this.modules.length; m++) if (this.modules[m].outs.includes(trig)) writer = m
      if (writer < first) this.padTrigFirst[k] = 1
      else this.stepwise = true
    }
  }

  private wakePad(k: number) {
    this.padAwake[k] = 1
    this.padSilent[k] = 0
  }

  /**
   * Once a block: a pad whose Trigger a hand is holding -- the panel, or a
   * render holding every played gate -- is awake and stays so.
   */
  private holdPads() {
    for (let k = 0; k < this.pads.length; k++) {
      let open = 0
      for (const id of this.pads[k].wake) if (this.byId.get(id)?.gateOpen) open = 1
      this.padGate[k] = open
      if (open) this.wakePad(k)
    }
  }

  /**
   * Where pad `k` runs from in the stretch `from` to `to`, worked out the
   * first time one of its modules asks.
   *
   * A sleeping pad is woken by its Trig jack going high: it runs from the
   * sample after, exactly as when the whole rack went a sample at a time and
   * a pad was only woken once the sample it was struck on had finished.
   */
  private padStart(k: number, from: number, to: number): number {
    if (this.padSpan[k] === this.spanId) return this.padFrom[k]
    this.padSpan[k] = this.spanId
    let start = from
    if (!this.padAwake[k]) {
      start = BLOCK
      const trig = this.pads[k].trig
      if (trig !== GROUND && this.padTrigFirst[k]) {
        const t = this.views[trig]
        for (let i = from; i < to; i++) {
          if (t[i] > 0.5) {
            this.wakePad(k)
            start = i + 1
            break
          }
        }
      }
    }
    this.padFrom[k] = start
    return start
  }

  /**
   * At the end of each block (each sample, stepped): put to sleep a pad that
   * has been let go of and silent for long enough -- its returns zeroed on
   * the way, so the kit does not go on hearing the last thing it said -- and
   * wake one whose Trig jack went high while it slept, where it could not be
   * woken on the sample it was struck. That is only ever a rack going a
   * sample at a time, so `from` to `to` is the one sample.
   */
  private settlePads(from: number, to: number) {
    for (let k = 0; k < this.pads.length; k++) {
      const pad = this.pads[k]
      if (!this.padAwake[k]) {
        if (pad.trig !== GROUND && !this.padTrigFirst[k]) {
          const trig = this.views[pad.trig]
          for (let i = from; i < to; i++) {
            if (trig[i] > 0.5) {
              this.wakePad(k)
              break
            }
          }
        }
        continue
      }
      if (this.padSilent[k] >= this.silentFrames) {
        this.padAwake[k] = 0
        // What it said last is what the kit will hear while it sleeps.
        if (pad.retL) this.views[pad.retL][to - 1] = 0
        if (pad.retR) this.views[pad.retR][to - 1] = 0
      }
    }
  }

  /**
   * Listen at the speakers or at the recorder. Survives a rebuild, so an
   * offline render set to `recorder` stays there across a re-patch.
   */
  setTap(which: 'speakers' | 'recorder') {
    this.tap = which
    this.outL = which === 'recorder' ? this.renderSlotL : this.monSlotL
    this.outR = which === 'recorder' ? this.renderSlotR : this.monSlotR
  }

  /**
   * Restart every module's random stream from a new seed. Used per variation
   * in a render batch; a live rack leaves its streams running.
   */
  setSeed(seed: number) {
    this.seed = seed
    for (const [id, mod] of this.byId) mod.seedFrom(seed, id)
    for (const [id, copies] of this.polyById) {
      copies.forEach((mod, i) => mod.seedFrom(seed, voiceKey(id, i + 1)))
    }
  }

  setParam(index: number, value: number) {
    if (index >= 0 && index < this.paramValues.length) this.paramValues[index] = value
  }

  /**
   * Every module with a trigger at once, whether or not a key could reach it.
   *
   * Not what a render wants -- see `setPlayed` -- because holding an
   * oscillator's own gate open stops anything else being able to fire it. It
   * is here for rigs that drive a single module directly and need its trigger
   * held without patching one in.
   */
  setGate(open: boolean) {
    for (const mod of this.triggerable) this.gateModule(mod, open)
  }

  /**
   * Hold down everything a pair of hands would, which is what a render is.
   *
   * Only the Trigger and the Keyboard. Everything else in a patch is fired
   * down a cable from one of them, and pinning those open instead would make
   * a rendered take sound nothing like the rack does: an oscillator reads its
   * own gate as open OR the jack, so a transport that held it could never let
   * a clock retrigger it.
   */
  setPlayed(open: boolean) {
    for (const mod of this.played) this.gateModule(mod, open)
  }

  /** One module, by its key or its panel button. */
  setModuleGate(id: string, open: boolean) {
    const mod = this.byId.get(id)
    if (mod?.hasTrigger) this.gateModule(mod, open)
  }

  /**
   * A module's gate, and the same gate on every voice's copy of it -- except
   * on the keyboard a rack with voices is played from, where a gate is a hand
   * on the keys and is given a voice of its own.
   */
  private gateModule(mod: DspModule, open: boolean) {
    if (this.hasPoly && mod === this.voiceMods[this.rootIndex][0]) {
      this.handGate(open)
      return
    }
    mod.gateOpen = open
    const copies = this.polyById.get(this.idOf(mod))
    if (copies) for (const c of copies) c.gateOpen = open
  }

  private idOf(mod: DspModule): string {
    for (const [id, m] of this.byId) if (m === mod) return id
    return ''
  }

  /**
   * Where the transport has reached, in samples. The playhead is drawn from
   * this, and the scheduler uses it to know how far ahead it has filled.
   */
  get currentFrame() {
    return this.frame
  }

  /**
   * Queue something to happen at an exact sample.
   *
   * Frames are absolute, counted from wherever `seek` last put the clock, so
   * a caller works in one timeline and never has to know how the buffer is
   * blocked up.
   */
  schedule(event: EngineEvent) {
    const q = this.queue
    // Walked back from the end rather than sorted: a transport hands over a
    // window of events oldest first, so this almost always appends without
    // moving anything, and stays correct when something arrives out of turn.
    let i = q.length
    while (i > this.queueHead && q[i - 1].frame > event.frame) i--
    if (i === q.length) q.push(event)
    else q.splice(i, 0, event)
  }

  /** Move the clock and drop anything queued against the old position. */
  seek(frame: number) {
    this.frame = frame
    this.clearSchedule()
  }

  /**
   * Drop everything queued, leaving the clock where it is.
   *
   * What a transport needs when the song under it changed: the events already
   * handed over describe an arrangement that no longer exists, and the clock
   * is the one thing that must not move, because the speakers are in the
   * middle of it.
   */
  clearSchedule() {
    this.queue.length = 0
    this.queueHead = 0
  }

  /**
   * Drop what is queued from a frame on, keeping what comes before it. What
   * a change of course needs: the lookahead has already been handed over,
   * and the part of it past the turning point is no longer what will play.
   */
  dropFrom(frame: number) {
    const q = this.queue
    let i = q.length
    while (i > this.queueHead && q[i - 1].frame >= frame) i--
    q.length = i
  }

  /**
   * Release every note being held.
   *
   * What a transport stop needs: the queue can be emptied, but a note that
   * was already sounding has nothing left to close it, and the rack would
   * drone until something else happened to open and shut the same gate.
   */
  allNotesOff() {
    for (const p of this.playables.values()) p.noteOff()
    this.padHeld.fill(0)
  }

  // --- voices ----------------------------------------------------------

  /**
   * Build the voices for a freshly compiled patch.
   *
   * Instances are kept across an edit exactly as the rack's own are, voice
   * by voice, so re-patching a cable while a chord rings does not cut it.
   */
  private applyVoices(compiled: CompiledPatch, inSlots: Int32Array[]) {
    const mods = this.modules
    const n = mods.length
    const info = compiled.voices
    const rootId = info?.root ?? ''
    if (rootId !== this.rootId) this.resetVoices()
    this.rootId = rootId

    this.polyFlag = new Uint8Array(n)
    this.voiceMods = []
    this.bcast = []
    this.sumOuts = []
    this.rootIndex = -1
    this.hasPoly = false
    const previous = this.polyById
    this.polyById = new Map()

    const polyIds = new Set(compiled.modules.filter((m) => m.poly).map((m) => m.id))
    // A feedback cable's copy counts as whatever it copies.
    const original = new Map<number, number>()
    for (let f = 0; f < this.fbDst.length; f++) original.set(this.fbDst[f], this.fbSrc[f])
    const origin = (s: number) => original.get(s) ?? s

    const polyOut = new Set<number>()
    for (let i = 0; i < n; i++) {
      if (!polyIds.has(this.ids[i])) continue
      this.polyFlag[i] = 1
      this.hasPoly = true
      for (const s of mods[i].outs) polyOut.add(s)
    }

    // What the shared part of the rack reads: its modules' inputs, the
    // speakers and the recorder.
    const sharedReads = new Set<number>([compiled.renderSlotL, compiled.renderSlotR])
    for (const m of compiled.monitors) {
      sharedReads.add(m.l)
      sharedReads.add(m.r)
    }
    for (let i = 0; i < n; i++) if (!this.polyFlag[i]) for (const s of inSlots[i]) sharedReads.add(origin(s))

    // The copies the knob asks for now, and any already built.
    const raw = info && info.voicesParam >= 0 ? this.paramValues[info.voicesParam] : 1
    const built = Math.max(this.built, Math.max(1, Math.min(MAX_VOICES, Math.round(raw) || 1)))
    this.built = built
    if (this.hasPoly) this.voiceBuffers(built)
    this.polyInSlots = inSlots

    for (let i = 0; i < n; i++) {
      if (!this.polyFlag[i]) {
        this.voiceMods.push([])
        this.bcast.push(new Int32Array(0))
        this.sumOuts.push(new Int32Array(0))
        continue
      }

      const first = mods[i]
      const id = this.ids[i]
      const kept = previous.get(id) ?? []
      const copies: DspModule[] = []
      for (let v = 1; v < built; v++) {
        const existing = kept[v - 1]
        copies.push(existing && existing.type === first.type ? this.voiceCopy(first, existing) : this.voiceCopy(first, null, id, v))
      }
      const insts = [first, ...copies]
      insts.forEach((mod, v) => this.bind(mod, inSlots[i], this.voiceViews[v]))
      this.voiceMods.push(insts)
      this.polyById.set(id, copies)

      this.bcast.push(Int32Array.from(new Set([...inSlots[i]].filter((s) => s !== GROUND && !polyOut.has(origin(s))))))
      this.sumOuts.push(Int32Array.from([...first.outs].filter((s) => sharedReads.has(s))))

      if (id === rootId) this.rootIndex = i
      // A meter on a module that is copied per voice reads the loudest of
      // them, so the panel shows the chord rather than whichever note
      // happened to land on voice 0.
      if (first.meter) {
        const at = this.meters.findIndex((x) => x.id === id)
        if (at >= 0) this.meters[at] = { id, mod: new VoiceMeter(insts) }
      }
    }

    if (!this.hasPoly || this.rootIndex < 0) {
      this.hasPoly = false
      // Nothing runs per voice after all, so each runs as the rack's own.
      this.polyFlag.fill(0)
      return
    }

    const gate = info!.gateSlot
    this.rootGateSlot = polyOut.has(gate) ? 0 : gate
    this.voicesParam = info!.voicesParam
    this.noteParam = info!.noteParam
    this.playables.set(rootId, this.voicePlayable)
    // Zeroed so the next look at the knob sets every voice's flags afresh.
    this.voiceCount = 0
    this.syncVoices()
  }

  /**
   * A voice's copy of `first`: `kept` rewired to match, or a new one, seeded
   * and prepared as voice `v`.
   */
  private voiceCopy(first: DspModule, kept: DspModule | null, id = '', v = 0): DspModule {
    const mod = kept ?? MODULE_FACTORIES[first.type](this.ctx)
    mod.type = first.type
    mod.ins = first.ins
    mod.outs = first.outs
    mod.params = first.params
    mod.sampleId = first.sampleId
    mod.sample = first.sample
    if (!kept) {
      mod.seedFrom(this.seed, voiceKey(id, v))
      mod.prepare()
    }
    return mod
  }

  /** A buffer for each of the first `n` voices. */
  private voiceBuffers(n: number) {
    while (this.voiceBufs.length < n) {
      const buf = new Float32Array(this.slotTotal * BLOCK)
      this.voiceBufs.push(buf)
      this.voiceViews.push(viewsOf(buf, this.slotTotal))
    }
  }

  /**
   * Build voices up to `n`, for a Voices knob turned past what has been
   * built. Each is a copy of every per-voice module, prepared at the knobs
   * as they are now and bound to a buffer of its own.
   */
  private buildVoices(n: number) {
    if (n <= this.built) return
    this.voiceBuffers(n)
    for (let i = 0; i < this.modules.length; i++) {
      if (!this.polyFlag[i]) continue
      const insts = this.voiceMods[i]
      const copies = this.polyById.get(this.ids[i])!
      for (let v = this.built; v < n; v++) {
        const mod = this.voiceCopy(insts[0], null, this.ids[i], v)
        this.bind(mod, this.polyInSlots[i], this.voiceViews[v])
        insts.push(mod)
        copies.push(mod)
      }
    }
    this.built = n
  }

  /** Every voice silent and waiting, as a rack with a new keyboard starts. */
  private resetVoices() {
    this.held.fill(0)
    this.byHand.fill(0)
    this.active.fill(0)
    this.activeList.length = 0
    this.rootGateWas = false
    this.panelHeld = false
    this.newest = 0
  }

  private keysOf(v: number): Playable {
    return this.voiceMods[this.rootIndex][v].playable!
  }

  /**
   * Catch up with the Voices knob.
   *
   * At one, voice 0 runs all the time and is played exactly as the keyboard
   * always was. Above one, voices wake for a note and sleep once they have
   * gone quiet, so an eight-voice rack playing one note costs one voice.
   */
  private syncVoices() {
    const raw = this.voicesParam >= 0 ? this.paramValues[this.voicesParam] : 1
    const count = Math.max(1, Math.min(MAX_VOICES, Math.round(raw)))
    if (count === this.voiceCount) return
    this.voiceCount = count
    this.buildVoices(count)

    const mono = count === 1
    for (let v = 0; v < this.built; v++) this.keysOf(v).voiced = !mono

    for (let v = 0; v < MAX_VOICES; v++) {
      // Notes on voices the knob no longer reaches are let go, and ring out.
      if (this.held[v] && (mono ? v > 0 : v >= count)) this.release(v, this.frame % BLOCK)
    }
    if (mono) {
      this.wake(0, this.frame % BLOCK)
      this.newest = 0
    } else if (this.active[0] && !this.held[0]) this.offAt[0] = ++this.stamp
  }

  /** Voice `v` running from sample `at` of this block, if it was not already. */
  private wake(v: number, at: number) {
    this.quiet(v, at)
    if (this.active[v]) return
    this.active[v] = 1
    this.voiceFrom[v] = at
    this.activeList.push(v)
  }

  /** Voice `v`'s silence counted afresh from sample `at`. */
  private quiet(v: number, at: number) {
    this.silent[v] = 0
    this.loudAt[v] = -1
    this.quietFrom[v] = at
  }

  private release(v: number, at: number) {
    this.keysOf(v).noteOff()
    this.held[v] = 0
    this.byHand[v] = 0
    this.offAt[v] = ++this.stamp
    this.quiet(v, at)
  }

  /**
   * Which voice a new note takes: one that is asleep, else the one that let
   * go longest ago, else the one held longest. The oldest each time, so
   * consecutive notes go round the voices and a release tail is left to
   * finish rather than being taken by the very next note.
   */
  private pick(): number {
    const count = this.voiceCount
    let best = -1
    let bestAt = Infinity
    for (let v = 0; v < count; v++) {
      if (!this.active[v] && this.offAt[v] < bestAt) {
        best = v
        bestAt = this.offAt[v]
      }
    }
    if (best >= 0) return best
    for (let v = 0; v < count; v++) {
      if (!this.held[v] && this.offAt[v] < bestAt) {
        best = v
        bestAt = this.offAt[v]
      }
    }
    if (best >= 0) return best
    for (let v = 0; v < count; v++) {
      if (this.onAt[v] < bestAt) {
        best = v
        bestAt = this.onAt[v]
      }
    }
    return best
  }

  private voiceOn(pitch: number, velocity: number, hand: boolean, at = this.frame % BLOCK) {
    this.syncVoices()
    if (this.voiceCount === 1) {
      this.keysOf(0).noteOn(pitch, velocity)
      this.held[0] = 1
      return
    }
    const v = this.pick()
    this.keysOf(v).noteOn(pitch, velocity)
    this.held[v] = 1
    this.byHand[v] = hand ? 1 : 0
    this.pitchOf[v] = pitch
    this.onAt[v] = ++this.stamp
    this.newest = v
    this.wake(v, at)
  }

  /**
   * Let go of a note: the longest-held voice playing that pitch, or every
   * held voice when no pitch is given -- which is what stopping the
   * transport asks for.
   */
  private voiceOff(pitch?: number) {
    this.syncVoices()
    if (this.voiceCount === 1) {
      this.keysOf(0).noteOff()
      this.held[0] = 0
      return
    }
    const at = this.frame % BLOCK
    if (pitch === undefined) {
      for (let v = 0; v < MAX_VOICES; v++) if (this.held[v]) this.release(v, at)
      return
    }
    let best = -1
    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.held[v] && !this.byHand[v] && this.pitchOf[v] === pitch) {
        if (best < 0 || this.onAt[v] < this.onAt[best]) best = v
      }
    }
    if (best >= 0) this.release(best, at)
  }

  /**
   * A key on the panel, or a render holding the keyboard down.
   *
   * With one voice that is the keyboard's own gate, as it always was. With
   * more, a press is a note at the key last chosen on the panel -- and a
   * press while one is already held lets go of it first, so dragging across
   * the keys plays each in turn rather than piling them up.
   */
  private handGate(open: boolean) {
    this.syncVoices()
    this.panelHeld = open
    if (this.voiceCount === 1) {
      this.voiceMods[this.rootIndex][0].gateOpen = open
      return
    }
    if (open) this.handPress(this.frame % BLOCK)
    else if (!this.rootGateWas) this.handRelease(this.frame % BLOCK)
  }

  private handPress(at: number) {
    this.handRelease(at)
    const note = this.noteParam >= 0 ? this.paramValues[this.noteParam] : 0
    this.voiceOn(note, 1, true, at)
  }

  private handRelease(at: number) {
    for (let v = 0; v < MAX_VOICES; v++) if (this.held[v] && this.byHand[v]) this.release(v, at)
  }

  /** Run one per-voice module over `from` to `to`, on every voice that is awake. */
  private runPoly(m: number, from: number, to: number) {
    if (m === this.rootIndex) {
      this.runRoot(from, to)
      return
    }
    const insts = this.voiceMods[m]
    const bc = this.bcast[m]
    const so = this.sumOuts[m]
    const list = this.activeList
    const voices = list.length
    const vviews = this.voiceViews
    const views = this.views

    for (let k = 0; k < voices; k++) {
      const v = list[k]
      const start = this.voiceFrom[v] > from ? this.voiceFrom[v] : from
      if (start >= to) continue
      const vv = vviews[v]
      for (let j = 0; j < bc.length; j++) copy(views[bc[j]], vv[bc[j]], start, to)
      insts[v].processBlock(start, to)
    }

    // Summed where the shared part reads it, and measured on the way: a voice
    // is finished when nothing it sends is audible.
    const loudAt = this.loudAt
    const voiceFrom = this.voiceFrom
    for (let j = 0; j < so.length; j++) {
      const s = so[j]
      const out = views[s]
      for (let i = from; i < to; i++) {
        let acc = 0
        for (let k = 0; k < voices; k++) {
          const v = list[k]
          if (i < voiceFrom[v]) continue
          const x = vviews[v][s][i]
          acc += x
          if (x >= SILENCE || x <= -SILENCE) loudAt[v] = i
        }
        out[i] = acc
      }
    }
  }

  /**
   * The keyboard's voices, stopping at each change on its Gate jack.
   *
   * The jack is heard here rather than by each voice (see `voiced`), and a
   * change on it is a hand pressing or letting go -- a voice woken or
   * released on that very sample. So the voices run up to it, the hand acts,
   * and they carry on from there.
   */
  private runRoot(from: number, to: number) {
    const gateSlot = this.rootGateSlot
    const gate = gateSlot !== GROUND ? this.views[gateSlot] : null
    let at = from
    if (gate) {
      for (let i = from; i < to; i++) {
        // The jack and the panel are one hand, so either one alone holds it.
        const g = gate[i] > 0.5
        if (g === this.rootGateWas) continue
        this.rootGateWas = g
        if (this.voiceCount > 1 && !this.panelHeld) {
          this.runRootVoices(at, i)
          at = i
          if (g) this.handPress(i)
          else this.handRelease(i)
        }
      }
    }
    this.runRootVoices(at, to)
  }

  private runRootVoices(from: number, to: number) {
    if (from >= to) return
    const insts = this.voiceMods[this.rootIndex]
    const bc = this.bcast[this.rootIndex]
    const list = this.activeList
    const vviews = this.voiceViews
    const views = this.views
    for (let k = 0; k < list.length; k++) {
      const v = list[k]
      const start = this.voiceFrom[v] > from ? this.voiceFrom[v] : from
      if (start >= to) continue
      const vv = vviews[v]
      for (let j = 0; j < bc.length; j++) copy(views[bc[j]], vv[bc[j]], start, to)
      insts[v].processBlock(start, to)
    }
    // The keyboard's own outputs are the newest note, as a single keyboard's
    // are: a pitch summed across a chord is no pitch at all. They are not
    // what decides a voice has finished, either, since a pitch never falls
    // silent -- the sound downstream of it does.
    const so = this.sumOuts[this.rootIndex]
    const newest = vviews[this.newest]
    for (let j = 0; j < so.length; j++) copy(newest[so[j]], views[so[j]], from, to)
  }

  /**
   * At the end of each block and before each event (each sample, stepped):
   * put to sleep every released voice that has gone quiet since `from`.
   */
  private settleVoices(from: number, to: number) {
    const list = this.activeList
    let kept = 0
    for (let k = 0; k < list.length; k++) {
      const v = list[k]
      const loudAt = this.loudAt[v]
      const quietFrom = this.quietFrom[v]
      const start = this.voiceFrom[v] > from ? this.voiceFrom[v] : from
      this.loudAt[v] = -1
      this.quietFrom[v] = -1
      this.voiceFrom[v] = 0
      if (this.held[v] || (v === 0 && this.voiceCount === 1)) {
        list[kept++] = v
        continue
      }
      if (loudAt >= 0) this.silent[v] = to - 1 - loudAt
      else if (quietFrom >= 0) this.silent[v] = to - quietFrom
      else this.silent[v] += to - start
      if (this.silent[v] >= this.silentFrames) this.active[v] = 0
      else list[kept++] = v
    }
    list.length = kept
  }

  private fire(event: EngineEvent) {
    switch (event.kind) {
      case 'noteOn': {
        // A module that has since been deleted is a silent no-op rather than
        // an error: a patch can be edited while the song is playing, and the
        // events already queued against it are simply past.
        this.playables.get(event.module)?.noteOn(event.pitch, event.velocity)
        const pad = this.padByModule.get(event.module)
        if (pad !== undefined) {
          this.wakePad(pad)
          this.padHeld[pad] = 1
        }
        break
      }
      case 'noteOff': {
        this.playables.get(event.module)?.noteOff(event.pitch)
        const pad = this.padByModule.get(event.module)
        if (pad !== undefined) this.padHeld[pad] = 0
        break
      }
      case 'gate':
        this.setModuleGate(event.module, event.open)
        break
      case 'param':
        this.setParam(event.index, event.value)
        break
    }
  }

  /**
   * Fill a buffer, stopping at each queued event to apply it.
   *
   * The split is what makes a note land on its own sample instead of on the
   * next block boundary. A rack with nothing sequencing it has an empty queue
   * and takes each block whole.
   */
  render(left: Float32Array, right: Float32Array) {
    const total = left.length
    const queue = this.queue
    let at = 0
    // Once a call: the knob is read here rather than per sample.
    if (this.hasPoly) this.syncVoices()
    if (this.pads.length) this.holdPads()

    while (at < total) {
      // Everything due, applied before a single sample of the stretch is
      // computed -- so an event stamped at frame N is heard from frame N.
      while (this.queueHead < queue.length && queue[this.queueHead].frame <= this.frame) {
        this.fire(queue[this.queueHead++])
      }
      if (this.queueHead === queue.length) {
        queue.length = 0
        this.queueHead = 0
      } else if (this.queueHead > 256) {
        queue.splice(0, this.queueHead)
        this.queueHead = 0
      }

      // To the next event, the end of the buffer or the end of the block on
      // the grid, whichever is soonest.
      const index = this.frame % BLOCK
      let span = BLOCK - index
      // Voices and pads are settled at the end of a block and before an
      // event, never merely where a buffer ends: an event is on the same
      // frame however the render is chopped up, so a note finds the same
      // voices asleep in any block size -- and the one it takes is the one it
      // always took, not whichever the end of a block happened to leave awake.
      let settle = true
      if (this.queueHead < queue.length) {
        // Every remaining event is strictly ahead of the clock, the loop above
        // having taken the rest, so this is at least one sample.
        const ahead = queue[this.queueHead].frame - this.frame
        if (ahead < span) span = ahead
      }
      if (total - at < span) {
        span = total - at
        settle = index + span === BLOCK
      }
      this.renderSpan(index, index + span, settle)

      const outL = this.views[this.outL]
      const outR = this.views[this.outR]
      for (let i = 0; i < span; i++) {
        left[at + i] = outL[index + i]
        right[at + i] = outR[index + i]
      }
      at += span
    }
  }

  /** Samples `from` to `to` of the current block, through every module. */
  private renderSpan(from: number, to: number, settle: boolean) {
    if (this.stepwise) {
      for (let i = from; i < to; i++) this.renderStretch(i, i + 1, true)
    } else {
      this.renderStretch(from, to, settle)
    }
  }

  private renderStretch(from: number, to: number, settle: boolean) {
    this.spanId++
    this.stretchFrom = from
    this.before = this.lastIndex
    if (this.periodFrom < 0) this.periodFrom = from
    const stepFrom = this.stepFrom
    const stepTo = this.stepTo
    const loop = this.stepLoop
    for (let s = 0; s < stepFrom.length; s++) {
      if (!loop[s]) {
        this.runModule(stepFrom[s], from, to)
        continue
      }
      // A feedback loop: its modules a sample at a time, each cable's copy
      // brought up to its source's previous sample first.
      for (let i = from; i < to; i++) {
        this.carryFeedback(i)
        for (let m = stepFrom[s]; m < stepTo[s]; m++) this.runModule(m, i, i + 1)
      }
    }

    // Every main mix lands in the speaker pair. Summed here rather than by
    // a module, because which buses are main mixes is a property of the
    // wiring and not of anything in the rack.
    const views = this.views
    const monL = this.monL
    const monR = this.monR
    const buses = monL.length
    const speakL = views[this.monSlotL]
    const speakR = views[this.monSlotR]
    for (let i = from; i < to; i++) {
      let l = 0
      let r = 0
      for (let b = 0; b < buses; b++) {
        l += views[monL[b]][i]
        r += views[monR[b]][i]
      }
      speakL[i] = l
      speakR[i] = r
    }

    // Pads are judged sample by sample as they go, and voices keep a note of
    // the last sample they were heard at; either is put to sleep only at the
    // end of the block.
    if (this.pads.length) this.countPads(from, to)
    if (settle) {
      if (this.restable.length) this.settleRest()
      if (this.hasPoly) this.settleVoices(this.periodFrom, to)
      if (this.pads.length) this.settlePads(from, to)
      this.periodFrom = -1
    }
    this.lastIndex = to - 1
    this.frame += to - from
  }

  /** How long each pad has been silent, carried on through `from` to `to`. */
  private countPads(from: number, to: number) {
    for (let k = 0; k < this.pads.length; k++) {
      if (!this.padAwake[k]) continue
      const pad = this.pads[k]
      if (this.padHeld[k] || this.padGate[k]) {
        this.padSilent[k] = 0
        continue
      }
      const trig = pad.trig !== GROUND ? this.views[pad.trig] : null
      const start = this.padSpan[k] === this.spanId ? this.padFrom[k] : from
      const l = this.views[pad.retL]
      const r = this.views[pad.retR]
      let silent = this.padSilent[k]
      for (let i = start < from ? from : start; i < to; i++) {
        const a = l[i]
        const b = r[i]
        if ((trig && trig[i] > 0.5) || a > SILENCE || a < -SILENCE || b > SILENCE || b < -SILENCE) silent = 0
        else silent++
      }
      this.padSilent[k] = silent
    }
  }

  /** Module `m` over `from` to `to`: asleep, per voice, or as it is. */
  private runModule(m: number, from: number, to: number) {
    const pad = this.padOf[m]
    if (pad) {
      const start = this.padStart(pad - 1, from, to)
      if (start > from) {
        // Asleep for all or part of it: what it last said, held.
        this.hold(m, from, start < to ? start : to)
        if (start >= to) return
        from = start
      }
    }
    this.heldWhole[m] = 0
    const mod = this.modules[m]
    if (this.polyFlag[m]) this.runPoly(m, from, to)
    else if (mod.rests) this.runRestable(mod, from, to)
    else mod.processBlock(from, to)
  }

  /**
   * A module that may rest: skipped while it does, until the first sample
   * anything reaches it, and watched while it runs for how long it has been
   * quiet.
   */
  private runRestable(mod: DspModule, from: number, to: number) {
    const inputs = mod.inputs
    const outputs = mod.outputs
    const ins = mod.ins
    if (mod.resting) {
      let wake = to
      for (let k = 0; k < inputs.length; k++) {
        if (ins[k] === GROUND) continue
        const x = inputs[k]
        for (let i = from; i < wake; i++) {
          if (x[i] > QUIET || x[i] < -QUIET) {
            wake = i
            break
          }
        }
      }
      for (let k = 0; k < outputs.length; k++) outputs[k].fill(0, from, wake)
      if (wake === to) return
      mod.resting = false
      mod.quietRun = 0
      from = wake
    }
    mod.processBlock(from, to)

    // The last sample anything was heard at, going in or coming out.
    let heard = -1
    for (let k = 0; k < inputs.length; k++) {
      if (ins[k] === GROUND) continue
      const x = inputs[k]
      for (let i = to - 1; i > heard && i >= from; i--) {
        if (x[i] > QUIET || x[i] < -QUIET) {
          heard = i
          break
        }
      }
    }
    for (let k = 0; k < outputs.length; k++) {
      const y = outputs[k]
      for (let i = to - 1; i > heard && i >= from; i--) {
        if (y[i] > QUIET || y[i] < -QUIET) {
          heard = i
          break
        }
      }
    }
    mod.quietRun = heard >= from ? to - 1 - heard : mod.quietRun + (to - from)
  }

  /** Where voices are settled: anything that may rest and has been quiet long enough does. */
  private settleRest() {
    const restable = this.restable
    for (let k = 0; k < restable.length; k++) {
      const mod = this.modules[restable[k]]
      if (!mod.resting && mod.quietRun >= this.restAfter[k]) mod.resting = true
    }
  }

  /**
   * A module that is not running goes on saying what it last said.
   *
   * Once a whole block of it has been held nothing else writes there, so the
   * block already says it everywhere and every block after is left alone: a
   * sleeping pad's dozens of modules cost nothing at all.
   */
  private hold(m: number, from: number, to: number) {
    if (this.heldWhole[m]) return
    const before = from > this.stretchFrom ? from - 1 : this.before
    const outs = this.modules[m].outs
    for (let k = 0; k < outs.length; k++) {
      const o = this.views[outs[k]]
      o.fill(o[before], from, to)
    }
    if (from === 0 && to === BLOCK) this.heldWhole[m] = 1
  }
  /** Per module: a whole block of it has been held, and it has not run since. */
  private heldWhole = new Uint8Array(0)

  /** Every feedback cable's copy, at sample `i`: its source one sample back. */
  private carryFeedback(i: number) {
    const dst = this.fbDst
    if (dst.length === 0) return
    const src = this.fbSrc
    const before = i > this.stretchFrom ? i - 1 : this.before
    const views = this.views
    for (let f = 0; f < dst.length; f++) views[dst[f]][i] = views[src[f]][before]
    if (!this.hasPoly) return
    for (let k = 0; k < this.activeList.length; k++) {
      const vv = this.voiceViews[this.activeList[k]]
      for (let f = 0; f < dst.length; f++) vv[dst[f]][i] = vv[src[f]][before]
    }
  }
}

/** Samples `from` to `to` of one block into another. */
function copy(src: Float32Array, dst: Float32Array, from: number, to: number) {
  for (let i = from; i < to; i++) dst[i] = src[i]
}

/** A view per slot onto a buffer of blocks. */
function viewsOf(buf: Float32Array, slots: number): Float32Array[] {
  return Array.from({ length: slots }, (_, s) => buf.subarray(s * BLOCK, (s + 1) * BLOCK))
}

/** A voice's copy of a module draws its own random stream, not voice 0's. */
function voiceKey(id: string, voice: number) {
  return `${id}~${voice}`
}

/** The loudest of a module's copies, for a meter on its panel. */
class VoiceMeter implements Metering {
  private report: Float32Array | null = null

  constructor(private readonly insts: DspModule[]) {}

  levels(): Float32Array {
    for (let v = 0; v < this.insts.length; v++) {
      const l = this.insts[v].meter!.levels()
      if (!this.report || this.report.length !== l.length) this.report = new Float32Array(l.length)
      if (v === 0) this.report.set(l)
      else for (let i = 0; i < l.length; i++) if (l[i] > this.report[i]) this.report[i] = l[i]
    }
    return this.report!
  }
}
