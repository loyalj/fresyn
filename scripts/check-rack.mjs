/**
 * Drives rack editing in a real browser: add and remove modules, reorder them
 * by button and by dragging a unit's spine, and verify that a patch survives a
 * reload and a round trip through a file.
 *
 * Needs `npm run dev -- --port 5199` in another terminal.
 * Point CHROME_PATH at a Chromium build if the default is wrong.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
const URL = process.env.DEV_URL || 'http://localhost:5199/'

const downloads = mkdtempSync(join(tmpdir(), 'fresyn-'))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
})
const page = await browser.newPage()
// Tall enough for the whole rack: the cable checks need jacks on screen.
await page.setViewport({ width: 1200, height: 1500 })

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
const unitCount = () => page.evaluate(() => document.querySelectorAll('.unit-flip').length)
const unitIds = () =>
  page.evaluate(() => [...document.querySelectorAll('.unit-face-front .unit-id')].map((e) => e.textContent))
const patchName = () => page.evaluate(() => document.querySelector('.patch-name').value)

// Everything is reached by the words on it rather than by position: the menus
// grow, and an index silently starts clicking the wrong row when they do.
const handleFor = async (selector, text) => {
  const handle = await page.evaluateHandle(
    (sel, t) => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === t) ?? null,
    selector,
    text,
  )
  return handle.asElement()
}

/** Open a top-level menu. Returns false if there is no such menu. */
const openMenu = async (label) => {
  const el = await handleFor('.menubar-label', label)
  if (!el) return false
  await el.click()
  await settle(120)
  return true
}

const menuRows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.menu .menu-item')].map((b) => ({
      label: b.querySelector('.menu-text')?.textContent.trim() ?? b.textContent.trim(),
      disabled: b.disabled === true,
      checked: b.getAttribute('aria-checked'),
    })),
  )

const menuOpen = () => page.evaluate(() => !!document.querySelector('.menu'))


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

/** Open a menu and click one of its rows. */
const pick = async (menu, item) => {
  if (!(await openMenu(menu))) return false
  const el = await handleFor('.menu .menu-item .menu-text', item)
  if (!el) return false
  await el.click()
  await settle(150)
  return true
}

/** Open a menu, hover a submenu, click one of its rows. */
const pickSub = async (menu, sub, item) => {
  if (!(await openMenu(menu))) return false
  const parent = await handleFor('.menu .menu-item .menu-text', sub)
  if (!parent) return false
  await parent.hover()
  await settle(150)
  const el = await handleFor('.menu-nested .menu-item .menu-text', item)
  if (!el) return false
  await el.click()
  await settle(200)
  return true
}

await page.goto(URL, { waitUntil: 'networkidle0' })
// Start from a known state; the autosave persists across runs.
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const cdp = await page.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })

const baseCount = await unitCount()
check('the stock rack loaded', baseCount === 5, `${baseCount} units`)

// --- adding ----------------------------------------------------------
console.log('\nadding a module')
{
  const offered = await menuModules()
  // Counted from the catalogue rather than written here. A number in this
  // file is a number that goes stale the next time a module is added, and the
  // failure reads as a broken menu rather than as a test that was not told.
  const declared = await page.evaluate(async () => {
    const { MODULE_DEFS } = await import('/src/patch/defs.ts')
    return Object.keys(MODULE_DEFS).length
  })
  check(
    'the menu lists every module type',
    offered.length === declared,
    `${offered.length} of ${declared}`,
  )

  // The ladder filter, so its seeded knobs are easy to recognise.
  check('a module can be added from the menu', await addModule('Ladder Filter'))
  check('the rack grew', (await unitCount()) === baseCount + 1)
  const ids = await unitIds()
  check('the new unit has a fresh id', ids.includes('lpf2'), ids.join(','))
  check('the menu closed', await page.evaluate(() => !document.querySelector('.menu')))

  // The menu is at the top of the page, so what it adds arrives at the top of
  // the rack rather than off the bottom of one that may be pages long.
  check('it lands at the top of the rack', ids[0] === 'lpf2', ids.join(','))

  // A new module must come up on its defaults, not on zeroes.
  const readout = await page.evaluate(() => {
    const units = [...document.querySelectorAll('.unit-face-front')]
    const unit = units.find((u) => u.querySelector('.unit-id')?.textContent === 'lpf2')
    return unit?.querySelector('.knob-readout')?.textContent ?? null
  })
  check('its knobs are seeded from the defaults', readout === '1.40 kHz', String(readout))
}

