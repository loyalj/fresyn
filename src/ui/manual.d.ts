/**
 * The manual's knob tables, as the build reads them out of it: each module's
 * name with its knobs' labels and what each one does. See `knobHelp` in
 * vite.config.ts.
 */
declare module '*.md?knob-help' {
  const help: [module: string, knobs: [label: string, text: string][]][]
  export default help
}
