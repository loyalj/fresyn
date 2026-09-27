import type { FromWorklet, ProcessorOptions, ToWorklet } from './protocol'
import { SongEngine } from './SongEngine'
import { bankFrom } from './samples'

class FresynProcessor extends AudioWorkletProcessor {
  private engine: SongEngine
  private framesSinceReport = 0

  constructor(options?: { processorOptions?: ProcessorOptions }) {
    super(options)
    // No tracks is a valid start rather than an error. An empty project still
    // opens the device -- the tracks arrive by message as they are added --
    // and a throw here would kill the node before it rendered a block, which
    // the page would see only as audio that never came.
    const init = options?.processorOptions ?? {}

    this.engine = new SongEngine(sampleRate, init.tracks ?? [], init.seed, bankFrom(init.samples))
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
      case 'samples':
        // A file landing on a panel reaches a playing rack without a rebuild.
        this.engine.setSamples(bankFrom(msg.samples))
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

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0]
    const left = channels[0]
    const right = channels.length > 1 ? channels[1] : left

    // The rack runs continuously, like hardware: an LFO or a drone keeps
    // going with no gate held, so there is no idle path to skip.
    this.engine.render(left, right)

    for (let c = 2; c < channels.length; c++) channels[c].set(left)

    // Meters and scopes update at ~30 Hz on one message. Posting per block
    // would flood the main thread for no visible benefit; this moves to a
    // SharedArrayBuffer later.
    //
    // Both are left out entirely when the watched track has nothing that
    // publishes them, so a rack with no mixer and no scope costs nothing.
    // Posting structured-clones each frame, which is what makes it safe for a
    // module to keep reusing one buffer.
    this.framesSinceReport += left.length
    if (this.framesSinceReport >= sampleRate / 30) {
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
      this.framesSinceReport = 0
    }

    return true
  }
}

registerProcessor('fresyn-voice', FresynProcessor)
