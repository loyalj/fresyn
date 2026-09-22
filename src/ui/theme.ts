/**
 * Appearance: which palette the rack is painted in.
 *
 * Two independent axes. A *theme* is a family of colours -- the studio grey
 * of the original rack, or the sage and brass of Fall Cafe -- and a *mode*
 * is dark or light. Every theme has both modes, so the two choices never
 * interfere: picking light does not drop you back into the standard theme,
 * and picking a theme does not drag you back into the dark.
 *
 * The values themselves live in theme.css. This module only knows the names,
 * because a palette is a stylesheet's business and nothing in the app should
 * have to be rebuilt to add one.
 */

export type ThemeId = 'standard' | 'fall-cafe' | 'neon-vice' | 'mesa' | 'terminal-80s'
export type Mode = 'dark' | 'light'

export interface Appearance {
  theme: ThemeId
  mode: Mode
}

export interface ThemeInfo {
  id: ThemeId
  /** As it appears in the picker. */
  name: string
}

/** The order the picker lists them in. */
export const THEMES: ThemeInfo[] = [
  { id: 'standard', name: 'Standard' },
  { id: 'fall-cafe', name: 'Fall Cafe' },
  { id: 'neon-vice', name: 'Neon Vice' },
  { id: 'mesa', name: 'Mesa' },
  { id: 'terminal-80s', name: 'Terminal 80s' },
]

/** The rack as it has always looked, so an upgrade changes nothing. */
export const DEFAULT_APPEARANCE: Appearance = { theme: 'standard', mode: 'dark' }

const KEY = 'fresyn.appearance.v1'
/** The key before the app was renamed; read once so a choice survives it. */
const LEGACY_KEY = 'freeson.appearance.v1'
const THEME_IDS = new Set<string>(THEMES.map((t) => t.id))

/**
 * Paint the document. Attributes on <html> rather than a class, so the four
 * combinations are four selectors and no rule in the sheet has to care which
 * one is on.
 */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement
  root.dataset.theme = a.theme
  root.dataset.mode = a.mode
}

/**
 * Guarded the same way the patch autosave is: storage throws outright in a
 * private window, and losing a colour preference is never a reason to take
 * the app down with it.
 */
export function loadAppearance(): Appearance {
  let text: string | null = null
  try {
    text = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
  } catch {
    return DEFAULT_APPEARANCE
  }
  if (!text) return DEFAULT_APPEARANCE

  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return DEFAULT_APPEARANCE
    const { theme, mode } = raw as Partial<Appearance>
    // A theme that has since been renamed or removed falls back rather than
    // leaving the document with an attribute no selector matches.
    return {
      theme: typeof theme === 'string' && THEME_IDS.has(theme) ? (theme as ThemeId) : DEFAULT_APPEARANCE.theme,
      mode: mode === 'light' || mode === 'dark' ? mode : DEFAULT_APPEARANCE.mode,
    }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

export function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a))
  } catch {
    // Nothing to do; the choice simply will not survive the tab.
  }
}
