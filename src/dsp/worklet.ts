import type { CompiledPatch } from '../patch/compile'
import type { Console } from '../song/types'
import { SongEngine, type TrackEvent, type TrackMix, type TrackSetup } from './SongEngine'
import { bankFrom, type SampleRecord } from './samples'

/**
 * Initial state handed to the processor at construction. The tracks must
 * arrive this way rather than by message: a message posted before
 * `startRendering()` is never delivered to the processor, so a message-driven
 * setup renders silence offline.
 */
export interface ProcessorOptions {
  /** One rack per track. A single rack is a song with one track in it. */
  tracks: TrackSetup[]
  /** Open the gate on the first sample. Used by offline renders. */
  autoGate?: boolean
  seed?: number
  /**
   * Audio the patches play, for the same reason the tracks come this way: a
   * message posted before `startRendering()` never arrives, so an offline
   * render that waited for one would render silence where the samples should
   * be.
   */
  samples?: SampleRecord[]
  /** Which track's scopes and meters to report; the rack on the bench. */
  watch?: string
  /**
   * How the tracks reach the mix, and the song's desk. Here as well as by
   * message, for the reason everything else is: set before the processor
   * existed, a message would have gone nowhere and the song would have
   * played at the wrong levels until something else changed.
   */
  mix?: Record<string, TrackMix>
  console?: Console
}

type EngineMessage =
  | { type: 'param'; track: string; index: number; value: number }
  | { type: 'gate'; track: string; module: string; open: boolean }
  | { type: 'track'; id: string; patch: CompiledPatch; params: number[] }
  | { type: 'removeTrack'; id: string }
  | { type: 'mix'; mix: Record<string, TrackMix> }
  | { type: 'console'; console: Console }
  | { type: 'watch'; track: string }
  | { type: 'samples'; samples: SampleRecord[] }
  // The transport, filling a window of the song a few hundred milliseconds
  // ahead of what is being heard.
  | { type: 'schedule'; events: TrackEvent[] }
  | { type: 'seek'; frame: number }
  | { type: 'unschedule' }
  | { type: 'allNotesOff' }

class FresynProcessor extends AudioWorkletProcessor {
  private engine: SongEngine
  private framesSinceReport = 0

  constructor(options?: { processorOptions?: ProcessorOptions }) {
    super(options)
    const init = options?.processorOptions
    if (!init?.tracks?.length) throw new Error('fresyn: no tracks supplied')

    this.engine = new SongEngine(sampleRate, init.tracks, init.seed, bankFrom(init.samples))
    if (init.watch) this.engine.watch(init.watch)
    if (init.mix) this.engine.setMix(init.mix)
    if (init.console) this.engine.setConsole(init.console)
    if (init.autoGate) this.engine.setGate(true)

    this.port.onmessage = (e: MessageEvent<EngineMessage>) => this.handle(e.data)
  }

  private handle(msg: EngineMessage) {
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
      this.port.postMessage({
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
      })
      this.framesSinceReport = 0
    }

    return true
  }
}

registerProcessor('fresyn-voice', FresynProcessor)