// --- removing --------------------------------------------------------
console.log('\nremoving a module')
{
  const before = await unitCount()
  const removed = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Remove lpf2"]')
    el?.click()
    return !!el
  })
  check('the remove control is present', removed)
  await settle(300)
  check('the rack shrank', (await unitCount()) === before - 1)
  check('the unit is gone', !(await unitIds()).includes('lpf2'))
}

{
  // Removing a patched module must take its cables with it.
  const before = await unitCount()
  await page.evaluate(() => {
    document.querySelector('[aria-label="Remove lpf1"]')?.click()
  })
  await settle(300)
  check('a patched module can be removed', (await unitCount()) === before - 1)
  check('no errors from the dangling cables', problems.length === 0, problems.join('; '))

  // Put it back. The stock rack is five units and four cables, and the
  // sections below need both -- there is nothing to reorder in a rack of two,
  // and nothing to unplug in a rack with no cables.
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(300)
  check('and undo brings it and its cables back', (await unitCount()) === before)
}

// --- duplicating ------------------------------------------------------
console.log('\nduplicating a unit')
{
  const before = await unitCount()
  const readoutOf = (id, label) =>
    page.evaluate(
      (m, l) => {
        const unit = [...document.querySelectorAll('.unit-face-front')].find(
          (u) => u.querySelector('.unit-id')?.textContent === m,
        )
        const knob = [...(unit?.querySelectorAll('.knob') ?? [])].find(
          (k) => k.querySelector('.knob-label')?.textContent?.trim() === l,
        )
        return knob?.querySelector('.knob-readout')?.textContent ?? null
      },
      id,
      label,
    )

  // The stock oscillator runs Env Amt at full while the definition's default
  // is zero. That gap is the whole check: a copy showing 0.00 would have been
  // built from the catalogue rather than from the unit it was copied from.
  const source = await readoutOf('osc1', 'Env Amt')
  check('the source knob is off its default', source === '1.00', String(source))

  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Duplicate osc1"]')
    el?.click()
    return !!el
  })
  check('the duplicate control is present', clicked)
  await settle(300)

  check('the rack grew', (await unitCount()) === before + 1)
  const ids = await unitIds()
  check('the copy has a fresh id', ids.includes('osc2'), ids.join(','))
  check(
    'and it lands directly below what it came from',
    ids[ids.indexOf('osc1') + 1] === 'osc2',
    ids.join(','),
  )
  const copied = await readoutOf('osc2', 'Env Amt')
  check('it brings the knob positions with it', copied === source, String(copied))

  // Put the rack back, so the layout checks below still see the stock one.
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(300)
  check('and a duplicate is undoable', (await unitCount()) === before)
}

