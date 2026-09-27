import { useCallback, useState } from 'react'

/**
 * Whether a destructive button has been pressed once and is waiting for the
 * second press that means it.
 *
 * A hook as well as a button because not every confirm is a click on one
 * button: a preset's Save can be asked for with Enter in its name field, and
 * the question it has to ask -- "Replace?" -- is the same one either way.
 */
export function useConfirm() {
  const [armed, setArmed] = useState(false)
  const arm = useCallback(() => setArmed(true), [])
  const disarm = useCallback(() => setArmed(false), [])
  return { armed, arm, disarm }
}

interface Props {
  /** What happens on the second press. */
  onConfirm: () => void
  /** The button at rest. */
  children: React.ReactNode
  /** What it says once pressed, asking for the second: "Delete?". */
  ask: string
  className?: string
  title?: string
  'aria-label'?: string
  disabled?: boolean
  tabIndex?: number
  /**
   * False when there is nothing to lose and the first press should simply
   * act -- a Render with no takes on the panel to throw away, say.
   */
  needed?: boolean
}

/**
 * A button that asks before it destroys anything: the first press turns it
 * into its question, the second does the thing.
 *
 * Two presses on the same spot rather than a dialog, which is the library's
 * delete and now everybody's. A dialog is a context switch for a question
 * whose answer is almost always yes; a button that changes its word under
 * the pointer is a pause exactly as long as it needs to be. Moving away --
 * the pointer off it, or the focus -- takes the question back, so a stray
 * first press is never left armed for a later one to land on.
 *
 * Not for anything that undoes. An edit that Ctrl+Z brings back gets a notice
 * saying so instead: a confirm on every undoable action teaches people to
 * click through confirms.
 */
export function ConfirmButton({
  onConfirm,
  children,
  ask,
  className,
  title,
  disabled,
  tabIndex,
  needed = true,
  ...rest
}: Props) {
  const { armed, arm, disarm } = useConfirm()
  const label = rest['aria-label']

  return (
    <button
      className={`${className ?? ''}${armed ? ' confirm' : ''}`}
      onClick={() => {
        if (needed && !armed) {
          arm()
          return
        }
        disarm()
        onConfirm()
      }}
      onPointerLeave={disarm}
      onBlur={disarm}
      title={title}
      // Said out loud as well as shown: the question is the button's name
      // while it is asking.
      aria-label={armed ? `${ask} Press again to confirm${label ? `: ${label}` : ''}` : label}
      disabled={disabled}
      tabIndex={tabIndex}
      type="button"
    >
      {armed ? ask : children}
    </button>
  )
}
