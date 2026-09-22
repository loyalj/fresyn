import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The worklet is imported with `?worker&url`, which bundles it as a
  // self-contained IIFE. AudioWorkletGlobalScope has no module loader in
  // every browser we care about, so inlining deps is the safe option.
  worker: { format: 'iife' },
  server: {
    // Required for SharedArrayBuffer, which the param bus will move to once
    // knob traffic outgrows postMessage.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