// --- the patch library ------------------------------------------------
console.log('\nthe patch library')
{
  const before = await unitIds()

  const rowNames = () =>
    page.evaluate(() => [...document.querySelectorAll('.library-name')].map((e) => e.textContent.trim()))
  const sheetOpen = () => page.evaluate(() => !!document.querySelector('.sheet [role="dialog"], .sheet'))
  const highlighted = () =>
    page.evaluate(() => document.querySelector('.library-row.at .library-name')?.textContent?.trim() ?? null)

  check('Library is in the Patch menu', await pick('Patch', 'Library...'))
  await settle(250)
  check('it opens a sheet', await sheetOpen())

  // Counted from the library itself, so adding a template does not make this
  // file wrong -- the same reason the Modules menu is counted that way.
  const shelved = await page.evaluate(async () => {
    const { LIBRARY } = await import('/src/patch/library.ts')
    return LIBRARY.map((t) => t.name)
  })
  const listed = await rowNames()
  check('it lists every template', listed.length === shelved.length, `${listed.length} of ${shelved.length}`)
  check('and names them', listed.join(',') === shelved.join(','), listed.slice(0, 3).join(', ') + '...')

  // The arrows have to move the list rather than the page: the rack captures
  // them everywhere else, and a sheet only works if the rack stands down.
  check('the first row starts highlighted', (await highlighted()) === shelved[0], String(await highlighted()))
  await page.keyboard.press('ArrowDown')
  await settle(120)
  check('the arrows move the highlight', (await highlighted()) === shelved[1], String(await highlighted()))

  // Escape is the way out that changes nothing.
  await page.keyboard.press('Escape')
  await settle(250)
  check('Escape closes it', !(await sheetOpen()))
  check('and the rack is untouched', (await unitIds()).join(',') === before.join(','))

  // --- loading one ---
  await pick('Patch', 'Library...')
  await settle(250)
  const picked = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.library-row')].find(
      (r) => r.querySelector('.library-name')?.textContent?.trim() === 'Wind',
    )
    row?.click()
    return !!row
  })
  check('a template can be chosen', picked)
  await settle(400)

  check('choosing one closes the sheet', !(await sheetOpen()))
  const loaded = await unitIds()
  // The wind rack is the tutorial rack plus a sample and hold and a slew.
  check('the rack was replaced', loaded.includes('sh1') && loaded.includes('slew1'), loaded.join(','))
  check('the patch takes the template name', (await patchName()) === 'Wind', await patchName())

  // Its knobs have to arrive where the template set them, not on the module
  // defaults -- which is the whole difference between a template and a list
  // of module names.
  const cutoff = await page.evaluate(() => {
    const unit = [...document.querySelectorAll('.unit-face-front')].find(
      (u) => u.querySelector('.unit-id')?.textContent === 'lpf1',
    )
    const knob = [...(unit?.querySelectorAll('.knob') ?? [])].find(
      (k) => k.querySelector('.knob-label')?.textContent?.trim() === 'Cutoff',
    )
    return knob?.querySelector('.knob-readout')?.textContent ?? null
  })
  check('and its knobs come with it', cutoff === '700 Hz', String(cutoff))

  // One commit, so the way back is the way back from everything else.
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(350)
  check('loading a template is undoable', (await unitIds()).join(',') === before.join(','))
}

