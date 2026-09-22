import type { CompiledPatch } from '../patch/compile'
import { GraphEngine } from './GraphEngine'

/**
 * Initial state handed to the processor at construction. The compiled patch
 * must arrive this way rather than by message: a message posted before
 * `startRendering()` is never delivered to the processor, so a message-driven
 * setup renders silence offline.
 */
export interface ProcessorOptions {
  patch: CompiledPatch
  params?: number[]
  /** Open the gate on the first sample. Used by offline renders. */
  autoGate?: boolean
  seed?: number
}

type EngineMessage =
  | { type: 'param'; index: number; value: number }
  | { type: 'gate'; open: boolean; module?: string }
  | { type: 'patch'; patch: CompiledPatch; params: number[] }

class FresynProcessor extends AudioWorkletProcessor {
  private engine: GraphEngine
  private framesSinceReport = 0

  constructor(options?: { processorOptions?: ProcessorOptions }) {
    super(options)
    const init = options?.processorOptions
    if (!init?.patch) throw new Error('fresyn: no compiled patch supplied')

    this.engine = new GraphEngine(init.patch, sampleRate, init.params, init.seed)
    if (init.autoGate) this.engine.setGate(true)

    this.port.onmessage = (e: MessageEvent<EngineMessage>) => this.handle(e.data)
  }

  private handle(msg: EngineMessage) {
    switch (msg.type) {
      case 'param':
        this.engine.setParam(msg.index, msg.value)
        break
      case 'gate':
        if (msg.module) this.engine.setModuleGate(msg.module, msg.open)
        else this.engine.setGate(msg.open)
        break
      case 'patch':
        // Rewire in place; the rack keeps playing through the edit.
        this.engine.rebuild(msg.patch, msg.params)
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
    for (const c of captures) frames[c.id] = c.mod.snapshot()
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
    // Both are left out entirely when the patch has nothing that publishes
    // them, so a rack with no mixer and no scope costs nothing. Posting
    // structured-clones each frame, which is what makes it safe for a module
    // to keep reusing one buffer.
    this.framesSinceReport += left.length
    if (this.framesSinceReport >= sampleRate / 30) {
      this.port.postMessage({
        type: 'frame',
        levels: this.meterLevels(),
        scopes: this.scopeFrames(),
      })
      this.framesSinceReport = 0
    }

    return true
  }
}

registerProcessor('fresyn-voice', FresynProcessor)
