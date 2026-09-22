/**
 * Turning a `KeyboardEvent.code` into something that fits on a key cap.
 *
 * Bindings are stored as `code` rather than `key` because a played trigger is
 * about where your finger goes, not what the character is: the key under the
 * left ring finger should stay under the left ring finger whatever the layout
 * says it prints. The cost is that these labels are drawn for a US layout, so
 * a non-US keyboard can show a cap that does not match its legend. The key
 * still fires; only the label is wrong.
 */

/** Codes whose label is not simply the code with its prefix taken off. */
const NAMED: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Backspace: 'Bksp',
  CapsLock: 'Caps',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  NumpadEnter: 'Num ↵',
  Insert: 'Ins',
  Delete: 'Del',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

/**
 * Keys a binding may not take.
 *
 * Two reasons, and they are different. Tab is the rack's own -- it flips the
 * unit round -- and a Trigger that claimed it would shadow that silently,
 * because the bindings the rack builds are installed alongside the app's.
 * Escape and the function keys are the browser's and the user's way out of a
 * page: the input layer swallows whatever it has claimed, so binding F5 would
 * mean the rack could no longer be reloaded from the keyboard.
 */
export function isReserved(code: string): boolean {
  return code === 'Tab' || code === 'Escape' || /^F\d{1,2}$/.test(code)
}

/** What the cap on the panel says. */
export function keyLabel(code: string): string {
  const named = NAMED[code]
  if (named) return named
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`
  return code
}
