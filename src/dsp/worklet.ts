import type { Capturing, Metering } from './modules/types'
import type { FromWorklet, ProcessorOptions, TelemetryLayout, ToWorklet } from './protocol'
import { SongEngine } from './SongEngine'
import { bankFrom, type SampleBank } from './samples'

class FresynProcessor extends AudioWorkletProcessor {
  private engine: SongEngine
  private framesSinceReport = 0
  /** Every sample the page has sent, which each new one is added to. */
  private bank: SampleBank

  // --- shared telemetry -------------------------------------------------
  //
  // Where the page can share memory, a report is written into it rather than
  // posted: a scope's frame is sixteen kilobytes, and cloning two of them
  // thirty times a second was a steady trickle of garbage on the one thread
  // that must never stop for a collection. See `TelemetryLayout`.

  private shared: Float32Array | null = null
  /** Floats per slot: half the memory each. */
  private slotSize = 0
  /** The slot the next report goes in. */
  private slot = 0
  private layout: TelemetryLayout | null = null
  /** What the layout was worked out for; a report for anything else lays it out again. */
  private laidMeters: readonly { id: string; mod: Metering }[] | null = null
  private laidCaptures: readonly { id: string; mod: Capturing }[] | null = null
  private laidRevision = -1
  /** Per scope in the layout: 1 if it has a second trace laid out after it. */
  private laidB = new Uint8Array(0)
  /** Each meter's buffer this report, gathered before anything is written. */
  private levelBufs: Float32Array[] = []
  /** The one message a shared report posts, reused. */
  private readonly tick = { type: 'tick' as const, frame: 0, slot: 0 }

  constructor(options?: { processorOptions?: ProcessorOptions }) {
    super(options)
    // No tracks is a valid start rather than an error. An empty project still
    // opens the device -- the tracks arrive by message as they are added --
    // and a throw here would kill the node before it rendered a block, which
    // the page would see only as audio that never came.
    const init = options?.processorOptions ?? {}

    this.bank = bankFrom(init.samples)
    this.engine = new SongEngine(sampleRate, init.tracks ?? [], init.seed, this.bank)
    if (init.telemetry) {
      this.shared = new Float32Array(init.telemetry)
      this.slotSize = Math.floor(this.shared.length / 2)
    }
    if (init.watch) this.engine.watch(init.watch)
    if (init.mix) this.engine.setMix(init.mix)
    if (init.console) this.engine.setConsole(init.console)
    if (init.autoGate) this.engine.setGate(true)

    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.handle(e.data)
  }

  private handle(msg: ToWorklet) {
    switch (msg.type) {
      case 'param':
        this.engine.setParam(msg.track, msg.index, msg.value)
        break
      case 'gate':
        this.engine.setModuleGate(msg.track, msg.module, msg.open)
        break
      case 'track':
        // Rewire in place; the rack keeps playing through the edit.
        this.engine.setTrack(msg.id, msg.patch, msg.params)
        break
      case 'removeTrack':
        this.engine.removeTrack(msg.id)
        break
      case 'mix':
        this.engine.setMix(msg.mix)
        break
      case 'console':
        this.engine.setConsole(msg.console)
        break
      case 'watch':
        this.engine.watch(msg.track)
        break
      case 'addSamples':
        // A file landing on a panel reaches a playing rack without a rebuild.
        for (const r of msg.samples) this.bank.set(r.id, { channels: r.channels, rate: r.rate, frames: r.frames })
        this.engine.setSamples(this.bank)
        break
      case 'schedule':
        this.engine.scheduleMany(msg.events)
        break
      case 'seek':
        this.engine.seek(msg.frame)
        break
      case 'unschedule':
        // The song changed under the transport. The clock stays where it is,
        // because the speakers are in the middle of it.
        this.engine.clearSchedule()
        break
      case 'allNotesOff':
        this.engine.allNotesOff()
        break
    }
  }

  private meterLevels(): Record<string, Float32Array> | undefined {
    const meters = this.engine.meters
    if (meters.length === 0) return undefined
    const levels: Record<string, Float32Array> = {}
    for (const m of meters) levels[m.id] = m.mod.levels()
    return levels
  }

  private scopeFrames(): Record<string, Float32Array> | undefined {
    const captures = this.engine.captures
    if (captures.length === 0) return undefined
    const frames: Record<string, Float32Array> = {}
    for (const c of captures) {
      frames[c.id] = c.mod.snapshot()
      // A second trace travels as its own entry rather than as a longer
      // buffer, so a reader that only wants the first one is untouched.
      const b = c.mod.snapshotB?.()
      if (b) frames[`${c.id}.b`] = b
    }
    return frames
  }

