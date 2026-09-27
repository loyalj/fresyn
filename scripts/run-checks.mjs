/**
 * Runs a group of checks one after another and says at the end which failed.
 *
 *   node scripts/run-checks.mjs fast      the headless ones, no browser
 *   node scripts/run-checks.mjs browser   every puppeteer suite
 *   node scripts/run-checks.mjs all       both
 *
 * Every suite runs even after one fails -- a red DSP check says nothing
 * about the theme, and stopping at the first failure hides the rest. The
 * browser suites share one dev server, started here and handed to each of
 * them through DEV_URL, rather than nine servers starting in turn. Each
 * suite still runs in its own process with its own Chrome, so one that
 * leaves the page in a strange state cannot fail the next.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDevServer } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Headless: bundled TypeScript through run-ts, plus the theme audit. */
const FAST = [
  ['dsp', ['scripts/run-ts.mjs', 'check-dsp']],
  ['patch', ['scripts/run-ts.mjs', 'check-patch']],
  ['render', ['scripts/run-ts.mjs', 'check-render']],
  ['song', ['scripts/run-ts.mjs', 'check-song']],
  ['manual', ['scripts/run-ts.mjs', 'check-manual']],
  ['instruments', ['scripts/run-ts.mjs', 'check-instruments']],
  ['modules', ['scripts/run-ts.mjs', 'check-modules']],
  ['theme', ['scripts/check-theme.mjs']],
]

const BROWSER = ['browser', 'cables', 'input', 'rack', 'export', 'roll', 'sampler', 'scope', 'tools'].map(
  (n) => [n, [`scripts/check-${n}.mjs`]],
)

const group = process.argv[2] ?? 'all'
const plan = { fast: FAST, browser: BROWSER, all: [...FAST, ...BROWSER] }[group]
if (!plan) {
  console.error('usage: node scripts/run-checks.mjs fast|browser|all')
  process.exit(2)
}

const run = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })

const results = []
let server = null
const started = Date.now()
try {
  for (const [name, args] of plan) {
    const env = { ...process.env }
    if (BROWSER.some(([n]) => n === name)) {
      server ??= await startDevServer()
      env.DEV_URL = server.url
    }
    console.log(`\n=== check:${name} ${'='.repeat(Math.max(0, 60 - name.length))}`)
    const t = Date.now()
    const code = await run(args, env)
    results.push({ name, code, seconds: (Date.now() - t) / 1000 })
  }
} finally {
  await server?.close()
}

console.log(`\n=== summary (${group}) ${'='.repeat(50)}`)
for (const { name, code, seconds } of results) {
  console.log(`  ${code === 0 ? 'ok  ' : 'FAIL'}  check:${name.padEnd(12)} ${seconds.toFixed(1).padStart(6)} s`)
}
const bad = results.filter((r) => r.code !== 0)
console.log(`\n${bad.length ? `${bad.length} of ${results.length} failed` : `all ${results.length} passed`} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
process.exit(bad.length ? 1 : 0)
