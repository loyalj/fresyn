import { useEffect, useRef, useState } from 'react'
import { isReserved, keyLabel } from '../input/keyLabel'

interface Props {
  onDown: () => void
  onUp: () => void
  /** The key this module answers to, on the modules that can have one. */
  keyCode?: string
  /** True while this cap is waiting to be told which key. */
  listening?: boolean
  /** Ask to start listening, or to stop without choosing. */
  onListen?: (on: boolean) => void
  /** A key was chosen, or cleared with `undefined`. */
  onAssign?: (code: string | undefined) => void
  /** Latched open, so the button has to look pressed with nothing holding it. */
  latched?: boolean
}

/**
 * The trigger module's own control: press it and the gate opens.
 *
 * Beside it, on the modules that can be played from the keyboard, is the cap
 * that says which key does the same thing. It is printed on the face rather
 * than hidden in a tooltip because the user chose it and it differs from one
 * unit to the next -- a cap you picked is a reminder, where the old fixed
 * `Space` on every panel was a sentence read once and then in the way for the
 * rest of the session.
 */
export function TriggerButton({
  onDown,
  onUp,
  keyCode,
  listening,
  onListen,
  onAssign,
  latched,
}: Props) {
  /** A key that was refused, held just long enough to say why. */
  const [refused, setRefused] = useState<string | null>(null)
  /**
   * Whether this button is what is holding the gate open: a pointer pressed
   * on it, or Enter or Space with it focused.
   *
   * Leaving the button only lets go of a press it made. Without this, every
   * pointer that crossed the button on its way somewhere else sent a release
   * to the engine -- harmless on a plain gate, and a note cut short when the
   * same Trigger was being held from its key at the time.
   */
  const pressed = useRef<'pointer' | 'key' | null>(null)
  const letGo = () => {
    if (!pressed.current) return
    pressed.current = null
    onUp()
  }

  useEffect(() => {
    if (!listening) {
      setRefused(null)
      return
    }

    // Capture, and swallowed either way: the cap was clicked so it holds
    // focus, and without this the Space being assigned would also press it.
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (e.code === 'Escape') {
        onListen?.(false)
        return
      }
      // Unbinding is its own gesture rather than a second button, because a
      // Trigger with no key is the unusual case and not worth the panel space.
      if (e.code === 'Backspace' || e.code === 'Delete') {
        onAssign?.(undefined)
        onListen?.(false)
        return
      }
      if (isReserved(e.code)) {
        setRefused(e.code)
        return
      }

      onAssign?.(e.code)
      onListen?.(false)
    }

    // Anything that takes attention away ends the wait rather than leaving a
    // cap listening for a key the user has stopped thinking about.
    const onElsewhere = (e: PointerEvent) => {
      if (!(e.target instanceof HTMLElement) || !e.target.closest('.trigger-cap')) {
        onListen?.(false)
      }
    }
    const onBlur = () => onListen?.(false)

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('pointerdown', onElsewhere, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('pointerdown', onElsewhere, { capture: true })
      window.removeEventListener('blur', onBlur)
    }
  }, [listening, onListen, onAssign])

  return (
    <div className="trigger-row">
      <button
        className={`trigger${latched ? ' latched' : ''}`}
        onPointerDown={(e) => {
          if (e.button !== 0 || pressed.current) return
          pressed.current = 'pointer'
          onDown()
        }}
        onPointerUp={letGo}
        onPointerLeave={letGo}
        onPointerCancel={letGo}
        onKeyDown={(e) => {
          // A key the rack has bound -- this Trigger's own Space, most often
          // -- has already played it by the time it gets here, and says so
          // by having been taken from the browser. Only a key nothing else
          // claimed presses the button from here.
          if (e.defaultPrevented || e.repeat) return
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          if (pressed.current) return
          pressed.current = 'key'
          onDown()
        }}
        onKeyUp={(e) => {
          if (pressed.current !== 'key' || (e.key !== 'Enter' && e.key !== ' ')) return
          e.preventDefault()
          letGo()
        }}
        onBlur={() => {
          if (pressed.current === 'key') letGo()
        }}
        aria-label="Trigger"
        // Latch is a state, not a gesture: :active only lasts as long as the
        // finger does, so the one mode that outlives the press needs saying.
        aria-pressed={latched}
        type="button"
      >
        Trigger
      </button>

      {onAssign && (
        <button
          className={`trigger-cap${listening ? ' listening' : ''}${
            refused ? ' refused' : ''
          }${keyCode ? '' : ' unbound'}`}
          onClick={() => onListen?.(!listening)}
          aria-label={
            keyCode
              ? `Trigger key, ${keyLabel(keyCode)}. Click to change.`
              : 'Trigger key, none set. Click to set.'
          }
          title={
            listening
              ? 'Press a key, Backspace to clear, Escape to cancel'
              : 'The key that fires this trigger'
          }
          type="button"
        >
          {capText()}
        </button>
      )}
    </div>
  )

  function capText() {
    if (refused) return 'In use'
    if (listening) return 'Press a key'
    return keyCode ? keyLabel(keyCode) : 'Set key'
  }
}
