/**
 * End-to-end check in a real browser. Verifies the AudioWorklet actually
 * registers, that the live UI boots it, that the mixer's meters follow what
 * the rack is doing, and that an offline render produces the same samples
 * the Node harness does.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
import { finish, open, problems, settle, waitUntil } from './harness.mjs'

const { page, url } = await open({ httpErrors: true })

await page.goto(url, { waitUntil: 'networkidle0' })

// Click the real Trigger button first: this exercises the actual app path
// (AudioContext creation + addModule + node wiring). The lamp lights once the
// engine is up and has been told about the press.
await page.click('.trigger')
await waitUntil(page, () => !!document.querySelector('.led.on'))

const live = await page.evaluate(() => ({
  ledOn: !!document.querySelector('.led.on'),
  knobs: document.querySelectorAll('.knob').length,
  // The header meter moved onto the mixer, where there is one per channel
  // plus the main bus.
  headerMeter: !!document.querySelector('.meter'),
  meters: document.querySelectorAll('.strip-meter').length,
  // The oscillator has one of its own now, reading what it puts out after
  // its envelope and its Level knob. The stock rack holds one oscillator.
  oscMeters: document.querySelectorAll('.osc-meter').length,
}))

// Meters: the bars are driven straight from the audio thread rather than
// through React, so the only honest way to check them is to make a noise and
// read the geometry back off the page.
//
// How full a bar is, as the draw loop leaves it. The fill is clipped from
// the top, so no clip at all is silence.
const fillOf = (selector) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map((e) => {
        const m = /inset\(([\d.]+)%/.exec(e.style.clipPath || '')
        return m ? 1 - Number(m[1]) / 100 : 0
      }),
    selector,
  )
const barFill = () => fillOf('.strip-meter-fill')
// Driven by a loop of its own, from a level the module reports for itself, so
// a mixer meter moving says nothing about whether this one does.
const oscFill = () => fillOf('.osc-meter-fill')

// A key on the Keyboard's panel, held with the mouse: the stock rack has no
// Trigger, so its own keys are how it is played by hand.
const key = await (await page.$('.keys-key')).boundingBox()
await page.mouse.move(key.x + key.width / 2, key.y + key.height * 0.8)
await page.mouse.down()
// The fullest bar of either kind, read the same way as fillOf, compared in
// the page so the wait ends the frame it comes true.
const meters = (above, below) =>
  waitUntil(
    page,
    (above, below) => {
      const fullest = (sel) =>
        Math.max(
          0,
          ...[...document.querySelectorAll(sel)].map((e) => {
            const m = /inset\(([\d.]+)%/.exec(e.style.clipPath || '')
            return m ? 1 - Number(m[1]) / 100 : 0
          }),
        )
      const levels = [fullest('.strip-meter-fill'), fullest('.osc-meter-fill')]
      return above !== null ? levels.every((v) => v > above) : levels.every((v) => v < below)
    },
    { timeout: 5000, args: [above, below] },
  )
// Held until both kinds of meter show something.
await meters(0.05, null)
const sounding = await barFill()
const oscSounding = await oscFill()
await page.mouse.up()
// Until every bar has fallen to the floor. A full-scale bar takes over a
// second; this waits for it rather than for a guess at it. Below the bar the
// check sets, so a reading taken a frame later cannot land on the line.
await meters(null, 0.01)
const silent = await barFill()
const oscSilent = await oscFill()

const metersMoved = sounding.some((v) => v > 0.05)
const metersFell = silent.every((v) => v < 0.02)
const oscMoved = oscSounding.some((v) => v > 0.05)
const oscFell = oscSilent.every((v) => v < 0.02)

// Then render the same worklet offline and inspect the samples. This also
// exercises the export path: compile a patch, hand it to the processor at
// construction, render faster than realtime.
const render = await page.evaluate(async () => {
  const [{ compile }, { triggerPatch }, worklet] = await Promise.all([
    import('/src/patch/compile.ts'),
    import('/src/patch/defaultPatch.ts'),
    import('/src/dsp/worklet.ts?worker&url'),
  ])
  const compiled = compile(triggerPatch())

  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 24000, sampleRate: 48000 })
  await ctx.audioWorklet.addModule(worklet.default)
  const node = new AudioWorkletNode(ctx, 'fresyn-voice', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { tracks: [{ id: 'bench', patch: compiled, params: compiled.params }], autoGate: true },
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
    processorOptions: { tracks: [{ id: 'bench', patch: compiled, params: compiled.params }], autoGate: true },
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
console.log('osc meter   :', `sounding [${oscSounding.map((v) => v.toFixed(2))}] -> silent [${oscSilent.map((v) => v.toFixed(2))}]`)
if (live.oscMeters !== 1) problems.push(`expected 1 oscillator meter, found ${live.oscMeters}`)
if (!oscMoved) problems.push('the oscillator meter did not move while it was sounding')
if (!oscFell) problems.push('the oscillator meter did not fall back to silence')
console.log('no recorder : an osc and a mixer reach the speakers, peak=%s',
  basic.peak.toFixed(4))
console.log('compiled    : %d modules  %s', render.modules, render.order)
console.log('offline     : peak=%s rms=%s nan=%d frames=%d',
  render.peak.toFixed(4), render.rms.toFixed(4), render.nan, render.frames)
if (render.warnings.length) console.log('warnings    :', render.warnings)

// The autosave says when it could not save, and is written on the way out
// rather than only after the debounce.
{
  const nudge = async () => {
    await page.evaluate(() => document.querySelector('.unit-face-front .knob svg[role="slider"]')?.focus())
    await page.keyboard.press('ArrowUp')
  }
  const warning = () =>
    page.evaluate(() => document.querySelector('.notice-warn .notice-text')?.textContent ?? null)
  await page.evaluate(() => {
    const real = Storage.prototype.setItem
    window.__realSetItem = real
    Storage.prototype.setItem = function (key, value) {
      if (key === 'fresyn.project.v1') throw new DOMException('full', 'QuotaExceededError')
      return real.call(this, key, value)
    }
  })
  await nudge()
  await waitUntil(page, () => !!document.querySelector('.notice-warn .notice-text'), { timeout: 3000 })
  const said = await warning()
  if (!said || !/Autosave failed/.test(said)) problems.push(`a failed autosave was not reported (${said})`)
  await nudge()
  // A second failed save should add nothing, and there is no sign to wait
  // for when nothing happens -- so this stays a plain pause past the debounce.
  await settle(700)
  const stillOne = await page.evaluate(() => document.querySelectorAll('.notice-warn').length)
  if (stillOne !== 1) problems.push(`the autosave warning appeared ${stillOne} times`)
  // Stays until it is dismissed: the plain notices go after four seconds.
  await settle(4300)
  if (!(await warning())) problems.push('the autosave warning did not stay up')

  await page.evaluate(() => {
    Storage.prototype.setItem = window.__realSetItem
  })
  await nudge()
  await waitUntil(page, () => !document.querySelector('.notice-warn .notice-text'), { timeout: 3000 })
  if (await warning()) problems.push('the autosave warning did not clear once a save succeeded')

  // Flushed on pagehide, well inside the 400 ms debounce.
  const savedBefore = await page.evaluate(() => localStorage.getItem('fresyn.project.v1'))
  await nudge()
  const flushed = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'))
    return localStorage.getItem('fresyn.project.v1')
  })
  if (flushed === savedBefore) problems.push('the autosave was not written on pagehide')
  console.log('autosave    :', said, '| flushed on pagehide:', flushed !== savedBefore)
}

await finish({
  ok: render.peak > 0.01 && render.nan === 0 && render.warnings.length === 0 && live.ledOn,
})
