/**
 * Memory the page shares with the audio thread and its workers, where it can.
 *
 * A browser only hands out `SharedArrayBuffer` to a page that is cross-origin
 * isolated -- served with the COOP and COEP headers `public/_headers` sets,
 * and that the dev server sets too. Anywhere else it is simply absent, so
 * everything that shares memory has a way that copies instead, and this is
 * the one place that decides which.
 */
export const canShare = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true

/**
 * A copy of `data` in shared memory: one the worklet and a bounce worker can
 * each be handed as it is, rather than each being given a copy of their own.
 */
export function sharedCopy(data: Float32Array): Float32Array {
  const copy = new Float32Array(new SharedArrayBuffer(data.byteLength))
  copy.set(data)
  return copy
}
