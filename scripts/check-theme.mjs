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
 * So: every palette must declare exactly the same tokens as the reference
 * (give or take the few optional overrides below), every registered theme
 * must have both modes, every token must be read by something, and the
 * pairs that end up on top of each other have to clear a ratio -- measured
 * with the colours the stylesheet will actually resolve, not the ones the
 * token names suggest.
 *
 * Run with: npm run check:theme
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
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

/**
 * Tokens a palette may leave out, and what app.css falls back to when it
 * does -- `var(--spine-ink, var(--ink-dim))`. They exist for themes whose
 * rack ears are a different weight from their panels (dark ears on a light
 * rack), where the panel's ink would vanish into the ear. Every other
 * palette is better off without them: one less pair of colours to keep in
 * step. Keep this in step with the fallbacks written in app.css.
 */
const OPTIONAL = {
  '--spine-ink': '--ink-dim',
  '--spine-ink-faint': '--ink-faint',
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

/** A token's value in this palette, following app.css's fallback if it is optional and absent. */
const resolve = (p, token) => p.tokens.get(token) ?? (OPTIONAL[token] ? p.tokens.get(OPTIONAL[token]) : undefined)

// --- every palette declares the same tokens ---------------------------
console.log('\ntoken coverage')
const reference = palettes.find((p) => p.theme === 'standard' && p.mode === 'dark')
if (!reference) {
  check('the reference palette (standard/dark) exists', false)
  process.exit(1)
}
const expected = [...reference.tokens.keys()].filter((t) => !(t in OPTIONAL)).sort()
check('the reference declares a full set', expected.length > 50, `${expected.length} tokens`)

for (const p of palettes) {
  const got = new Set(p.tokens.keys())
  const missing = expected.filter((t) => !got.has(t))
  const extra = [...got].filter((t) => !expected.includes(t) && !(t in OPTIONAL))
  const overrides = [...got].filter((t) => t in OPTIONAL)
  check(
    `${p.theme}/${p.mode} declares every token`,
    missing.length === 0 && extra.length === 0,
    [
      missing.length ? `missing ${missing.join(', ')}` : '',
      extra.length ? `extra ${extra.join(', ')}` : '',
      overrides.length ? `(overrides ${overrides.join(', ')})` : '',
    ]
      .filter(Boolean)
      .join('; '),
  )
}

// --- every token is read by something ---------------------------------
/*
 * A token nothing reads is worse than useless: it is one more value every
 * new theme has to invent, for no effect. --kbd and --hairline-dash sat in
 * all 26 palettes for a while after the markup that used them had gone.
 */
console.log('\ntokens in use')
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const path = join(dir, f)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
const readers = walk(join(root, 'src'))
  .filter((path) => /\.(css|tsx?)$/.test(path) && !path.endsWith('theme.css'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
const unread = [...expected, ...Object.keys(OPTIONAL)].filter(
  (t) => !new RegExp(`${t}(?![a-z0-9-])`).test(readers),
)
check('every palette token is read outside theme.css', unread.length === 0, unread.length ? `unread ${unread.join(', ')}` : '')

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
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((v ?? '').trim())
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

/** Two colours mixed the way a legacy-syntax CSS gradient does: straight sRGB. */
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

/**
 * The rack ear is a sideways gradient from --spine-top to --spine-bottom,
 * 30px wide, and its lettering runs down the middle: a glyph about 10px
 * across, so it spans roughly the middle third. What the text has to hold
 * up against is the ear's colour at the edges of that third -- not either
 * end of the gradient, which the text never touches. Measuring against one
 * end, as this check used to, could fail an ear whose lettering was fine
 * and pass one whose lettering was not.
 */
const EAR = '(the rack ear)'
const earBacks = (p) => {
  const top = hex(p.tokens.get('--spine-top'))
  const bottom = hex(p.tokens.get('--spine-bottom'))
  return top && bottom ? [mix(top, bottom, 1 / 3), mix(top, bottom, 2 / 3)] : null
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
  ['--spine-ink', EAR, 4, 'the module name on the rack ear'],
  ['--spine-ink-faint', EAR, 3.5, 'the module id and presets glyph on the rack ear'],
  ['--knob-pointer', '--knob-cap', 3, 'the pointer line on a knob cap'],
  ['--key-black', '--key-white', 4.5, 'the sharps against the naturals'],
]

console.log('\ncontrast')
for (const p of palettes) {
  const worst = []
  for (const [fg, bg, min, what] of PAIRS) {
    const a = hex(resolve(p, fg))
    const backs = bg === EAR ? earBacks(p) : [hex(resolve(p, bg))]
    if (!a || !backs || backs.some((b) => !b)) {
      check(`${p.theme}/${p.mode}: ${fg} on ${bg} is a plain colour`, false, 'not a hex value')
      continue
    }
    const ratio = Math.min(...backs.map((b) => contrast(a, b)))
    if (ratio < min) worst.push(`${what} ${ratio.toFixed(2)}:1 < ${min}`)
  }
  check(`${p.theme}/${p.mode} is readable`, worst.length === 0, worst.join('; '))
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
