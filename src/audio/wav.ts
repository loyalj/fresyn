export type BitDepth = 16 | 24
/** What a WAV can be written at: the integer depths, or 32-bit float. */
export type WavDepth = BitDepth | 32

/**
 * Interleaved PCM WAV.
 *
 * 16-bit is what every game engine and audio tool will take without comment;
 * 24-bit is here for when a render is going to be processed further and the
 * extra headroom is worth the file size. 32 is IEEE float, the one depth that
 * keeps whatever went past full scale rather than clipping it.
 */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: WavDepth = 16,
): Uint8Array<ArrayBuffer> {
  const numChannels = channels.length
  const frames = channels[0]?.length ?? 0
  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  const dataBytes = frames * blockAlign

  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  ascii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(view, 8, 'WAVE')

  ascii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true) // IEEE float, or integer PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byte rate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)

  ascii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      if (bitDepth === 32) {
        view.setFloat32(offset, Number.isFinite(channels[c][i]) ? channels[c][i] : 0, true)
        offset += 4
        continue
      }
      // Clamped rather than wrapped: an overshoot should read as clipping,
      // not as a full-scale sign flip.
      const s = Math.max(-1, Math.min(1, channels[c][i]))
      if (bitDepth === 16) {
        view.setInt16(offset, Math.round(s * 32767), true)
        offset += 2
      } else {
        const v = Math.round(s * 8388607)
        view.setUint8(offset, v & 0xff)
        view.setUint8(offset + 1, (v >> 8) & 0xff)
        view.setUint8(offset + 2, (v >> 16) & 0xff)
        offset += 3
      }
    }
  }

  return new Uint8Array(buffer)
}

function ascii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}
