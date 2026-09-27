export interface KeyBinding {
  /** One or more `KeyboardEvent.code` values, e.g. 'Space', 'KeyQ'. */
  code: string | string[]
  /** Require Ctrl (or Cmd on a Mac). Without it, modifier combos pass through. */
  ctrl?: boolean
  shift?: boolean
  onDown?: (e: KeyboardEvent) => void
  onUp?: (e: KeyboardEvent) => void
  /** Call `onDown` again for auto-repeat. Off by default. */
  repeat?: boolean
}

export interface InputOptions {
  bindings: KeyBinding[]
  /** Right-click, routed to the app instead of the browser's menu. */
  onContextMenu?: (e: MouseEvent) => void
  /**
   * Hand the keyboard back while something else owns it -- a menu being read
   * with the arrow keys, say. The same idea as stepping aside for a text
   * field, for the cases where what owns the keyboard is not a field.
   */
  suspended?: boolean
}

/**
 * Keys the browser scrolls the page with. The rack owns them: the page is
 * taller than the viewport, and a held Space that also scrolls makes the
 * instrument unusable. The wheel still scrolls normally.
 */
const SCROLL_KEYS = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

const TEXT_ENTRY = /^(input|textarea|select)$/i

/** Typing into a field always wins over any binding. */
function isTextEntry(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return TEXT_ENTRY.test(target.tagName)
}

/**
 * Something on the page is already using the keyboard for itself.
 *
 * A field is the obvious case; an open menu is the other one. Its rows are
 * walked with the arrows and taken with Space, and the menu bar says so by
 * suspending this whole layer while one of its lists is down. A menu opened
 * at the pointer -- on a knob, say -- has nobody to say that on its behalf,
 * so the same rule is read off the row that holds focus instead.
 */
function ownsKeyboard(target: EventTarget | null, e?: KeyboardEvent) {
  if (isTextEntry(target)) {
    // A slider, a checkbox or a dropdown is not being typed into. It has the
    // keys it moves with, and nothing else: with a fader just touched, Ctrl+Z
    // is still an undo and a Trigger's key still plays it. Only a field that
    // takes text keeps every key to itself.
    if (e && isControl(target)) return CONTROL_KEYS.has(e.code) && !(e.ctrlKey || e.metaKey)
    return true
  }
  return target instanceof HTMLElement && !!target.closest('[role="menu"]')
}

/** The keys a slider, a checkbox or a dropdown moves with. */
const CONTROL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Space',
  'Enter',
])

/** A form control that is set rather than typed into. */
function isControl(target: EventTarget | null) {
  if (target instanceof HTMLSelectElement) return true
  return (
    target instanceof HTMLInputElement &&
    ['range', 'checkbox', 'radio', 'button', 'color', 'submit', 'reset'].includes(target.type)
  )
}

/**
 * Anything with a modifier belongs to the browser or the OS unless a binding
 * has explicitly claimed that combination: reload, devtools, quit, tab
 * switching. Swallowing those wholesale would trap the user in the page.
 */
function isBrowserShortcut(e: KeyboardEvent) {
  return e.ctrlKey || e.metaKey || e.altKey
}

/** Cmd is treated as Ctrl, so bindings work the same on a Mac. */
export function comboKey(e: KeyboardEvent) {
  return `${e.ctrlKey || e.metaKey ? 'C' : ''}${e.shiftKey ? 'S' : ''}${e.code}`
}

function bindingKeys(binding: KeyBinding): string[] {
  const codes = Array.isArray(binding.code) ? binding.code : [binding.code]
  const prefix = `${binding.ctrl ? 'C' : ''}${binding.shift ? 'S' : ''}`
  return codes.map((code) => prefix + code)
}

/**
 * Owns every browser input the app cares about, in one place.
 *
 * Listeners run in the capture phase on `window`, ahead of anything focused,
 * so a key never reaches a focused button as well as its binding -- pressing
 * Space after clicking Trigger would otherwise both gate the synth and
 * re-activate the button.
 */
