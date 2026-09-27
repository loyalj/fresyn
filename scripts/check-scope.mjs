/**
 * Drives the scope in a real browser, end to end: adds one to the rack,
 * patches an oscillator into it, starts the audio, and then reads the pixels
 * it drew.
 *
 * Reading the canvas is the point. Every other link in this chain -- the ring
 * buffer, the 30 Hz report, the postMessage, the subscription, the draw loop
 * -- can be broken individually and still leave a page that looks alive, so
 * the only check worth making is whether a trace of the right shape reached
 * the screen.
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
// Tall enough that the added unit and the oscillator are both on screen: a
// drag can only reach jacks the pointer can actually travel between. The head
// panel is part of that height, so this has room to spare over the rack.
await page.setViewport({ width: 1200, height: 2200 })

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
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms))

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

/**
 * What the scope actually painted, in its own colour.
 *
 * The trace is picked out by hue rather than by "not background": the grid
 * and the zero axis are strokes too, so counting lit pixels would pass even
 * if no signal ever arrived.
 */
const trace = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.scope-screen')
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    const { data } = ctx.getImageData(0, 0, width, height)

    let lit = 0
    let top = height
    let bottom = -1
    const columns = new Set()
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        // The accent is #f0a641; the grid is a cold grey and misses this.
        if (data[i + 3] > 40 && data[i] > 170 && data[i + 1] > 90 && data[i + 2] < 140) {
          lit++
          columns.add(x)
          if (y < top) top = y
          if (y > bottom) bottom = y
        }
      }
    }
    return { lit, width, height, spread: bottom - top, columns: columns.size }
  })

/**
 * The same, for the second trace.
 *
 * B is drawn in the text colour rather than the accent, so it is picked out
 * the other way round: bright, and with no warmth to it. A screen with only
 * A on it has to come back empty here, or the check below would pass on the
 * first trace being counted twice.
 */
const traceB = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.scope-screen')
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    const { data } = ctx.getImageData(0, 0, width, height)

    let lit = 0
    let top = height
    let bottom = -1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        // Grey: no channel far from any other, and bright enough to be a
        // stroke rather than the grid. The accent is orange and fails the
        // first half of that outright.
        const spreadRgb = Math.max(r, g, b) - Math.min(r, g, b)
        if (data[i + 3] > 40 && spreadRgb < 24 && r > 110) {
          lit++
          if (y < top) top = y
          if (y > bottom) bottom = y
        }
      }
    }
    return { lit, spread: bottom - top }
  })

/**
 * The column where the trace reaches its highest point.
 *
 * Deliberately not "the trace's height in some fixed column": where the
 * waveform is steep, the stroke's coverage is spread so thinly down the
 * column that every pixel in it falls under the alpha threshold, and which
 * columns are steep shifts by a pixel between frames. The leftmost peak is a
 * feature of the waveform rather than of the rasteriser.
 */
const peakX = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.scope-screen')
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    const { data } = ctx.getImageData(0, 0, width, height)
    const lit = (x, y) => {
      const i = (y * width + x) * 4
      return data[i + 3] > 20 && data[i] > 170 && data[i + 1] > 90 && data[i + 2] < 140
    }

    let top = -1
    for (let y = 0; y < height && top < 0; y++) {
      for (let x = 0; x < width; x++) if (lit(x, y)) top = y
    }
    if (top < 0) return null

    // Within a pixel of the top, so a peak split across two rows by
    // antialiasing still reports the same column.
    for (let x = 0; x < width; x++) {
      if (lit(x, top) || lit(x, Math.min(height - 1, top + 1))) return x
    }
    return null
  })

