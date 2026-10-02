import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { parseKnobHelp } from './src/patch/knobHelp'

/**
 * The knob tables out of MANUAL.md, as data, at build time.
 *
 * The hover help is the last column of every module's table in the manual,
 * and it used to be found by shipping the whole manual -- a hundred and fifty
 * kilobytes of tutorials -- and parsing it as the page loaded. The same
 * parser runs here instead, on `MANUAL.md?knob-help`, and only what it finds
 * goes into the bundle.
 *
 * The manual is still the module being imported, so in dev an edit to it
 * reaches the page the way it did when the whole file was imported.
 */
function knobHelp(): Plugin {
  return {
    name: 'fresyn-knob-help',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.md?knob-help')) return
      const entries = [...parseKnobHelp(code)].map(([module, knobs]) => [module, [...knobs]])
      return { code: `export default ${JSON.stringify(entries)}`, map: null }
    },
  }
}

export default defineConfig({
  plugins: [react(), knobHelp()],
  // The worklet is imported with `?worker&url`, which bundles it as a
  // self-contained IIFE. AudioWorkletGlobalScope has no module loader in
  // every browser we care about, so inlining deps is the safe option.
  worker: { format: 'iife' },
  // The encoders are imported only by the bounce worker, and the dev server's
  // dependency scan does not follow `new Worker(new URL(...))`. Unlisted, it
  // found them on the first bounce, re-optimised, and reloaded the page out
  // from under it. Dev only: a build is unaffected.
  optimizeDeps: { include: ['wasm-media-encoders'] },
  build: {
    // Every browser that runs an AudioWorklet runs ES2022, and so does React
    // 19. Vite's default target is older, which lowered every class field in
    // the DSP to a `defineProperty` helper -- hundreds of them in the
    // worklet, run each time a voice or a module is built on the audio thread.
    target: 'es2022',
    // Nothing that lacks modulepreload can run this app anyway.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // React on its own, so a release that only touches the app leaves
        // the largest file a returning browser has cached exactly where it was.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
        },
      },
    },
  },
  server: {
    // Required for SharedArrayBuffer, which the param bus will move to once
    // knob traffic outgrows postMessage.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
