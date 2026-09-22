/**
 * Audits every palette in theme.css.
 *
 * A theme is a wall of colour tokens, and the two ways it goes wrong are
 * both silent. Leave one token out and that part of the rack keeps the
 * standard theme's colour -- a grey knob in a green rack, which nobody
 * notices until they are looking at a screenshot. Pick a pair that does not
 * contrast and the label is still there, still the right size, and still
 * unreadable.
 *
 * So: every palette must declare exactly the same tokens as the reference,
 * every registered theme must have both modes, and the pairs that end up on
 * top of each other have to clear a ratio.
 *
 * Run with: npm run check:theme
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/theme.css'), 'utf8')
const themeTs = readFileSync(join(root, 'src/ui/theme.ts'), 'utf8')

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// --- parse ------------------------------------------------------------
/** Every `selector { ... }` block, with its custom properties. */
const blocks = []
for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ')
  const tokens = new Map()
  for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(d[1], d[2].trim())
  const at = /\[data-theme="([^"]+)"\]\[data-mode="([^"]+)"\]/.exec(selector)
  blocks.push({ selector, tokens, theme: at?.[1], mode: at?.[2] })
}

const palettes = blocks.filter((b) => b.theme)
console.log(`\n${palettes.length} palettes in theme.css`)

// --- every palette declares the same tokens ---------------------------
console.log('\ntoken coverage')
const reference = palettes.find((p) => p.theme === 'standard' && p.mode === 'dark')
if (!reference) {
  check('the reference palette (standard/dark) exists', false)
  process.exit(1)
}
const expected = [...reference.tokens.keys()].sort()
check('the reference declares a full set', expected.length > 50, `${expected.length} tokens`)

for (const p of palettes) {
  const got = new Set(p.tokens.keys())
  const missing = expected.filter((t) => !got.has(t))
  const extra = [...got].filter((t) => !expected.includes(t))
  check(
    `${p.theme}/${p.mode} declares every token`,
    missing.length === 0 && extra.length === 0,
    [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `extra ${extra.join(', ')}` : '']
      .filter(Boolean)
      .join('; '),
  )
}

// --- every registered theme is painted, and vice versa ----------------
console.log('\nregistered themes')
const registered = [...themeTs.matchAll(/\{ id: '([^']+)', name: '([^']+)' \}/g)].map((m) => m[1])
check('theme.ts lists some themes', registered.length > 0, registered.join(', '))

for (const id of registered) {
  for (const mode of ['dark', 'light']) {
    check(`${id} has a ${mode} palette`, palettes.some((p) => p.theme === id && p.mode === mode))
  }
}
for (const p of palettes) {
  check(`${p.theme} is registered in theme.ts`, registered.includes(p.theme))
}

// --- contrast ---------------------------------------------------------
const hex = (v) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a, b) => {
  const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05]
  return x > y ? x / y : y / x
}

/**
 * What sits on what. The ratios are the ones the design already aimed at:
 * body text at 7, the dimmed labels near it, and the faint ones a step
 * below -- deliberately recessive, but never texture.
 */
const PAIRS = [
  ['--ink', '--panel', 7, 'body text on a panel'],
  ['--ink-dim', '--panel', 6, 'knob readouts on a panel'],
  ['--ink-faint', '--panel', 4.2, 'the faintest labels on a panel'],
  ['--accent-line', '--panel', 4.2, 'accent text and strokes on a panel'],
  ['--on-accent', '--accent', 4.5, 'a label on a filled accent button'],
  ['--on-danger', '--danger', 4.5, 'a label on the remove button'],
  ['--ink-dim', '--spine-top', 4, 'the module name on the darker end of the rack ear'],
  ['--ink-faint', '--spine-bottom', 3.5, 'the module id on the rack ear'],
  ['--knob-pointer', '--knob-cap', 3, 'the pointer line on a knob cap'],
  ['--key-black', '--key-white', 4.5, 'the sharps against the naturals'],
]

console.log('\ncontrast')
for (const p of palettes) {
  const worst = []
  for (const [fg, bg, min, what] of PAIRS) {
    const a = hex(p.tokens.get(fg) ?? '')
    const b = hex(p.tokens.get(bg) ?? '')
    if (!a || !b) {
      check(`${p.theme}/${p.mode}: ${fg} on ${bg} is a plain colour`, false, 'not a hex value')
      continue
    }
    const ratio = contrast(a, b)
    if (ratio < min) worst.push(`${what} ${ratio.toFixed(2)}:1 < ${min}`)
  }
  check(`${p.theme}/${p.mode} is readable`, worst.length === 0, worst.join('; '))
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