await page.goto(URL, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

// --- add one ---------------------------------------------------------
console.log('\nadding a scope')
{

/**
 * Add a module from the Modules menu, wherever in its submenus it lives.
 *
 * The group a module belongs to is declared on its definition, which this
 * script cannot import -- so the groups are walked until the name turns up,
 * and a module that moves between them needs nothing changed here.
 */
const addModule = async (name) => {
  const menu = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Modules'),
  )
  const trigger = menu.asElement()
  if (!trigger) return false
  await trigger.click()
  await settle(120)

  const groups = await page.evaluate(() =>
    [...document.querySelectorAll('.menu > .menu-slot > .menu-item .menu-text')].map((e) =>
      e.textContent.trim(),
    ),
  )
  for (const group of groups) {
    const gh = await page.evaluateHandle(
      (g) =>
        [...document.querySelectorAll('.menu > .menu-slot > .menu-item .menu-text')].find(
          (e) => e.textContent.trim() === g,
        ),
      group,
    )
    const gel = gh.asElement()
    if (!gel) continue
    await gel.hover()
    await settle(120)
    const ih = await page.evaluateHandle(
      (n) =>
        [...document.querySelectorAll('.menu-nested .menu-item .menu-text')].find(
          (e) => e.textContent.trim() === n,
        ) ?? null,
      name,
    )
    const iel = ih.asElement()
    if (iel) {
      await iel.click()
      await settle(300)
      return true
    }
  }
  await page.keyboard.press('Escape')
  await settle(120)
  return false
}

/** Every module the Modules menu offers, across all of its groups. */
const menuModules = async () => {
  const menu = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Modules'),
  )
  await menu.asElement().click()
  await settle(120)
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll('.menu > .menu-slot > .menu-item .menu-text')].map((e) =>
      e.textContent.trim(),
    ),
  )
  const names = []
  for (const group of groups) {
    const gh = await page.evaluateHandle(
      (g) =>
        [...document.querySelectorAll('.menu > .menu-slot > .menu-item .menu-text')].find(
          (e) => e.textContent.trim() === g,
        ),
      group,
    )
    await gh.asElement().hover()
    await settle(120)
    names.push(
      ...(await page.evaluate(() =>
        [...document.querySelectorAll('.menu-nested .menu-item .menu-text')].map((e) =>
          e.textContent.trim(),
        ),
      )),
    )
  }
  await page.keyboard.press('Escape')
  await settle(120)
  return names
}

  await addModule('Scope')
  await settle(400)

  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('.unit-face-front .unit-id')].map((e) => e.textContent),
  )
  check('the scope is in the rack', ids.includes('scope1'), ids.join(','))
  check(
    'it has a screen',
    await page.evaluate(() => !!document.querySelector('canvas.scope-screen')),
  )
}

/**
 * A short press on the Keyboard's first key, which is how the stock rack is
 * played by hand -- it has no Trigger -- and what starts the audio at all.
 */
async function tapKey() {
  const key = await (await page.$('.keys-key')).boundingBox()
  await page.mouse.move(key.x + key.width / 2, key.y + key.height * 0.8)
  await page.mouse.down()
  await settle(120)
  await page.mouse.up()
}

// --- nothing patched yet ---------------------------------------------
// Worth checking before the signal, not after: a scope that draws a lively
// trace with its input unpatched is drawing something other than its input.
console.log('\nwith nothing patched')
{
  await tapKey()
  await settle(700)

  const idle = await trace()
  check('a trace was drawn', idle && idle.lit > 0, idle ? `${idle.lit} px` : 'no canvas')
  check(
    'it spans the screen',
    idle && idle.columns > idle.width * 0.8,
    idle ? `${idle.columns}/${idle.width} columns` : '',
  )
  // A grounded input is a flat line, give or take the stroke width.
  check('and it is flat', idle && idle.spread <= 4, idle ? `${idle.spread}px tall` : '')
}

