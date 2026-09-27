/**
 * Drives the cable UI in a real browser: flips the rack, drags a cable between
 * two jacks, and pulls it back out.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
import { check, finish, flipRack, open, settle, waitUntil } from './harness.mjs'

// Tall enough for the whole rack: a drag can only hit jacks that are on
// screen, and both ends of a cable have to be visible at once.
const { page, url } = await open({ viewport: { width: 1200, height: 1900 } })
const flip = (toBack) => flipRack(page, toBack)

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
/** Until the rack draws n cables. The check after it says whether it did. */
const cablesBecome = (n) =>
  waitUntil(page, (n) => document.querySelectorAll('.cables g.cable:not(.cable-dragging)').length === n, {
    args: [n],
    timeout: 2000,
  })

const isOccupied = (moduleId, portId) =>
  page.evaluate(
    (m, p) =>
      !!document.querySelector(`.jack[data-module="${m}"][data-port="${p}"]`)?.classList.contains('occupied'),
    moduleId,
    portId,
  )

await page.goto(url, { waitUntil: 'networkidle0' })

// --- flip ------------------------------------------------------------
console.log('\nflip')
await flip(true)

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
  await cablesBecome(initial + 1)

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
  await cablesBecome(initial)

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
    await settle(80)
    check(
      'hovering a cable highlights it',
      await page.evaluate(() => !!document.querySelector('.cable.hovered')),
    )

    const before = await cableCount()
    await page.mouse.down()
    await page.mouse.up()
    await cablesBecome(before - 1)
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
      await settle(40)
      if (!(await page.evaluate(() => !!document.querySelector('.cable.hovered')))) misses++
    }
    check(
      'every point along it is grabbable',
      misses === 0,
      `${misses} missed of ${points.out.length - overJacks} (${overJacks} behind controls)`,
    )
  }
}

// --- patching from the keyboard ---------------------------------------
// Enter on a jack picks a cable up, Enter on a jack of the other kind plugs
// it in, and Escape puts it down -- the drag, without a pointer.
console.log('\npatching from the keyboard')
{
  check(
    'the face turned away is inert',
    await page.evaluate(() => [...document.querySelectorAll('.unit-face-front')].every((f) => f.inert)),
  )
  const free = await page.evaluate(() => {
    const jacks = [...document.querySelectorAll('.jack')].filter((j) => !j.classList.contains('occupied'))
    const out = jacks.find((j) => j.dataset.kind === 'output')
    const inp = jacks.find((j) => j.dataset.kind === 'input' && j.dataset.module !== out?.dataset.module)
    return out && inp
      ? {
          out: { m: out.dataset.module, p: out.dataset.port, label: out.getAttribute('aria-label'), tab: out.tabIndex },
          inp: { m: inp.dataset.module, p: inp.dataset.port },
        }
      : null
  })
  check('there is a free output and a free input', !!free)
  if (free) {
    check('a jack is in the tab order', free.out.tab === 0)
    check('and says whose it is', free.out.label.includes(free.out.m) && free.out.label.includes('output'), free.out.label)
    const focusJack = (j) =>
      page.evaluate(
        ({ m, p }) => document.querySelector(`.jack[data-module="${m}"][data-port="${p}"]`).focus(),
        j,
      )
    const before = await cableCount()
    await focusJack(free.out)
    await page.keyboard.press('Enter')
    await settle(150)
    check('Enter on an output picks a cable up', await page.evaluate(() => !!document.querySelector('.cable-dragging')))
    check(
      'and the inputs light up',
      (await page.evaluate(() => document.querySelectorAll('.jack.candidate').length)) > 0,
    )
    await focusJack(free.inp)
    await page.keyboard.press('Enter')
    await cablesBecome(before + 1)
    check('Enter on an input plugs it in', (await cableCount()) === before + 1, `${before} -> ${await cableCount()}`)
    check('the input reads as occupied', await isOccupied(free.inp.m, free.inp.p))
    check('and nothing is left in hand', await page.evaluate(() => !document.querySelector('.cable-dragging')))
    check(
      'the jack says it is patched now',
      await page.evaluate(
        ({ m, p }) => /patched/.test(document.querySelector(`.jack[data-module="${m}"][data-port="${p}"]`).getAttribute('aria-label')),
        free.inp,
      ),
    )

    // Space works as Enter does, and Escape puts the cable down again.
    await focusJack(free.out)
    await page.keyboard.press('Space')
    await settle(150)
    check('Space picks one up too', await page.evaluate(() => !!document.querySelector('.cable-dragging')))
    await page.keyboard.press('Escape')
    await settle(150)
    check('Escape puts it down', await page.evaluate(() => !document.querySelector('.cable-dragging')))
    check('without patching anything', (await cableCount()) === before + 1)
    check('and without offering modules for it', await page.evaluate(() => !document.querySelector('.search')))
  }
}

// --- flip back -------------------------------------------------------
console.log('\nflip back')
await flip(false)
check('rack returns to the front', await page.evaluate(() => !document.querySelector('.rack-flipped')))
check('cables are hidden on the front', (await cableCount()) === 0)
check('knobs are back', (await page.evaluate(() => document.querySelectorAll('.knob').length)) > 0)

await finish()
