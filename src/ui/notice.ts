/**
 * The message card in the corner, and how long each kind of message stays.
 *
 * - `info`: something happened as asked -- saved, copied, loaded. Fades.
 * - `progress`: something is still happening. Stays until the job replaces it.
 * - `warn`: something went wrong, or went through with a caveat. Stays until
 *   dismissed, because a failure that fades as fast as "Saved" is a failure
 *   the user may never see.
 *
 * A plain string is an `info`, which is what most callers want and all of
 * them used to send.
 */
export type NoticeKind = 'info' | 'progress' | 'warn'

export interface Notice {
  text: string
  kind: NoticeKind
  /**
   * The rest of what there is to say, behind a "+N more": every warning a
   * file came with, not only the first.
   */
  details?: readonly string[]
}

export type NoticeInput = string | Notice

export type SetNotice = (notice: NoticeInput) => void

/** How long an `info` stays up. The other kinds do not time out. */
export const NOTICE_FADE_MS = 4000

export function asNotice(input: NoticeInput): Notice {
  return typeof input === 'string' ? { text: input, kind: 'info' } : input
}

/** A failure, said until dismissed. */
export function warn(text: string, details?: readonly string[]): Notice {
  return { text, kind: 'warn', details: details?.length ? details : undefined }
}

/** A job under way, kept up until the job says something else. */
export function progress(text: string): Notice {
  return { text, kind: 'progress' }
}

/** What went wrong, in words, whatever was thrown. */
export function reason(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
