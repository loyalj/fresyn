/**
 * Builds the game runtime into dist-runtime/, for a game to copy in:
 *
 *   fresyn-processor.js   the AudioWorklet: the engine, every module, the player
 *   fresyn-runtime.js     the game's side, an ES module of a few kilobytes
 *   types/                its type definitions, from runtime/client.d.ts down
 *
 * The worklet is one self-contained script, as the rack's own is, because an
 * AudioWorkletGlobalScope has no module loader in every browser worth
 * supporting. The client imports nothing at run time, so it bundles to
 * itself alone.
 *
 * Run with: npm run build:runtime
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-runtime')
rmSync(out, { recursive: true, force: true })

const common = { bundle: true, target: 'es2022', minify: true, sourcemap: true, logLevel: 'warning' }

await build({
  ...common,
  entryPoints: [join(root, 'src/runtime/processor.ts')],
  outfile: join(out, 'fresyn-processor.js'),
  format: 'iife',
})
await build({
  ...common,
  entryPoints: [join(root, 'src/runtime/client.ts')],
  outfile: join(out, 'fresyn-runtime.js'),
  format: 'esm',
})

const tsc = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.runtime.json'], {
  cwd: root,
  stdio: 'inherit',
})
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

// The entry point's types, where a game's import of fresyn-runtime.js looks for them.
writeFileSync(join(out, 'fresyn-runtime.d.ts'), "export * from './types/runtime/client'\n")

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
writeFileSync(
  join(out, 'VERSION.txt'),
  `fresyn runtime, built from fresyn ${pkg.version} on ${new Date().toISOString()}\n`,
)
console.log('built dist-runtime/')