// --- rows of one or two -----------------------------------------------
console.log()
console.log('half-width panels share a row')
{
  const boxOf = (id) =>
    page.evaluate((m) => {
      const r = document.querySelector(`[data-module="${m}"]`).getBoundingClientRect()
      const rack = document.querySelector('.rack').getBoundingClientRect()
      return {
        top: Math.round(r.top + window.scrollY),
        left: Math.round(r.left - rack.left),
        width: Math.round(r.width),
        rack: Math.round(rack.width),
      }
    }, id)

  const addByName = (text) => addModule(text)

  // The stock rack is a full panel, two halves and a full, so it packs into
  // three rows with nothing left over -- which is the layout every new reader
  // sees first.
  const lpf = await boxOf('lpf1')
  const lfo = await boxOf('lfo1')
  const mix = await boxOf('mix1')
  check('a full-width panel takes the whole row', mix.width === mix.rack, `${mix.width} of ${mix.rack}`)
  // Half a row less the gap between the columns, so the arithmetic is loose.
  check(
    'a half-width panel takes half of one',
    Math.abs(lpf.width - lpf.rack / 2) <= 6,
    `${lpf.width} of ${lpf.rack}`,
  )
  check('the stock rack pairs its halves', lpf.top === lfo.top, `${lpf.top} vs ${lfo.top}`)
  check('side by side, in order', lpf.left === 0 && lfo.left > lpf.width, `${lpf.left}, ${lfo.left}`)

  // A half panel with a full one after it leaves the rest of its row empty
  // rather than dragging the full panel up beside it. Added in this order
  // because the menu puts each new unit at the top, so the Scope ends up
  // below the VCA rather than above it.
  await addByName('Scope')
  await addByName('VCA')
  const vca = await boxOf('vca1')
  const scope = await boxOf('scope1')
  check('a full panel does not squeeze in beside one', scope.top > vca.top, `${vca.top} -> ${scope.top}`)
  check('and the lone half keeps its column', vca.left === 0 && vca.width === lpf.width)

  // Two panels sharing a row trade places sideways, not by being dragged the
  // height of the rack: the drag reads the gap the held unit left behind and
  // measures across the row when its neighbour is beside it.
  const order = () =>
    page.evaluate(() => [...document.querySelectorAll('.unit-flip')].map((e) => e.dataset.module))
  await page.evaluate(() => window.scrollTo(0, 0))
  await settle(120)
  const spine = await page.evaluate(() => {
    const r = document.querySelector('[data-module="lpf1"] .unit-spine').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const past = await page.evaluate(() => {
    const r = document.querySelector('[data-module="lfo1"]').getBoundingClientRect()
    return r.left + r.width / 2 + 20
  })
  const wasPaired = (await order()).join(',')
  await page.mouse.move(spine.x, spine.y)
  await page.mouse.down()
  await page.mouse.move(spine.x + 30, spine.y)
  await page.mouse.move(past, spine.y)
  await settle(300)
  const swapped = (await order()).join(',')
  check('a half panel is passed sideways', swapped !== wasPaired, `${wasPaired} -> ${swapped}`)
  await page.mouse.up()
  await settle(300)
  const after = await order()
  check(
    'the two changed places',
    wasPaired.split(',').indexOf('lpf1') < wasPaired.split(',').indexOf('lfo1') &&
      after.indexOf('lfo1') < after.indexOf('lpf1'),
    `${wasPaired} -> ${after.join(',')}`,
  )

  for (let i = 0; i < 3; i++) {
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyZ')
    await page.keyboard.up('Control')
  }
  await settle(300)
  check('the rack is back as it was', (await unitCount()) === baseCount, `${await unitCount()} units`)
}

// --- dragging a unit by its spine -------------------------------------
console.log('\ndragging a unit by its spine')
{
  const rackOrder = () =>
    page.evaluate(() => [...document.querySelectorAll('.unit-flip')].map((e) => e.dataset.module))
  const spineOf = (id) =>
    page.evaluate((m) => {
      const r = document.querySelector(`[data-module="${m}"] .unit-spine`).getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, id)
  const centreOf = (id) =>
    page.evaluate((m) => {
      const r = document.querySelector(`[data-module="${m}"]`).getBoundingClientRect()
      return { x: r.left + 20, y: r.top + r.height / 2 }
    }, id)
  const ghostBox = () =>
    page.evaluate(() => {
      const g = document.querySelector('.rack-ghost')
      if (!g) return null
      const r = g.getBoundingClientRect()
      return { y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    })

  const before = await rackOrder()
  const held = before[0]
  // The bottom of the rack, rather than a fixed row: earlier sections add and
  // remove units, so how many are left is not this section's business.
  const target = before[before.length - 1]
  const unit = await page.evaluate((m) => {
    const r = document.querySelector(`[data-module="${m}"]`).getBoundingClientRect()
    return { width: Math.round(r.width), height: Math.round(r.height) }
  }, held)

  // Earlier sections leave the page scrolled, and the pointer cannot reach a
  // spine that is above the top of the window.
  await page.evaluate(() => window.scrollTo(0, 0))
  await settle(120)

  const from = await spineOf(held)
  const to = await centreOf(target)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, from.y + 24)
  await settle(120)

  const carried = await ghostBox()
  check('a panel is carried under the pointer', !!carried)
  check(
    'it is the size of the unit it came from',
    carried?.width === unit.width && carried?.height === unit.height,
    `${carried?.width}x${carried?.height} vs ${unit.width}x${unit.height}`,
  )
  check(
    'the unit leaves a gap behind it',
    await page.evaluate((m) => !!document.querySelector(`[data-module="${m}"].dragging`), held),
  )

  // Drag the rest of the way in one throw: the rack has to catch up with a
  // pointer that has already arrived, not just step once per event.
  await page.mouse.move(from.x, to.y)
  await settle(300)
  const moved = await ghostBox()
  check('the panel followed the pointer', (moved?.y ?? 0) > (carried?.y ?? 0), `${carried?.y} -> ${moved?.y}`)
  // How far it travels is a question of pixels, not of how many units were
  // passed: a tall panel dragged the height of a short one has not gone as
  // far down the rack as the count of units between them suggests.
  const during = await rackOrder()
  check('the rack reordered under it', during.indexOf(held) > 0, `${held} at ${during.indexOf(held)}`)

  await page.mouse.up()
  await settle(300)
  check('the panel is put down', (await ghostBox()) === null)

  const after = await rackOrder()
  check('it lands where the gap was', after.join(',') === during.join(','), after.join(','))

  // One edit, however many units it crossed on the way.
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(300)
  check('one undo puts it back', (await rackOrder()).join(',') === before.join(','), (await rackOrder()).join(','))
}

// --- the oscillator panel ---------------------------------------------
console.log()
console.log('the oscillator panel')
{
  const oscPanel = (sel) =>
    page.evaluate((s) => {
      const unit = [...document.querySelectorAll('.unit-face-front')].find(
        (u) => u.querySelector('.unit-id')?.textContent === 'osc1',
      )
      return unit ? unit.querySelectorAll(s).length : -1
    }, sel)

  check('it has its own trigger', (await oscPanel('.trigger')) === 1)
  check('it draws an envelope graph', (await oscPanel('.env-graph')) === 1)

  const curve = () =>
    page.evaluate(() => {
      const unit = [...document.querySelectorAll('.unit-face-front')].find(
        (u) => u.querySelector('.unit-id')?.textContent === 'osc1',
      )
      return unit?.querySelector('.env-line')?.getAttribute('d') ?? ''
    })

  const before = await curve()
  check('the curve is drawn', before.length > 200, `${before.length} chars`)

  // Six stage knobs plus the amount, on top of the four tone controls.
  check('the envelope knobs are there', (await oscPanel('.knob')) === 10, String(await oscPanel('.knob')))

  // Dragging Decay has to redraw the shape, or the graph is decoration.
  // Scrolled into view before measuring: oscillator panels are tall now, and
  // a drag can only reach what is actually on screen.
  const decay = await page.evaluate(() => {
    const unit = [...document.querySelectorAll('.unit-face-front')].find(
      (u) => u.querySelector('.unit-id')?.textContent === 'osc1',
    )
    const knob = [...unit.querySelectorAll('.knob')].find(
      (k) => k.querySelector('.knob-label')?.textContent === 'Decay',
    )
    knob.scrollIntoView({ block: 'center' })
    const r = knob.querySelector('svg').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await new Promise((r) => setTimeout(r, 120))
  await page.mouse.move(decay.x, decay.y)
  await page.mouse.down()
  await page.mouse.move(decay.x, decay.y - 60, { steps: 6 })
  await page.mouse.up()
  await settle(250)

  const after = await curve()
  check('turning Decay redraws the graph', after !== before)
  check('the graph stays well formed', !after.includes('NaN'), after.slice(0, 60))

  // The knob is deliberately left where it is: undoing here would leave a
  // redo pending, which the next section asserts is empty.
}

// --- the keyboard panel -----------------------------------------------
console.log()
console.log('the keyboard panel')
{
  await addModule('Keyboard')

  const board = await page.evaluate(() => {
    const el = document.querySelector('.keys-board')
    if (!el) return null
    const box = el.getBoundingClientRect()
    const keys = [...el.querySelectorAll('.keys-key')]
    return {
      keys: keys.length,
      sharps: keys.filter((k) => k.classList.contains('sharp')).length,
      // Every key has to be drawn, and drawn inside the board: the sharps are
      // placed by arithmetic on the naturals, so an off-by-one puts one off
      // the end where it cannot be played.
      placed: keys.every((k) => {
        const r = k.getBoundingClientRect()
        return r.width > 4 && r.left >= box.left - 1 && r.right <= box.right + 1
      }),
    }
  })
  check('the panel has 25 keys', board?.keys === 25, `${board?.keys}`)
  check('ten of them are sharps', board?.sharps === 10, `${board?.sharps}`)
  check('and every key is inside the board', !!board?.placed)

  // Pressing a key does two separate things: it writes the note, and it opens
  // the rack's gate. The header lamp is how the second one is visible.
  const key = await page.evaluate(() => {
    const k = [...document.querySelectorAll('.keys-key')][9]
    k.scrollIntoView({ block: 'center' })
    const r = k.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.8, label: k.getAttribute('aria-label') }
  })
  await settle(120)
  await page.mouse.move(key.x, key.y)
  await page.mouse.down()
  await settle(200)
  const down = await page.evaluate(() => ({
    held: document.querySelectorAll('.keys-key.held').length,
    running: !!document.querySelector('.led.on'),
    note: document.querySelector('.keys-note')?.textContent,
    pitch: document.querySelector('.keys-pitch')?.textContent,
  }))
  await page.mouse.up()
  await settle(150)

  check('pressing a key lights it', down.held === 1, `${down.held} lit`)
  check('and starts the rack', down.running)
  check('the panel names the note', down.note === 'E', `${down.note} (${key.label})`)
  // Ten naturals up from the bottom is sixteen semitones, and the jack is
  // scaled in octaves: 16/12 = 1.33.
  check('and reports what the jack puts out', down.pitch === '+1.33', String(down.pitch))

  await page.evaluate(() => document.querySelector('[aria-label="Octave up"]').click())
  await settle(250)
  check(
    'the octave switch moves it a whole octave',
    (await page.evaluate(() => document.querySelector('.keys-pitch').textContent)) === '+2.33',
    await page.evaluate(() => document.querySelector('.keys-pitch').textContent),
  )

  // Put the rack back the way the sections below expect it.
  await page.evaluate(() => document.querySelector('[aria-label="Remove key1"]')?.click())
  await settle(300)
  check('the keyboard was removed again', !(await unitIds()).includes('key1'))
}

// --- the sequencer panel ----------------------------------------------
console.log()
console.log('the sequencer panel')
{
  await addModule('Sequencer')

  const face = () =>
    page.evaluate(() => {
      const unit = [...document.querySelectorAll('.unit-face-front')].find(
        (u) => u.querySelector('.unit-id')?.textContent === 'seq1',
      )
      if (!unit) return null
      const steps = [...unit.querySelectorAll('.seq-step')]
      return {
        steps: steps.length,
        dimmed: steps.filter((e) => e.classList.contains('seq-step-off')).length,
        stepKnobs: unit.querySelectorAll('.seq-step .knob').length,
        controls: unit.querySelectorAll('.seq-controls .knob').length,
        lamps: unit.querySelectorAll('.seq-lamp').length,
        trigger: !!unit.querySelector('.trigger'),
        // The whole pattern must fit the panel it is drawn on.
        overflow: Math.round(unit.querySelector('.unit-face').scrollWidth - unit.querySelector('.unit-face').clientWidth),
      }
    })

  const seq = await face()
  check('it lays out as eight steps', seq?.steps === 8, `${seq?.steps}`)
  check('each step has a CV and a level', seq?.stepKnobs === 16, `${seq?.stepKnobs} knobs`)
  check('the pattern controls stand apart', seq?.controls === 3, `${seq?.controls} knobs`)
  check('every step has a lamp', seq?.lamps === 8, `${seq?.lamps}`)
  check('it has its own trigger', seq?.trigger === true)
  check('the panel fits its row', seq?.overflow <= 0, `${seq?.overflow}px over`)
  check('a full pattern dims nothing', seq?.dimmed === 0, `${seq?.dimmed} dimmed`)

  // Shortening the pattern greys the steps past the end rather than hiding
  // them, which is the whole reason the class is there.
  const dragged = await page.evaluate(() => {
    const unit = [...document.querySelectorAll('.unit-face-front')].find(
      (u) => u.querySelector('.unit-id')?.textContent === 'seq1',
    )
    const knob = [...unit.querySelectorAll('.seq-controls .knob')].find(
      (k) => k.querySelector('.knob-label')?.textContent === 'Steps',
    )
    if (!knob) return null
    const r = knob.querySelector('svg').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  check('the Steps knob was found', !!dragged)
  await page.mouse.move(dragged.x, dragged.y)
  await page.mouse.down()
  // Down the panel shortens it; the knob's full sweep is 220 pixels.
  await page.mouse.move(dragged.x, dragged.y + 110)
  await page.mouse.up()
  await settle(300)

  const shortened = await face()
  check(
    'shortening the pattern dims the rest',
    (shortened?.dimmed ?? 0) > 0 && (shortened?.steps ?? 0) === 8,
    `${shortened?.dimmed} of ${shortened?.steps} dimmed`,
  )
  check('and keeps all sixteen knobs', shortened?.stepKnobs === 16, `${shortened?.stepKnobs}`)

  await page.evaluate(() => document.querySelector('[aria-label="Remove seq1"]')?.click())
  await settle(300)
  check('the sequencer was removed again', !(await unitIds()).includes('seq1'))
}

// --- controls on the back panel ---------------------------------------
console.log()
console.log('controls on the back panel')
{
  await page.keyboard.press('Tab')
  await settle(700)

  // Scrolled into view before measuring, and taken from the back face only:
  // both faces carry the same controls, so the label alone is ambiguous.
  const backControl = (label) =>
    page.evaluate((text) => {
      const el = document.querySelector(`.unit-face-back [aria-label="${text}"]`)
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, label)

  check('the back face has a remove control', !!(await backControl('Remove lfo1')))
  check('the back face has reorder arrows', !!(await backControl('Move lfo1 down')))
  check(
    'the back face has a drag handle',
    await page.evaluate(() => !!document.querySelector('.unit-face-back .unit-spine')),
  )
  // Building a rack happens from behind it; the front is for playing.
  check(
    'the front face has no controls at all',
    await page.evaluate(() => document.querySelectorAll('.unit-face-front .unit-controls').length === 0),
  )
  check(
    'the front face still has its drag handle',
    await page.evaluate(() => !!document.querySelector('.unit-face-front .unit-spine')),
  )

  // The rack hit-tests cables under the pointer; the guard only fires if the
  // control is what the pointer actually lands on.
  const spot = await backControl('Remove lfo1')
  await settle(120)
  const landsOn = await page.evaluate(
    (p) => document.elementFromPoint(p.x, p.y)?.closest('.jack, .unit-controls')?.className ?? null,
    spot,
  )
  check('the pointer lands on the control, not the panel', landsOn === 'unit-controls', String(landsOn))

  const cables = () =>
    page.evaluate(() => document.querySelectorAll('.cables g.cable:not(.cable-dragging)').length)
  const before = { units: await unitCount(), cables: await cables() }

  await page.mouse.click(spot.x, spot.y)
  await settle(300)

  check('removing from the back works', (await unitCount()) === before.units - 1)
  check('the unit is gone', !(await unitIds()).includes('lfo1'))
  // lfo1 is unpatched, so nothing may be unplugged by clicking its button.
  check('no cable was unplugged with it', (await cables()) === before.cables, `${before.cables} -> ${await cables()}`)

  // Reordering from the back, by the same spine the front is dragged by.
  await page.evaluate(() => window.scrollTo(0, 0))
  await settle(120)
  const order = await unitIds()
  const spine = await page.evaluate(() => {
    const el = document.querySelector('.unit-face-back .unit-spine')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  check('the back spine was found', !!spine, `for ${order[0]}`)
  if (spine) {
    await page.mouse.move(spine.x, spine.y)
    await page.mouse.down()
    await page.mouse.move(spine.x, spine.y + 280)
    await settle(300)
    await page.mouse.up()
    await settle(300)
  }
  check(
    'dragging from the back works',
    (await unitIds())[0] !== order[0],
    `${order.slice(0, 3).join(',')} -> ${(await unitIds()).slice(0, 3).join(',')}`,
  )

  // The arrows are the same move without a pointer gesture, which is what
  // makes reordering reachable from the keyboard.
  const arrowed = await unitIds()
  const mover = await backControl(`Move ${arrowed[0]} down`)
  check('the down arrow was found', !!mover, `for ${arrowed[0]}`)
  if (mover) {
    await page.mouse.click(mover.x, mover.y)
    await settle(300)
  }
  check(
    'the arrow moves a unit too',
    (await unitIds())[1] === arrowed[0],
    `${arrowed.slice(0, 3).join(',')} -> ${(await unitIds()).slice(0, 3).join(',')}`,
  )

  await page.keyboard.press('Tab')
  await settle(700)
}

// --- undo and redo ---------------------------------------------------
console.log('\nundo and redo')
{
  /** Read a row's state out of the Edit menu, then shut it again. */
  const editRow = async (label) => {
    await openMenu('Edit')
    const rows = await menuRows()
    await page.keyboard.press('Escape')
    await settle(120)
    return rows.find((r) => r.label === label)
  }

  check('undo is available after edits', (await editRow('Undo'))?.disabled === false)
  check('redo is not, until something is undone', (await editRow('Redo'))?.disabled === true)

  const before = await unitCount()
  const ids = await unitIds()
  // Whichever unit is at the top, since the sections above have reordered it.
  await page.evaluate(
    (id) => document.querySelector(`[aria-label="Remove ${id}"]`)?.click(),
    ids[0],
  )
  await settle(300)
  check('a module was removed', (await unitCount()) === before - 1)

  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(300)
  check('Ctrl+Z brings it back', (await unitCount()) === before)
  check('it comes back in the same place', (await unitIds()).join(',') === ids.join(','))
  check('redo is now available', (await editRow('Redo'))?.disabled === false)

  await page.keyboard.down('Control')
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
  await settle(300)
  check('Ctrl+Shift+Z removes it again', (await unitCount()) === before - 1)

  // Put it back for the checks that follow.
  check('the Undo menu row works too', await pick('Edit', 'Undo'))
  await settle(300)
  check('and it brought the module back', (await unitCount()) === before)

  // A cable edit is undoable in the same history.
  await page.keyboard.press('Tab')
  await settle(700)
  const cables = () =>
    page.evaluate(() => document.querySelectorAll('.cables g.cable:not(.cable-dragging)').length)
  const cablesBefore = await cables()
  // Picked from what is actually patched right now: earlier checks remove
  // modules, so naming a jack up front risks choosing an empty one.
  const jack = await page.evaluate(() => {
    const el = document.querySelector('.jack.jack-input.occupied')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      id: `${el.dataset.module}.${el.dataset.port}`,
    }
  })
  check('a patched input was found', !!jack, jack?.id ?? 'none')

  await page.mouse.click(jack.x, jack.y, { button: 'right' })
  await settle(250)
  check('a cable was unplugged', (await cables()) === cablesBefore - 1, jack?.id)

  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(300)
  check('undo re-plugs the cable', (await cables()) === cablesBefore)

  await page.keyboard.press('Tab')
  await settle(700)
}

// --- persistence -----------------------------------------------------
console.log('\nsurviving a reload')
{
  await page.click('.patch-name', { clickCount: 3 })
  await page.keyboard.type('Thunder Hit')
  await settle(700) // autosave debounce

  const before = { name: await patchName(), count: await unitCount(), ids: await unitIds() }
  await page.reload({ waitUntil: 'networkidle0' })
  await settle(400)

  check('the name came back', (await patchName()) === before.name, await patchName())
  check('the rack came back', (await unitCount()) === before.count)
  check('the order came back', (await unitIds()).join(',') === before.ids.join(','))
}

// --- export and import ------------------------------------------------
console.log('\nexport and import')
{
  check('the Export action is there', await pick('Patch', 'Export file...'))
  await settle(600)

  const files = readdirSync(downloads).filter((f) => f.endsWith('.json'))
  check('a file was written', files.length === 1, files.join(','))

  let parsed = null
  if (files.length) {
    parsed = JSON.parse(readFileSync(join(downloads, files[0]), 'utf8'))
    check('it is named after the patch', files[0] === 'thunder-hit.fresyn.json', files[0])
    check('it carries a format version', parsed.version === 1)
    check('it carries the name', parsed.name === 'Thunder Hit')
    check('it carries the rack', parsed.patch.modules.length === (await unitCount()))
    // Knob values must be baked in, not left to the defaults.
    const lpf = parsed.patch.modules.find((m) => m.type === 'mixer')
    check('knob values are baked in', lpf && typeof lpf.params.master === 'number')
  }

  // Change the rack, then import the file back over it. New has no confirm
  // step now that reaching it means opening a menu, but it does go through the
  // history like any other edit -- which the undo below is what proves.
  check('New is in the Patch menu', await pick('Patch', 'New'))
  await settle(400)
  check('New reset the rack', (await patchName()) === 'Untitled', await patchName())

  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(400)
  check('and New is undoable', (await patchName()) === 'Thunder Hit', await patchName())
  await pick('Patch', 'New')
  await settle(400)

  if (files.length) {
    const input = await page.$('input[type=file]')
    await input.uploadFile(join(downloads, files[0]))
    await settle(600)
    check('the imported name is restored', (await patchName()) === 'Thunder Hit', await patchName())
    check('the imported rack is restored', (await unitCount()) === parsed.patch.modules.length)
  }
}

console.log('\nproblems    :', problems.length ? problems : 'none')
await browser.close()
rmSync(downloads, { recursive: true, force: true })

const ok = failures === 0 && problems.length === 0
console.log(ok ? '\nPASS' : `\nFAIL (${failures} check(s))`)
process.exit(ok ? 0 : 1)
