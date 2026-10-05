import { check, finish, flushAutosave, open, settle, waitUntil } from './harness.mjs'

/**
 * End-to-end check for automation lanes: a knob's right-click opens a lane
 * for it under the roll, points are drawn, moved, held and bent there and
 * each is one step of undo, the song plays them -- the engine is sent the
 * curves and the knob moves by itself -- a hand on the knob takes it from
 * the automation until the song stops, a fader is automated the same way,
 * and the lanes are kept with the project.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1100 } })
// What the page tells the audio thread about automation.
await page.evaluateOnNewDocument(() => {
  window.__sent = []
  const Real = window.AudioWorkletNode
  window.AudioWorkletNode = class extends Real {
    constructor(...a) {
      super(...a)
      const post = this.port.postMessage.bind(this.port)
      this.port.postMessage = (msg, ...rest) => {
        if (msg?.type === 'schedule') for (const e of msg.events) if (e.kind === 'auto') window.__sent.push(e)
        if (msg?.type === 'hold' || msg?.type === 'clearAutomation') window.__sent.push(msg)
        return post(msg, ...rest)
      }
    }
  }
})
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const KNOB = '.unit-flip[data-module="lpf1"] .knob[data-midi-param="cutoff"]'
const TARGET = 'rack/bench/lpf1.cutoff'
const lanes = async () => {
  await flushAutosave(page)
  return page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}').song?.patterns?.[0]?.automation ?? [])
}
const points = async (target = TARGET) => (await lanes()).find((l) => l.target === target)?.points ?? []
const sent = () => page.evaluate(() => window.__sent)
const knob = () => page.$eval(KNOB, (k) => ({ now: Number(k.querySelector('svg').getAttribute('aria-valuenow')), following: k.classList.contains('following'), automated: k.classList.contains('automated') }))
const menuItem = async (text) => {
  const el = (await page.evaluateHandle((t) => [...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes(t)) ?? null, text)).asElement()
  if (el) await el.click()
  await settle(200)
  return !!el
}
const key = async (combo) => {
  const parts = combo.split('+')
  const k = parts.pop()
  for (const m of parts) await page.keyboard.down(m)
  await page.keyboard.press(k)
  for (const m of parts.reverse()) await page.keyboard.up(m)
  await settle(200)
}
const own = (await knob()).now

console.log('\na lane from a knob')
{
  const box = await (await page.$(`${KNOB} svg`)).boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await settle(150)
  check('a knob\'s menu offers to automate it', await menuItem('Automate in this pattern'))
  await waitUntil(page, () => !!document.querySelector('.auto-lane-canvas'), { timeout: 3000 }).catch(() => {})
  check('which opens its lane under the roll', !!(await page.$('.auto-lane-canvas')))
  check('named in its header', (await page.$eval(`.auto-lane[data-target="${TARGET}"] .auto-lane-name`, (e) => e.textContent ?? '')).includes('Cutoff'))
  check('an empty lane is in the pattern, and changes nothing yet', JSON.stringify(await lanes()) === JSON.stringify([{ target: TARGET, points: [] }]))
}

const lane = await (await page.$('.auto-lane-canvas')).boundingBox()
const gutter = Number(await page.$eval('.roll-canvas', (c) => c.dataset.gutter))
const length = Number(await page.$eval('.auto-lane-canvas', (c) => c.dataset.length))
const across = lane.width - gutter - Number(await page.$eval('.roll-canvas', (c) => c.dataset.scrollW))
const PAD = 7
const xAt = (tick) => lane.x + gutter + (tick / length) * across
const yAt = (value) => lane.y + PAD + (1 - value) * (lane.height - 2 * PAD)

console.log('\ndrawing')
{
  await page.mouse.click(xAt(0), yAt(0.1))
  await settle(150)
  await page.mouse.click(xAt(length / 2), yAt(0.9))
  await settle(150)
  await page.mouse.click(xAt(length - 240), yAt(0.1))
  await settle(150)
  const drawn = await points()
  check('three clicks are three points, on the grid', drawn.length === 3 && drawn.every((p) => p.tick % 240 === 0), JSON.stringify(drawn))
  check('where they were clicked', Math.abs(drawn[1].value - 0.9) < 0.03 && drawn[1].tick === length / 2, JSON.stringify(drawn[1]))
  check('and the knob says it is automated', (await knob()).automated)

  await page.mouse.move(xAt(length / 2), yAt(0.9))
  await page.mouse.down()
  await page.mouse.move(xAt(length / 2 + 240), yAt(0.6), { steps: 6 })
  await page.mouse.up()
  await settle(200)
  const moved = await points()
  check('a point dragged moves, snapped across and free up and down', moved[1].tick === length / 2 + 240 && Math.abs(moved[1].value - 0.6) < 0.03, JSON.stringify(moved[1]))
  await key('Control+KeyZ')
  check('and the drag is one step of undo', JSON.stringify(await points()) === JSON.stringify(drawn))

  await page.mouse.click(xAt(length / 2), yAt(0.9), { button: 'right' })
  await settle(150)
  check('a point\'s right-click offers its shapes', await menuItem('Hold'))
  check('and a hold is kept', (await points())[1].shape === 'hold')
  await page.mouse.click(xAt(0), yAt(0.1), { button: 'right' })
  await settle(150)
  await menuItem('Curve')
  // The handle half way along the first stretch, on the curve: dragged up.
  const p = await points()
  const mid = (p[0].tick + p[1].tick) / 2
  const midValue = p[0].value + (p[1].value - p[0].value) * Math.pow(0.5, Math.pow(4, p[0].tension ?? 0))
  await page.mouse.move(xAt(mid), yAt(midValue))
  await page.mouse.down()
  await page.mouse.move(xAt(mid), yAt(midValue) - 40, { steps: 6 })
  await page.mouse.up()
  await settle(200)
  const bent = (await points())[0]
  check('dragging a curve\'s handle up bends it up', bent.shape === 'curve' && bent.tension < (p[0].tension ?? 0), JSON.stringify(bent))
}

console.log('\nplaying it')
{
  await page.evaluate(() => {
    window.__sent = []
  })
  await page.click('.dock-play')
  const seen = []
  for (let i = 0; i < 8; i++) {
    await settle(200)
    seen.push(await knob())
  }
  const curves = (await sent()).filter((e) => e.kind === 'auto' && e.key === 'lpf1.cutoff')
  check('the engine is sent the lane\'s curves', curves.length >= 2 && curves.some((e) => e.curve?.map?.kind === 'exp'))
  check('the knob moves by itself as it plays', seen.every((k) => k.following) && new Set(seen.map((k) => k.now)).size > 3, JSON.stringify(seen.map((k) => k.now)))

  // A hand on it takes it from the automation -- scrolled into view first,
  // clear of the dock, as a person would.
  await page.$eval(KNOB, (el) => el.scrollIntoView({ block: 'center' }))
  await settle(200)
  const box = await (await page.$(`${KNOB} svg`)).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 30, { steps: 5 })
  await page.mouse.up()
  await settle(300)
  check('turning it while it plays takes it from the automation', (await sent()).some((e) => e.type === 'hold' && e.key === 'lpf1.cutoff' && e.on))
  check('and it stops following its curve', !(await knob()).following)

  await page.click('.dock-play')
  await settle(300)
  check('stopping gives every knob back to its panel', (await sent()).some((e) => e.type === 'clearAutomation'))
  const after = await knob()
  check('and the knob shows its own value again', !after.following && after.now !== seen[seen.length - 1].now)
  check('which the hand moved', after.now !== own)
}

console.log('\na fader, and keeping it')
{
  await page.evaluate(() => [...document.querySelectorAll('.dock-view button, button')].find((b) => b.textContent.trim() === 'Mix')?.click())
  await settle(300)
  const fader = await page.$('.mix-strip:not(.mix-master) .mix-fader')
  check('the Mix view is showing', !!fader)
  if (fader) {
    const fb = await fader.boundingBox()
    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2, { button: 'right' })
    await settle(150)
    check('a fader offers to be automated too', await menuItem('Automate in this pattern'))
    await settle(300)
    check('which goes back to the roll, with its lane open beside the first', !!(await page.$('.auto-lane[data-target="strip/bench/gain"]')) && !!(await page.$(`.auto-lane[data-target="${TARGET}"]`)))
  }
  // Two lanes open at once, each its own height.
  const body = (t) => page.$eval(`.auto-lane[data-target="${t}"] .auto-lane-body`, (e) => e.getBoundingClientRect().height)
  const before = await body(TARGET)
  const grip = await (await page.$(`.auto-lane[data-target="${TARGET}"] .auto-lane-grip`)).boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 3)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 43, { steps: 5 })
  await page.mouse.up()
  await settle(150)
  check('a lane is made taller by its bottom edge, and only that lane', Math.abs((await body(TARGET)) - before - 40) < 3 && Math.abs((await body('strip/bench/gain')) - before) < 3)

  const kept = await lanes()
  await page.reload({ waitUntil: 'networkidle0' })
  await settle(300)
  check('lanes are kept with the project', JSON.stringify(await lanes()) === JSON.stringify(kept) && kept.length === 2, JSON.stringify(kept.map((l) => l.target)))
  const listed = await page.$$eval('.roll-lane-pick optgroup[label^="In this pattern"] option', (os) => os.map((o) => o.value))
  check('and listed in the picker', listed.includes(TARGET) && listed.includes('strip/bench/gain'), JSON.stringify(listed))
  await page.select('.roll-lane-pick', TARGET)
  await settle(200)
  check('picking a lane in the picker opens it', !!(await page.$(`.auto-lane[data-target="${TARGET}"]`)))
  await page.evaluate((t) => [...document.querySelectorAll(`.auto-lane[data-target="${t}"] .auto-lane-btn`)].find((b) => b.textContent.trim() === 'Remove lane')?.click(), TARGET)
  await settle(300)
  check('a lane can be removed', (await lanes()).length === 1)
  await page.focus('.roll-canvas')
  await key('Control+KeyZ')
  check('and brought back', (await lanes()).length === 2)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Song')?.click())
  await settle(400)
  check('a clip draws its automation in the Song view', (await page.$$('.playlist-clip-notes polyline.auto')).length >= 1)
}

console.log('\nrecording a hand on a knob')
{
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Roll')?.click())
  await settle(300)
  const RES = '.unit-flip[data-module="lpf1"] .knob[data-midi-param="resonance"]'
  await page.click('.roll-rec')
  await settle(600)
  check('Rec starts the loop', !!(await page.$('.dock-play.on')))
  await page.$eval(RES, (el) => el.scrollIntoView({ block: 'center' }))
  await settle(200)
  const box = await (await page.$(`${RES} svg`)).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - i * 6)
    await settle(40)
  }
  await page.mouse.up()
  await settle(800)
  const take = await points('rack/bench/lpf1.resonance')
  check('a knob turned while recording gets a lane with the take in it', take.length >= 2, JSON.stringify(take))
  check('thinned, not a point for every pixel', take.length < 12, String(take.length))
  check('rising, as the knob was turned', take.length >= 2 && take[take.length - 1].value > take[0].value)
  // Let go of, it follows its new lane round the loop.
  let followed = false
  for (let i = 0; i < 12 && !followed; i++) {
    await settle(200)
    followed = await page.$eval(RES, (k) => k.classList.contains('following'))
  }
  check('let go of, the knob follows the take on the next pass', followed)
  await page.click('.roll-rec')
  await page.click('.dock-play')
  await settle(300)
  await key('Control+KeyZ')
  check('the take is one step of undo', (await points('rack/bench/lpf1.resonance')).length === 0)
}

await finish()
