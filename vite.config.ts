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
  build: {
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
