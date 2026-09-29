import { useCallback, useRef, useState } from 'react'
import type { SetNotice } from '../ui/notice'

/**
 * One long job at a time: a bounce, a save.
 *
 * A second Bounce while the first is running, or Ctrl+S half way through one,
 * used to start a competing job -- two renders fighting for the same thread,
 * two save dialogs, and whichever finished last deciding what the notice
 * said. Now the second is refused, out loud, and the menu shows the items as
 * unavailable for as long as the first takes.
 *
 * The ref is what guards; the state is only for drawing. A second press can
 * arrive before React has re-rendered with the first job's state.
 */
export function useJob(setNotice: SetNotice) {
  const current = useRef<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * Run `job` unless another is running. `label` finishes the sentence
   * "Still ..." -- "bouncing", "saving".
   */
  const run = useCallback(
    async (label: string, job: () => Promise<void>) => {
      if (current.current) {
        setNotice(`Still ${current.current} -- wait for it to finish`)
        return
      }
      current.current = label
      setBusy(label)
      try {
        await job()
      } finally {
        current.current = null
        setBusy(null)
      }
    },
    [setNotice],
  )

  return { busy, run }
}