export class InputManager {
  private byCombo = new Map<string, KeyBinding>()
  /**
   * Keyed by `code` rather than by the full combination: a modifier can be
   * released before the key it was held with, and the keyup would then look
   * like a different binding and never clear.
   */
  private held = new Map<string, KeyBinding>()
  private options: InputOptions = { bindings: [] }
  private detach: (() => void) | null = null

  setOptions(options: InputOptions) {
    // Anything held when the keyboard is handed over never gets its keyup,
    // because the keyup will be ignored too -- so let go of it now. Without
    // this, opening a menu with Space held leaves the rack sounding.
    if (options.suspended && !this.options.suspended) this.releaseAll()
    this.options = options
    this.byCombo.clear()
    for (const binding of options.bindings) {
      for (const key of bindingKeys(binding)) this.byCombo.set(key, binding)
    }
  }

  /** Fire onUp for everything still held. */
  releaseAll() {
    for (const [code, binding] of [...this.held]) {
      this.held.delete(code)
      binding.onUp?.(new KeyboardEvent('keyup', { code }))
    }
  }

  attach(): () => void {
    if (this.detach) return this.detach

    const onKeyDown = (e: KeyboardEvent) => {
      if (this.options.suspended || ownsKeyboard(e.target, e)) return

      const binding = this.byCombo.get(comboKey(e))
      if (!binding) {
        // Unclaimed: leave the browser's own shortcuts alone, but still stop
        // the page scrolling out from under the rack.
        if (!isBrowserShortcut(e) && SCROLL_KEYS.has(e.code)) e.preventDefault()
        return
      }

      // Claimed keys are swallowed on every keydown including auto-repeat.
      // Returning early on repeat is what lets a held key scroll the page even
      // though the first press was handled.
      e.preventDefault()

      if (e.repeat) {
        if (binding.repeat) binding.onDown?.(e)
        return
      }
      // Already marked held means we missed a keyup; ignore rather than
      // retrigger.
      if (this.held.has(e.code)) return
      this.held.set(e.code, binding)
      binding.onDown?.(e)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (this.options.suspended || ownsKeyboard(e.target, e)) return

      const binding = this.held.get(e.code)
      if (!binding) {
        if (!isBrowserShortcut(e) && SCROLL_KEYS.has(e.code)) e.preventDefault()
        return
      }
      e.preventDefault()
      this.held.delete(e.code)
      binding.onUp?.(e)
    }

    const onContextMenu = (e: MouseEvent) => {
      if (isTextEntry(e.target)) return
      e.preventDefault()
      this.options.onContextMenu?.(e)
    }

    // Middle click otherwise starts autoscroll, which hijacks the pointer.
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }

    const onDragStart = (e: Event) => e.preventDefault()

    const onSelectStart = (e: Event) => {
      if (!isTextEntry(e.target)) e.preventDefault()
    }

    // Ctrl+wheel and pinch are page zoom; the rack is not a document.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault()
    }
    const onGesture = (e: Event) => e.preventDefault()

    // A key held while the window loses focus never delivers its keyup, so the
    // gate would stick open until the next press.
    const onBlur = () => this.releaseAll()
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') this.releaseAll()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('contextmenu', onContextMenu, { capture: true })
    window.addEventListener('auxclick', onAuxClick, { capture: true })
    window.addEventListener('mousedown', onMouseDown, { capture: true })
    window.addEventListener('dragstart', onDragStart, { capture: true })
    window.addEventListener('selectstart', onSelectStart, { capture: true })
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    window.addEventListener('gesturestart', onGesture, { capture: true })
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)

    this.detach = () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('contextmenu', onContextMenu, { capture: true })
      window.removeEventListener('auxclick', onAuxClick, { capture: true })
      window.removeEventListener('mousedown', onMouseDown, { capture: true })
      window.removeEventListener('dragstart', onDragStart, { capture: true })
      window.removeEventListener('selectstart', onSelectStart, { capture: true })
      window.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('gesturestart', onGesture, { capture: true })
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      this.detach = null
    }
    return this.detach
  }
}
