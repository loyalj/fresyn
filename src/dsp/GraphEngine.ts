import type { CompiledPatch } from '../patch/compile'
import { MODULE_FACTORIES, type DspModule } from './modules'
import type { Capturing, Metering, Playable } from './modules/types'
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

/**
 * Executes a compiled patch on the audio thread.
 *
 * The whole graph advances one sample at a time rather than one block at a
 * time. That costs some per-sample call overhead, and buys the two things a
 * modular rack cannot do without: audio-rate modulation of any input, and
 * feedback cables that cost a single sample instead of a whole block.
 */
export class GraphEngine {
  private slots: Float32Array
  private paramValues: Float32Array
  private modules: DspModule[] = []
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
  /** Pending events, soonest first. */
  private queue: EngineEvent[] = []
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
  /** A slot array per voice, so each one's cables carry its own note. */
  private voiceSlots: Float32Array[] = []
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
  private peak = new Float32Array(MAX_VOICES)
  /** Which voices are running, in the order they are processed. */
  private activeList: number[] = []
  /** Orders presses and releases, for choosing which voice to take. */
  private stamp = 0
  private readonly silentFrames: number
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
    this.slots = new Float32Array(compiled.slotCount)
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
    for (const mod of this.everyInstance()) {
      mod.sample = mod.sampleId ? (samples.get(mod.sampleId) ?? null) : null
    }
  }

  /** Every module in the rack, and every voice's copy of it. */
  private *everyInstance(): Iterable<DspModule> {
    yield* this.modules
    for (const copies of this.polyById.values()) yield* copies
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

    if (this.slots.length !== compiled.slotCount) {
      this.slots = new Float32Array(compiled.slotCount)
    }

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
    this.triggerable = []
    this.played = []
    this.captures = []
    this.meters = []
    this.playables.clear()
    const next = new Map<string, DspModule>()

    for (const m of compiled.modules) {
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
      mod.sample = mod.sampleId ? (this.samples.get(mod.sampleId) ?? null) : null
      // Only a fresh module is prepared; preparing a reused one would reseed
      // its smoothers and undo the point of keeping it. The same goes for its
      // random stream: restarting it on every cable drag would make the noise
      // audibly jump.
      if (!reused) {
        mod.seedFrom(this.seed, m.id)
        mod.prepare()
      }

      this.modules.push(mod)
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
    this.applyVoices(compiled)
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
    while (i > 0 && q[i - 1].frame > event.frame) i--
    q.splice(i, 0, event)
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
  }

  /**
   * Drop what is queued from a frame on, keeping what comes before it. What
   * a change of course needs: the lookahead has already been handed over,
   * and the part of it past the turning point is no longer what will play.
   */
  dropFrom(frame: number) {
    const q = this.queue
    let i = q.length
    while (i > 0 && q[i - 1].frame >= frame) i--
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
  }

  // --- voices ----------------------------------------------------------

  /**
   * Build the voices for a freshly compiled patch.
   *
   * Instances are kept across an edit exactly as the rack's own are, voice
   * by voice, so re-patching a cable while a chord rings does not cut it.
   */
  private applyVoices(compiled: CompiledPatch) {
    const mods = compiled.modules
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

    const polyOut = new Set<number>()
    for (let i = 0; i < n; i++) {
      if (!mods[i].poly) continue
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
    for (let i = 0; i < n; i++) if (!mods[i].poly) for (const s of mods[i].ins) sharedReads.add(s)

    if (this.hasPoly && this.voiceSlots[0]?.length !== compiled.slotCount) {
      this.voiceSlots = Array.from({ length: MAX_VOICES }, () => new Float32Array(compiled.slotCount))
    }

    for (let i = 0; i < n; i++) {
      const m = mods[i]
      if (!this.polyFlag[i]) {
        this.voiceMods.push([])
        this.bcast.push(new Int32Array(0))
        this.sumOuts.push(new Int32Array(0))
        continue
      }

      const first = this.modules[i]
      const kept = previous.get(m.id) ?? []
      const copies: DspModule[] = []
      for (let v = 1; v < MAX_VOICES; v++) {
        const existing = kept[v - 1]
        const reused = existing && existing.type === m.type
        const mod = reused ? existing : MODULE_FACTORIES[m.type](this.ctx)
        mod.type = m.type
        mod.ins = first.ins
        mod.outs = first.outs
        mod.params = first.params
        mod.sampleId = first.sampleId
        mod.sample = first.sample
        if (!reused) {
          mod.seedFrom(this.seed, voiceKey(m.id, v))
          mod.prepare()
        }
        copies.push(mod)
      }
      this.voiceMods.push([first, ...copies])
      this.polyById.set(m.id, copies)

      this.bcast.push(Int32Array.from(new Set(m.ins.filter((s) => s !== 0 && !polyOut.has(s)))))
      this.sumOuts.push(Int32Array.from(m.outs.filter((s) => sharedReads.has(s))))

      if (m.id === rootId) this.rootIndex = i
      // A meter on a module that is copied per voice reads the loudest of
      // them, so the panel shows the chord rather than whichever note
      // happened to land on voice 0.
      if (first.meter) {
        const at = this.meters.findIndex((x) => x.id === m.id)
        if (at >= 0) this.meters[at] = { id: m.id, mod: new VoiceMeter([first, ...copies]) }
      }
    }

    if (!this.hasPoly || this.rootIndex < 0) {
      this.hasPoly = false
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

  /** Every voice silent and waiting, as a rack with a new keyboard starts. */
  private resetVoices() {
    this.held.fill(0)
    this.byHand.fill(0)
    this.active.fill(0)
    this.activeList = []
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

    const mono = count === 1
    for (let v = 0; v < MAX_VOICES; v++) this.keysOf(v).voiced = !mono

    for (let v = 0; v < MAX_VOICES; v++) {
      // Notes on voices the knob no longer reaches are let go, and ring out.
      if (this.held[v] && (mono ? v > 0 : v >= count)) this.release(v)
    }
    if (mono) {
      this.wake(0)
      this.newest = 0
    } else if (this.active[0] && !this.held[0]) this.offAt[0] = ++this.stamp
  }

  private wake(v: number) {
    this.silent[v] = 0
    this.peak[v] = 0
    if (this.active[v]) return
    this.active[v] = 1
    this.activeList.push(v)
  }

  private release(v: number) {
    this.keysOf(v).noteOff()
    this.held[v] = 0
    this.byHand[v] = 0
    this.offAt[v] = ++this.stamp
    this.silent[v] = 0
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

  private voiceOn(pitch: number, velocity: number, hand: boolean) {
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
    this.wake(v)
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
    if (pitch === undefined) {
      for (let v = 0; v < MAX_VOICES; v++) if (this.held[v]) this.release(v)
      return
    }
    let best = -1
    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.held[v] && !this.byHand[v] && this.pitchOf[v] === pitch) {
        if (best < 0 || this.onAt[v] < this.onAt[best]) best = v
      }
    }
    if (best >= 0) this.release(best)
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
    if (open) this.handPress()
    else if (!this.rootGateWas) this.handRelease()
  }

  private handPress() {
    this.handRelease()
    const note = this.noteParam >= 0 ? this.paramValues[this.noteParam] : 0
    this.voiceOn(note, 1, true)
  }

  private handRelease() {
    for (let v = 0; v < MAX_VOICES; v++) if (this.held[v] && this.byHand[v]) this.release(v)
  }

  /** Run one per-voice module, on every voice that is awake. */
  private runPoly(m: number) {
    const slots = this.slots
    if (m === this.rootIndex) {
      // The Gate jack, heard here rather than by each voice; see `voiced`.
      const gate = this.rootGateSlot !== 0 && slots[this.rootGateSlot] > 0.5
      // The jack and the panel are one hand, so either one alone holds it.
      if (gate !== this.rootGateWas) {
        this.rootGateWas = gate
        if (this.voiceCount > 1 && !this.panelHeld) {
          if (gate) this.handPress()
          else this.handRelease()
        }
      }
    }

    const insts = this.voiceMods[m]
    const bc = this.bcast[m]
    const so = this.sumOuts[m]
    const list = this.activeList
    const voices = list.length
    const vslots = this.voiceSlots

    for (let k = 0; k < voices; k++) {
      const v = list[k]
      const vs = vslots[v]
      for (let j = 0; j < bc.length; j++) vs[bc[j]] = slots[bc[j]]
      insts[v].process(vs)
    }

    // The keyboard's own outputs are the newest note, as a single keyboard's
    // are: a pitch summed across a chord is no pitch at all. They are not
    // what decides a voice has finished, either, since a pitch never falls
    // silent -- the sound downstream of it does.
    if (m === this.rootIndex) {
      const newest = vslots[this.newest]
      for (let j = 0; j < so.length; j++) slots[so[j]] = newest[so[j]]
      return
    }

    // Everything else is summed where the shared part reads it, and measured
    // on the way: a voice is finished when nothing it sends is audible.
    const peak = this.peak
    for (let j = 0; j < so.length; j++) {
      const s = so[j]
      let acc = 0
      for (let k = 0; k < voices; k++) {
        const v = list[k]
        const x = vslots[v][s]
        acc += x
        const a = x < 0 ? -x : x
        if (a > peak[v]) peak[v] = a
      }
      slots[s] = acc
    }
  }

  /** Put to sleep every released voice that has gone quiet. Once a sample. */
  private settleVoices() {
    const list = this.activeList
    let finished = false
    for (let k = 0; k < list.length; k++) {
      const v = list[k]
      const loud = this.peak[v] >= SILENCE
      this.peak[v] = 0
      if (this.held[v] || (v === 0 && this.voiceCount === 1)) continue
      if (loud) this.silent[v] = 0
      else if (++this.silent[v] >= this.silentFrames) {
        this.active[v] = 0
        finished = true
      }
    }
    if (finished) this.activeList = list.filter((v) => this.active[v])
  }

  private fire(event: EngineEvent) {
    switch (event.kind) {
      case 'noteOn':
        // A module that has since been deleted is a silent no-op rather than
        // an error: a patch can be edited while the song is playing, and the
        // events already queued against it are simply past.
        this.playables.get(event.module)?.noteOn(event.pitch, event.velocity)
        break
      case 'noteOff':
        this.playables.get(event.module)?.noteOff(event.pitch)
        break
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
   * and takes the whole buffer in a single span, so the inner loop is exactly
   * what it was before any of this existed.
   */
  render(left: Float32Array, right: Float32Array) {
    const total = left.length
    const queue = this.queue
    let at = 0
    // Once a block: the knob is read here rather than per sample.
    if (this.hasPoly) this.syncVoices()

    while (at < total) {
      // Everything due, applied before a single sample of the span is
      // computed -- so an event stamped at frame N is heard from frame N.
      while (queue.length > 0 && queue[0].frame <= this.frame) this.fire(queue.shift()!)

      let span = total - at
      if (queue.length > 0) {
        // Every remaining event is strictly ahead of the clock, the loop above
        // having taken the rest, so this is at least one sample.
        const ahead = queue[0].frame - this.frame
        if (ahead < span) span = ahead
      }
      this.renderSpan(left, right, at, span)
      at += span
    }
  }

  private renderSpan(left: Float32Array, right: Float32Array, from: number, count: number) {
    const slots = this.slots
    const modules = this.modules
    const moduleCount = modules.length
    const monL = this.monL
    const monR = this.monR
    const buses = monL.length
    const end = from + count

    const poly = this.hasPoly ? this.polyFlag : null

    for (let i = from; i < end; i++) {
      // Slots deliberately keep their values between samples: that residue is
      // exactly the one-sample delay a feedback cable reads.
      if (poly) {
        for (let m = 0; m < moduleCount; m++) {
          if (poly[m]) this.runPoly(m)
          else modules[m].process(slots)
        }
        this.settleVoices()
      } else {
        for (let m = 0; m < moduleCount; m++) modules[m].process(slots)
      }

      // Every main mix lands in the speaker pair. Summed here rather than by
      // a module, because which buses are main mixes is a property of the
      // wiring and not of anything in the rack.
      let l = 0
      let r = 0
      for (let b = 0; b < buses; b++) {
        l += slots[monL[b]]
        r += slots[monR[b]]
      }
      slots[this.monSlotL] = l
      slots[this.monSlotR] = r

      left[i] = slots[this.outL]
      right[i] = slots[this.outR]
    }

    this.frame += count
  }
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
