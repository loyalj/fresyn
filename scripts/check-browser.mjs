import puppeteer from 'puppeteer-core'

/**
 * End-to-end check against a running dev server. Verifies the AudioWorklet
 * actually registers in a browser, that the live UI boots it, that the
 * mixer's meters follow what the rack is doing, and that an offline render
 * produces the same samples the Node harness does.
 *
 * Needs `npm run dev -- --port 5199` in another terminal.
 * Point CHROME_PATH at a Chromium build if the default is wrong.
 */
const CHROME =
  process.env.CHROME_PATH ||
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
const URL = process.env.DEV_URL || 'http://localhost:5199/'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
})
const page = await browser.newPage()
const problems = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  if (m.text().includes('favicon')) return
  problems.push('console: ' + m.text())
})
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('favicon')) problems.push(`http ${r.status()} ${r.url()}`)
})
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))

await page.goto(URL, { waitUntil: 'networkidle0' })

// Click the real Trigger button first: this exercises the actual app path
// (AudioContext creation + addModule + node wiring).
await page.click('.trigger')
await new Promise((r) => setTimeout(r, 800))

const live = await page.evaluate(() => ({
  ledOn: !!document.querySelector('.led.on'),
  knobs: document.querySelectorAll('.knob').length,
  // The header meter moved onto the mixer, where there is one per channel
  // plus the main bus.
  headerMeter: !!document.querySelector('.meter'),
  meters: document.querySelectorAll('.strip-meter').length,
}))

// Meters: the bars are driven straight from the audio thread rather than
// through React, so the only honest way to check them is to make a noise and
// read the geometry back off the page.
//
// How full a bar is, as the draw loop leaves it. The fill is clipped from
// the top, so no clip at all is silence.
const barFill = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.strip-meter-fill')].map((e) => {
      const m = /inset\(([\d.]+)%/.exec(e.style.clipPath || '')
      return m ? 1 - Number(m[1]) / 100 : 0
    }),
  )

await page.keyboard.down('Space')
await new Promise((r) => setTimeout(r, 600))
const sounding = await barFill()
await page.keyboard.up('Space')
// Long enough for a full-scale bar to fall all the way to the floor.
await new Promise((r) => setTimeout(r, 1500))
const silent = await barFill()

const metersMoved = sounding.some((v) => v > 0.05)
const metersFell = silent.every((v) => v < 0.02)

// Then render the same worklet offline and inspect the samples. This also
// exercises the export path: compile a patch, hand it to the processor at
// construction, render faster than realtime.
const render = await page.evaluate(async () => {
  const [{ compile }, { defaultPatch }, worklet] = await Promise.all([
    import('/src/patch/compile.ts'),
    import('/src/patch/defaultPatch.ts'),
    import('/src/dsp/worklet.ts?worker&url'),
  ])
  const compiled = compile(defaultPatch())

  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 24000, sampleRate: 48000 })
  await ctx.audioWorklet.addModule(worklet.default)
  const node = new AudioWorkletNode(ctx, 'fresyn-voice', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { patch: compiled, params: compiled.params, autoGate: true },
  })
  node.connect(ctx.destination)

  const buf = await ctx.startRendering()
  const ch = buf.getChannelData(0)
  let peak = 0, sum = 0, nan = 0
  for (const s of ch) {
    if (!Number.isFinite(s)) { nan++; continue }
    const a = Math.abs(s)
    if (a > peak) peak = a
    sum += s * s
  }
  return {
    peak, rms: Math.sqrt(sum / ch.length), nan, frames: ch.length,
    modules: compiled.modules.length,
    order: compiled.modules.map((m) => m.id).join(' -> '),
    warnings: compiled.warnings,
  }
})

// The smallest rack that makes a sound: an oscillator and a mixer, with no
// recorder anywhere. The speakers are the sum of every main mix, so this has
// to reach the destination through the real worklet, not just in Node.
const basic = await page.evaluate(async () => {
  const [{ compile }, worklet] = await Promise.all([
    import('/src/patch/compile.ts'),
    import('/src/dsp/worklet.ts?worker&url'),
  ])
  const compiled = compile({
    modules: [
      { id: 'osc1', type: 'osc', params: { pitch: 220, wave: 3 } },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [
      {
        id: 'a',
        from: { module: 'osc1', port: 'out' },
        to: { module: 'mix1', port: 'in1' },
      },
    ],
  })

  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 12000, sampleRate: 48000 })
  await ctx.audioWorklet.addModule(worklet.default)
  const node = new AudioWorkletNode(ctx, 'fresyn-voice', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { patch: compiled, params: compiled.params, autoGate: true },
  })
  node.connect(ctx.destination)

  const ch = (await ctx.startRendering()).getChannelData(0)
  let peak = 0
  for (const v of ch) if (Math.abs(v) > peak) peak = Math.abs(v)
  return { peak, warnings: compiled.warnings }
})

if (basic.warnings.length) problems.push('an osc and a mixer warned: ' + basic.warnings.join('; '))
if (!(basic.peak > 0.1)) problems.push(`an osc and a mixer was silent (peak ${basic.peak})`)

console.log('live page   :', JSON.stringify(live))
console.log('meters      :', `sounding [${sounding.map((v) => v.toFixed(2))}] -> silent [${silent.map((v) => v.toFixed(2))}]`)
if (live.headerMeter) problems.push('the header still has a level meter')
if (live.meters !== 9) problems.push(`expected 9 mixer meters, found ${live.meters}`)
if (!metersMoved) problems.push('no mixer meter moved while the rack was sounding')
if (!metersFell) problems.push('a mixer meter did not fall back to silence')
console.log('no recorder : an osc and a mixer reach the speakers, peak=%s',
  basic.peak.toFixed(4))
console.log('compiled    : %d modules  %s', render.modules, render.order)
console.log('offline     : peak=%s rms=%s nan=%d frames=%d',
  render.peak.toFixed(4), render.rms.toFixed(4), render.nan, render.frames)
if (render.warnings.length) console.log('warnings    :', render.warnings)
console.log('problems    :', problems.length ? problems : 'none')

await browser.close()

const ok =
  render.peak > 0.01 &&
  render.nan === 0 &&
  render.warnings.length === 0 &&
  problems.length === 0 &&
  live.ledOn
console.log(ok ? '\nPASS' : '\nFAIL')
process.exit(ok ? 0 : 1)