  /**
   * Write this report into the shared telemetry and say which slot it is in.
   * False when it does not fit, for the report to go as a message instead.
   */
  private reportShared(shared: Float32Array): boolean {
    const engine = this.engine
    const meters = engine.meters
    const captures = engine.captures

    // Each meter's levels first: asking for them resets them, and how long
    // each one is decides the layout.
    const bufs = this.levelBufs
    bufs.length = meters.length
    for (let k = 0; k < meters.length; k++) bufs[k] = meters[k].mod.levels()

    let layout = this.layout
    if (!layout || meters !== this.laidMeters || captures !== this.laidCaptures || engine.revision !== this.laidRevision) {
      layout = this.lay(bufs)
      if (!layout) return false
      this.port.postMessage({ type: 'layout', layout } satisfies FromWorklet)
    }

    const base = this.slot * this.slotSize
    const levels = layout.levels
    for (let k = 0; k < levels.length; k++) {
      const buf = bufs[k]
      const at = base + levels[k].at
      const n = Math.min(buf.length, levels[k].length)
      for (let i = 0; i < n; i++) shared[at + i] = buf[i]
    }
    // The first trace of each scope, then its second if it has one, in the
    // order they were laid out.
    const scopes = layout.scopes
    let s = 0
    for (let k = 0; k < captures.length; k++) {
      shared.set(captures[k].mod.snapshot(), base + scopes[s++].at)
      if (!this.laidB[k]) continue
      const b = captures[k].mod.snapshotB?.()
      if (b) shared.set(b, base + scopes[s].at)
      s++
    }
    engine.writeMixLevels(shared, base + layout.mixAt)

    this.tick.frame = engine.currentFrame
    this.tick.slot = this.slot
    this.port.postMessage(this.tick)
    this.slot ^= 1
    return true
  }

  /** Where everything goes for the rack on the bench now, or null if it will not fit. */
  private lay(bufs: Float32Array[]): TelemetryLayout | null {
    const engine = this.engine
    let at = 0
    const levels = engine.meters.map((m, k) => {
      const entry = { id: m.id, at, length: bufs[k].length }
      at += bufs[k].length
      return entry
    })
    const scopes: TelemetryLayout['scopes'] = []
    this.laidB = new Uint8Array(engine.captures.length)
    engine.captures.forEach((c, k) => {
      const a = c.mod.snapshot()
      scopes.push({ id: c.id, at, length: a.length })
      at += a.length
      // Only while something is patched to it, which is also only changed by
      // a rebuild -- and a rebuild is a new layout.
      const b = c.mod.snapshotB?.()
      if (b) {
        this.laidB[k] = 1
        scopes.push({ id: `${c.id}.b`, at, length: b.length })
        at += b.length
      }
    })
    const tracks = engine.trackIds
    const layout = { levels, scopes, mixAt: at, tracks }
    at += tracks.length + 3
    this.layout = at <= this.slotSize ? layout : null
    this.laidMeters = engine.meters
    this.laidCaptures = engine.captures
    this.laidRevision = engine.revision
    return this.layout
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0]
    const left = channels[0]
    const right = channels.length > 1 ? channels[1] : left

    // The rack runs continuously, like hardware: an LFO or a drone keeps
    // going with no gate held, so there is no idle path to skip.
    this.engine.render(left, right)

    for (let c = 2; c < channels.length; c++) channels[c].set(left)

    // Meters and scopes update at ~30 Hz, into shared memory where there is
    // some and otherwise on one message. Posting per block would flood the
    // main thread for no visible benefit.
    //
    // Both are left out entirely when the watched track has nothing that
    // publishes them, so a rack with no mixer and no scope costs nothing.
    // Posting structured-clones each frame, which is what makes it safe for a
    // module to keep reusing one buffer.
    this.framesSinceReport += left.length
    if (this.framesSinceReport >= sampleRate / 30) {
      this.framesSinceReport = 0
      if (this.shared && this.reportShared(this.shared)) return true
      const report: FromWorklet = {
        type: 'frame',
        // Where the transport has reached. The only clock either side agrees
        // on: the main thread counts in wall time, which drifts against the
        // audio device, so the playhead and the lookahead are both measured
        // from here instead.
        frame: this.engine.currentFrame,
        levels: this.meterLevels(),
        scopes: this.scopeFrames(),
        // Every track's level after its strip, and the master's: what the
        // Mix view's meters read. Small, so it always travels.
        mix: this.engine.mixLevels(),
      }
      this.port.postMessage(report)
    }

    return true
  }
}

registerProcessor('fresyn-voice', FresynProcessor)