// --- patch an oscillator into it -------------------------------------
console.log('\nwith an oscillator patched in')
{
  await page.keyboard.press('Tab')
  await settle(FLIP_SETTLE)

  const from = await centreOf('osc1', 'out')
  const to = await centreOf('scope1', 'in')
  check('both jacks were found', !!from && !!to)

  if (from && to) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    await settle(200)
    check(
      'the scope input is patched',
      await page.evaluate(() =>
        document
          .querySelector('.jack[data-module="scope1"][data-port="in"]')
          ?.classList.contains('occupied'),
      ),
    )
  }

  await page.keyboard.press('Tab')
  await settle(FLIP_SETTLE)

  // The stock rack's oscillator comes up with its own envelope at full, so a
  // note decays to silence in under a second and there would be nothing left
  // to draw. Double-clicking a knob resets it to its default, and Env Amt's
  // default is 0: a free-running oscillator, which is what this wants.
  const envAmt = await page.evaluate(() => {
    const unit = [...document.querySelectorAll('.unit-face-front')].find(
      (u) => u.querySelector('.unit-id')?.textContent === 'osc1',
    )
    const el = unit?.querySelector('[aria-label="Env Amt"]')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  check('the oscillator has an Env Amt knob', !!envAmt)
  if (envAmt) {
    await page.mouse.click(envAmt.x, envAmt.y, { clickCount: 2 })
    await settle(150)
  }
  check(
    'double-clicking it turns the envelope off',
    await page.evaluate(() => {
      const unit = [...document.querySelectorAll('.unit-face-front')].find(
        (u) => u.querySelector('.unit-id')?.textContent === 'osc1',
      )
      return unit?.querySelector('[aria-label="Env Amt"]')?.getAttribute('aria-valuenow') === '0'
    }),
  )

  // The oscillator now runs continuously, so the gate only has to open once
  // to get the audio context going.
  await tapKey()
  await settle(800)

  const live = await trace()
  check('a trace was drawn', live && live.lit > 0, live ? `${live.lit} px` : 'no canvas')
  check(
    'it now has vertical extent',
    live && live.spread > live.height * 0.4,
    live ? `${live.spread}px of ${live.height}` : '',
  )
  check(
    'it still spans the screen',
    live && live.columns > live.width * 0.8,
    live ? `${live.columns}/${live.width} columns` : '',
  )

  // The trace is triggered on a rising zero crossing, so successive frames
  // should draw the waveform at the same phase even though each one starts at
  // an arbitrary point in the signal. Without the trigger this wanders over
  // the full height; with it, only the sub-sample rounding is left.
  if (live) {
    const peaks = []
    for (let i = 0; i < 6; i++) {
      peaks.push(await peakX())
      await settle(180)
    }
    const seen = peaks.filter((x) => x !== null)
    const spread = Math.max(...seen) - Math.min(...seen)
    check('every frame drew a peak', seen.length === peaks.length, `${seen.length}/${peaks.length}`)
    // Untriggered, the capture starts at an arbitrary point in the cycle and
    // this would wander over a whole period -- hundreds of pixels wide here.
    check(
      'the trigger holds the waveform still',
      seen.length === peaks.length && spread <= 8,
      `${spread}px of drift across ${live.width}`,
    )
  }
}

// --- the second channel ----------------------------------------------
/**
 * B is the reason the scope has two inputs: one signal against another on the
 * same screen, at the same instant. The filter's output against the
 * oscillator that feeds it is the patch anyone tries first.
 */
console.log('\nwith a second signal on B')
{
  const empty = await traceB()
  check('nothing is drawn on B while it is empty', empty && empty.lit < 40, empty ? `${empty.lit} px` : '')

  await page.keyboard.press('Tab')
  await settle(FLIP_SETTLE)

  const from = await centreOf('lpf1', 'out')
  const to = await centreOf('scope1', 'in2')
  check('the B jack is there', !!from && !!to)

  if (from && to) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    await settle(200)
    check(
      'B is patched',
      await page.evaluate(() =>
        document
          .querySelector('.jack[data-module="scope1"][data-port="in2"]')
          ?.classList.contains('occupied'),
      ),
    )
  }

  await page.keyboard.press('Tab')
  await settle(FLIP_SETTLE)
  await settle(600)

  const drawn = await traceB()
  check('a second trace is drawn', drawn && drawn.lit > empty.lit + 200, `${empty?.lit} px -> ${drawn?.lit} px`)
  check('and it has a shape rather than a line', drawn && drawn.spread > 8, drawn ? `${drawn.spread}px tall` : '')

  // A is still A: a second channel that displaced the first would be a
  // regression nobody would notice until they were comparing two things.
  const a = await trace()
  check('A is still drawn beside it', a && a.lit > 0 && a.spread > 8, a ? `${a.lit} px, ${a.spread}px tall` : '')
}

// --- spectrum --------------------------------------------------------
console.log('\nspectrum mode')
{
  const before = await trace()
  await page.evaluate(() => {
    const unit = [...document.querySelectorAll('.unit-face-front')].find(
      (u) => u.querySelector('.unit-id')?.textContent === 'scope1',
    )
    const button = [...unit.querySelectorAll('.switch-buttons button')].find(
      (b) => b.textContent.trim() === 'spectrum',
    )
    button.click()
  })
  await settle(600)

  const after = await trace()
  check('the mode switch took', after && after.lit > 0, after ? `${after.lit} px` : '')
  check(
    'it draws something different from the waveform',
    before && after && Math.abs(after.lit - before.lit) > 8,
    `${before?.lit} px -> ${after?.lit} px`,
  )
  check(
    'the legend follows the mode',
    (await page.evaluate(() => document.querySelector('.scope-legend')?.textContent ?? '')).includes(
      'Hz',
    ),
  )
}

console.log('\nproblems    :', problems.length ? problems : 'none')
await browser.close()

const ok = failures === 0 && problems.length === 0
console.log(ok ? '\nPASS' : `\nFAIL (${failures} check(s))`)
process.exit(ok ? 0 : 1)
