/**
 * Drives the cable UI in a real browser: flips the rack, drags a cable between
 * two jacks, and pulls it back out.
 *
 * Needs `npm run dev -- --port 5199` in another terminal.
 * Point CHROME_PATH at a Chromium build if the default is wrong.
 */
import puppeteer from 'puppeteer-core'

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
const URL = process.env.DEV_URL || 'http://localhost:5199/'
const FLIP_SETTLE = 700

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
})
const page = await browser.newPage()
// Tall enough for the whole rack: a drag can only hit jacks that are on
// screen, and both ends of a cable have to be visible at once.
await page.setViewport({ width: 1200, height: 1900 })

const problems = []
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) problems.push('console: ' + m.text())
})
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const centreOf = (moduleId, portId) =>
  page.evaluate(
    (m, p) => {
      const el = document.querySelector(`.jack[data-module="${m}"][data-port="${p}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    },
    moduleId,
    portId,
  )

const cableCount = () =>
  page.evaluate(() => document.querySelectorAll('.cables g.cable:not(.cable-dragging)').length)

const isOccupied = (moduleId, portId) =>
  page.evaluate(
    (m, p) =>
      !!document.querySelector(`.jack[data-module="${m}"][data-port="${p}"]`)?.classList.contains('occupied'),
    moduleId,
    portId,
  )

await page.goto(URL, { waitUntil: 'networkidle0' })

// --- flip ------------------------------------------------------------
console.log('\nflip')
await page.keyboard.press('Tab')
await new Promise((r) => setTimeout(r, FLIP_SETTLE))

check('rack is flipped', await page.evaluate(() => !!document.querySelector('.rack-flipped')))
check('jacks are on screen', (await page.evaluate(() => document.querySelectorAll('.jack').length)) > 0)

const initial = await cableCount()
check('the default patch is drawn as cables', initial === 6, `${initial} cables`)

// --- patch a cable ---------------------------------------------------
console.log('\npatching')
// The oscillator's Env output is the stock rack's one unpatched output, so the
// source starts empty and 'the source output reads as occupied' is a real check.
const from = await centreOf('osc1', 'env')
const to = await centreOf('mix1', 'in2')
check('both jacks were found', !!from && !!to)

if (from && to) {
  check('target input starts empty', !(await isOccupied('mix1', 'in2')))

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2 + 40, { steps: 6 })

  const candidates = await page.evaluate(() => document.querySelectorAll('.jack.candidate').length)
  check('legal destinations light up mid-drag', candidates > 0, `${candidates} highlighted`)
  check('a cable follows the cursor', await page.evaluate(() => !!document.querySelector('.cable-dragging')))

  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 150))

  const after = await cableCount()
  check('the cable is patched', after === initial + 1, `${initial} -> ${after}`)
  check('the input reads as occupied', await isOccupied('mix1', 'in2'))
  check('the source output reads as occupied', await isOccupied('osc1', 'env'))
}

// A cable's invisible hit area used to lie across nearby jacks, so any jack a
// cable happened to cross could not be patched into at all.
console.log('\njacks under cables')
{
  const covered = await page.evaluate(() => {
    const out = []
    for (const jack of document.querySelectorAll('.jack')) {
      const r = jack.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!hit) continue
      if (!hit.closest('.jack')) {
        out.push(`${jack.dataset.module}.${jack.dataset.port} -> ${hit.getAttribute('class')}`)
      }
    }
    return out
  })
  check('every jack is reachable by the pointer', covered.length === 0, covered.join('; '))
}

// --- unplug by dragging out ------------------------------------------
console.log('\nunplugging')
if (from && to) {
  await page.mouse.move(to.x, to.y)
  await page.mouse.down()
  await page.mouse.move(to.x + 40, to.y + 220, { steps: 6 })
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 150))

  const after = await cableCount()
  check('dragging out of a jack unplugs it', after === initial, `back to ${after}`)
  check('the input reads as empty again', !(await isOccupied('mix1', 'in2')))
}

// --- click a cable to unplug -----------------------------------------
console.log('\nclick to unplug')
{
  const mid = await page.evaluate(() => {
    const path = document.querySelector('.cables g.cable .cable-line')
    if (!path) return null
    const p = path.getPointAtLength(path.getTotalLength() / 2)
    const box = path.ownerSVGElement.getBoundingClientRect()
    return { x: box.left + p.x, y: box.top + p.y }
  })
  check('a cable midpoint was located', !!mid)

  if (mid) {
    await page.mouse.move(mid.x, mid.y)
    await new Promise((r) => setTimeout(r, 80))
    check(
      'hovering a cable highlights it',
      await page.evaluate(() => !!document.querySelector('.cable.hovered')),
    )

    const before = await cableCount()
    await page.mouse.down()
    await page.mouse.up()
    await new Promise((r) => setTimeout(r, 150))
    const after = await cableCount()
    check('clicking a cable unplugs it', after === before - 1, `${before} -> ${after}`)
  }
}

// The curve is hit-tested by sampling. Sampling points alone leaves gaps of
// half the sample spacing, so on a long cable the pointer could sit exactly on
// the curve and still miss.
console.log('\ngrabbing along a long cable')
{
  const points = await page.evaluate(() => {
    let longest = null
    let best = 0
    for (const path of document.querySelectorAll('.cables g.cable .cable-line')) {
      const len = path.getTotalLength()
      if (len > best) {
        best = len
        longest = path
      }
    }
    if (!longest) return null
    const box = longest.ownerSVGElement.getBoundingClientRect()
    const out = []
    for (let i = 0; i <= 10; i++) {
      const p = longest.getPointAtLength(best * (0.22 + (0.56 * i) / 10))
      out.push({ x: box.left + p.x, y: box.top + p.y })
    }
    return { length: Math.round(best), out }
  })

  check('a long cable was found', !!points, points ? `${points.length}px` : '')

  if (points) {
    let misses = 0
    let overJacks = 0
    for (const p of points.out) {
      // Anything on the panel that handles its own clicks wins on purpose --
      // that is the rule this whole section exists to protect -- so those
      // points are not the cable's to answer for. A jack is the obvious one;
      // a half-width panel puts its spine and its corner controls out in the
      // middle of the rack, where cables cross them too.
      const onControl = await page.evaluate(
        (q) => !!document.elementFromPoint(q.x, q.y)?.closest('.jack, .unit-controls, .unit-spine'),
        p,
      )
      if (onControl) {
        overJacks++
        continue
      }
      await page.mouse.move(p.x, p.y)
      await new Promise((r) => setTimeout(r, 40))
      if (!(await page.evaluate(() => !!document.querySelector('.cable.hovered')))) misses++
    }
    check(
      'every point along it is grabbable',
      misses === 0,
      `${misses} missed of ${points.out.length - overJacks} (${overJacks} behind controls)`,
    )
  }
}

// --- flip back -------------------------------------------------------
console.log('\nflip back')
await page.keyboard.press('Tab')
await new Promise((r) => setTimeout(r, FLIP_SETTLE))
check('rack returns to the front', await page.evaluate(() => !document.querySelector('.rack-flipped')))
check('cables are hidden on the front', (await cableCount()) === 0)
check('knobs are back', (await page.evaluate(() => document.querySelectorAll('.knob').length)) > 0)

console.log('\nproblems    :', problems.length ? problems : 'none')
await browser.close()

const ok = failures === 0 && problems.length === 0
console.log(ok ? '\nPASS' : `\nFAIL (${failures} check(s))`)
process.exit(ok ? 0 : 1)
