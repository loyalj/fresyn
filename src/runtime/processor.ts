import { RuntimeHost } from './host'
import type { ToRuntime } from './protocol'

/**
 * The game runtime's worklet: a `RuntimeHost`, fed messages, rendering into
 * the device. Everything worth checking is in the host.
 *
 * Reports go about sixty times a second rather than thirty, as the rack's
 * do, because a game draws the beat: a light that pulses with the kick has
 * to know where the kick is to within a frame of the picture.
 */
class FresynRuntimeProcessor extends AudioWorkletProcessor {
  private host = new RuntimeHost(sampleRate)
  private sinceReport = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<ToRuntime>) => {
      const reply = this.host.handle(e.data)
      if (reply) this.port.postMessage(reply)
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0]
    const left = channels[0]
    const right = channels.length > 1 ? channels[1] : left
    this.host.render(left, right)
    for (let c = 2; c < channels.length; c++) channels[c].set(left)

    this.sinceReport += left.length
    if (this.sinceReport >= sampleRate / 60) {
      this.sinceReport = 0
      // The clocks have moved past this block, so the time is its end.
      this.port.postMessage(this.host.report(currentTime + left.length / sampleRate))
    }
    return true
  }
}

registerProcessor('fresyn-runtime', FresynRuntimeProcessor)
