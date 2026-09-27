/**
 * Runs one of the TypeScript checks: `node scripts/run-ts.mjs check-dsp`.
 *
 * The headless checks import the real DSP and patch code, which is written
 * for Vite -- extensionless imports, `.ts` everywhere -- and Node will not run
 * that as it stands. So each one is bundled with esbuild first, into
 * node_modules/.cache where nothing else looks, and the bundle is what runs.
 * This used to be the same esbuild command line copied into seven package
 * scripts.
 *
 * The bundle is imported rather than spawned: one process, and its
 * process.exit is the exit code.
 */
import { build } from 'esbuild'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const name = process.argv[2]?.replace(/\.ts$/, '')
const entry = name && join(root, 'scripts', `${name}.ts`)

if (!entry || !existsSync(entry)) {
  console.error(`usage: node scripts/run-ts.mjs <name>   (runs scripts/<name>.ts)${name ? `\nno such file: ${entry}` : ''}`)
  process.exit(2)
}

const outdir = join(root, 'node_modules/.cache')
mkdirSync(outdir, { recursive: true })
const outfile = join(outdir, `${name}.mjs`)

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'warning',
})

// Whatever follows the name is the check's own argv.
process.argv.splice(2, 1)
await import(pathToFileURL(outfile).href)
