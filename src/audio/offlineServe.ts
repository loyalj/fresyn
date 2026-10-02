import type { OfflineProgress, OfflineReply, OfflineRequest, OfflineResults } from './offline'

/**
 * The worker's end of `offline.ts`: take one job, run it, answer.
 *
 * Shared by the two workers -- `bounce.worker.ts` and `takes.worker.ts` --
 * which differ only in what they can run. Nothing on a worker's side
 * yields: there is no page on that thread to hand back to, so a render runs
 * flat out from its first block to its last and says how far it has got by
 * posting, which costs it nothing it would notice.
 */

// Typed by hand: the project's lib is the DOM's, whose `postMessage` is the
// window's. The worker's takes the same options object, so this is only a
// narrower name for it.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<OfflineRequest>) => void) | null
  postMessage(message: OfflineReply, options?: { transfer?: Transferable[] }): void
}

export const reply = (message: OfflineReply, transfer: Transferable[] = []) =>
  scope.postMessage(message, { transfer })

export const progress = (p: OfflineProgress) => reply({ type: 'progress', progress: p })

/** How often a render says how far it has got, in wall-clock ms. */
export const PROGRESS_MS = 100

export function serve(run: (request: OfflineRequest) => Promise<OfflineResults[keyof OfflineResults]>) {
  scope.onmessage = (e) => {
    run(e.data).then(
      (result) => reply({ type: 'done', result }),
      (err: unknown) => reply({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
    )
  }
}
