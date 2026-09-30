import { check, finish, flushAutosave, frames, open, settle as wait, waitUntil } from './harness.mjs'

/**
 * End-to-end check for the Drum Kit: added from the Modules menu, loaded
 * with the standard kit, a pad replaced, renamed, moved and grouped, pads
 * played from the panel, and the roll naming its rows by pad.
 *
 * Every step goes through the real app, and what it did is read back out of
 * the autosave, which is the document itself.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks. Set SHOT to
 * a file path to keep a picture of the panel.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1400 } })

const edited = () => frames(page)

const stored = async () => {
  await flushAutosave(page)
  return page.evaluate(() => {
    const raw = localStorage.getItem('fresyn.project.v1')
    return raw ? JSON.parse(raw) : null
  })
}
/** The kit on the bench, as saved. */
const kit = async () => {
  const doc = await stored()
  const rack = doc.racks[Object.keys(doc.racks)[0]]
  // Saved as a patch file saves it: the knobs baked into each module.
  const module = rack.patch.modules.find((m) => m.type === 'kit')
  return { module, values: Object.fromEntries(Object.entries(module?.params ?? {}).map(([k, v]) => [`${module.id}.${k}`, v])) }
}

async function addModule(name) {
  const menu = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Modules'),
  )
  const trigger = menu.asElement()
  if (!trigger) return false
  await trigger.click()
  await wait(120)
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll('.menu > .menu-slot > .menu-item .menu-text')].map((e) => e.textContent.trim()),
  )
  for (const group of groups) {
    const gh = await page.evaluateHandle(
      (g) => [...document.querySelectorAll('.menu > .menu-slot > .menu-item .menu-text')].find((e) => e.textContent.trim() === g),
      group,
    )
    const gel = gh.asElement()
    if (!gel) continue
    await gel.hover()
    await wait(120)
    const ih = await page.evaluateHandle(
      (n) => [...document.querySelectorAll('.menu-nested .menu-item .menu-text')].find((e) => e.textContent.trim() === n) ?? null,
      name,
    )
    const iel = ih.asElement()
    if (iel) {
      await iel.click()
      await wait(300)
      return true
    }
  }
  await page.keyboard.press('Escape')
  return false
}

await page.goto(url, { waitUntil: 'networkidle0' })

console.log('\nadding a kit')
{
  check('the Modules menu has a Drum Kit', await addModule('Drum Kit'))
  await waitUntil(page, () => document.querySelector('.kit'))
  check('it arrives with sixteen empty pads', (await page.$$('.kit-pad.empty')).length === 16)
  const ports = await page.evaluate(() =>
    [...document.querySelectorAll('[data-module^="kit"][data-port]')].map((j) => j.getAttribute('data-port')),
  )
  check('its Trig jacks and pad outs are on the back', ports.includes('trig1') && ports.includes('out16') && ports.includes('l'), ports.join(' '))
  check('and its returns are not jacks anybody can reach', !ports.some((p) => /^ret\d+[lr]$/.test(p)))
  await waitUntil(page, () => !document.querySelector('.kit-standard')?.disabled)
  await page.click('.kit-standard')
  await waitUntil(page, () => document.querySelectorAll('.kit-pad.empty').length === 0)
  await edited()
  const k = await kit()
  check('the standard kit fills every pad', k.module?.slots?.length === 16 && k.module.slots.every(Boolean))
  check('on General MIDI\'s notes', k.module?.slots?.[0]?.note === 36 && k.module.slots[2]?.note === 42)
  check('with the hats in a choke group', k.values[`${k.module.id}.choke3`] === 1 && k.values[`${k.module.id}.choke4`] === 1)
  check('and the pads say what is in them', await page.evaluate(() => document.querySelector('.kit-pad .kit-pad-name')?.textContent === 'Kick'))
}

console.log('\nplaying and editing a pad')
{
  // Pressed, held a moment and let go: picked, and heard without complaint.
  const pad = await page.$$('.kit-pad')
  const box = await pad[1].boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await wait(150)
  await page.mouse.up()
  check('a press picks the pad', await page.evaluate(() => document.querySelectorAll('.kit-pad')[1].classList.contains('picked')))
  check('and the panel beside it is that pad', await page.evaluate(() => document.querySelector('.kit-edit-title')?.textContent === 'Pad 2'))

  await page.select('.kit-load', 'clap')
  await waitUntil(page, () => document.querySelectorAll('.kit-pad .kit-pad-name')[1]?.textContent === 'Clap')
  await edited()
  const k = await kit()
  check('a pad is loaded from the library', k.module.slots[1].name === 'Clap' && k.module.slots[1].patch.modules.length > 2)
  check('and keeps the note it was on', k.module.slots[1].note === 38)

  const name = await page.$('.kit-name')
  await name.click({ clickCount: 3 })
  await page.keyboard.type('Big clap')
  await page.keyboard.press('Enter')
  await edited()
  check('a pad is renamed', (await kit()).module.slots[1].name === 'Big clap')

  const note = await page.$('.kit-field input[type="number"]')
  await note.click({ clickCount: 3 })
  await page.keyboard.type('40')
  await page.keyboard.press('Enter')
  await edited()
  check('and moved to another note', (await kit()).module.slots[1].note === 40)
  check('which the panel names both ways', await page.evaluate(() => document.querySelector('.kit-note-name')?.textContent?.includes('Snare 2')))

  await page.select('.kit-field select', '2')
  await edited()
  check('and put in a choke group', (await kit()).values[`${(await kit()).module.id}.choke2`] === 2)

  if (process.env.SHOT) await (await page.$('[data-module^="kit"]')).screenshot({ path: process.env.SHOT })

  await page.click('.kit-clear')
  await edited()
  check('a pad is emptied', (await kit()).module.slots[1] === null)
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await edited()
  check('and that undoes', (await kit()).module.slots[1]?.name === 'Big clap')
}

console.log('\nediting a pad in place')
{
  // Pad 1, the kick: picked, then opened with its own button.
  const pads = await page.$$('.kit-pad')
  const first = await pads[0].boundingBox()
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2)
  await page.click('.kit-edit-pad')
  await waitUntil(page, () => document.querySelector('.pad-crumb'))
  const crumb = await page.evaluate(() => document.querySelector('.pad-crumb')?.textContent ?? '')
  check('the Edit pad button opens the pad', crumb.includes('Pad 1') && crumb.includes('Kick'), crumb)
  check('and says whose it is', crumb.includes('Drum Kit') && /kit\d/.test(crumb), crumb)
  const units = await page.evaluate(() => [...document.querySelectorAll('.unit-flip[data-module]')].map((u) => u.dataset.module))
  check("the rack shows the pad's own units", units.includes('osc1') && units.includes('gate1') && !units.some((u) => u.startsWith('kit')), units.join(' '))
  const card = await page.evaluate(() => document.querySelector('.rack-index-pad')?.textContent ?? '')
  check('the index card says it is a sub-patch, and of what', card.includes('Editing a sub-patch') && card.includes('Pad 1') && card.includes('Drum Kit'), card)
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-pad.png') })

  // The Modules menu leaves out what a pad cannot hold.
  check('the Modules menu offers no Drum Kit in a pad', !(await addModule('Drum Kit')))
  check('and no Recorder', !(await addModule('Recorder')))

  // A knob turned in the pad lands in the pad.
  const decayOf = async () => (await kit()).module.slots[0].patch.modules.find((m) => m.id === 'osc1').params.decay
  const before = await decayOf()
  // An SVG, which has to be focused from inside the page.
  await page.evaluate(() => document.querySelector('[data-module="osc1"] [role="slider"][aria-label="Decay"]')?.focus())
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp')
  await edited()
  const after = await decayOf()
  check("a knob turned in the pad is the pad's", after > before, `${before} -> ${after}`)
  check('and the rest of the kit is where it was', (await kit()).module.slots[1]?.name === 'Big clap')

  // Out again, at the kit.
  const kitId = (await kit()).module.id
  await page.click('.pad-crumb-back')
  await waitUntil(page, () => !document.querySelector('.pad-crumb'))
  const back = await page.evaluate(() => [...document.querySelectorAll('.unit-flip[data-module]')].map((u) => u.dataset.module))
  check("Back to kit returns to the track's rack", back.includes(kitId), back.join(' '))
  check('with the edit kept', (await decayOf()) === after)
}

console.log('\nthe roll')
{
  // The kit is the bench's only way in once the Keyboard is taken out, so
  // its track plays the kit.
  await page.click('.dock-fold')
  await waitUntil(page, () => document.querySelector('.roll-canvas'))
  const hint = await page.evaluate(() => [...document.querySelectorAll('.dock-hint')].map((h) => h.textContent).join(' | '))
  const kitNamed = hint.includes('Drum Kit')
  // The stock rack has a Keyboard, which a rack is played through first; take
  // it out so the kit is what the roll plays.
  if (!kitNamed) {
    await page.evaluate(() => document.querySelector('[data-module="key1"]')?.scrollIntoView())
    await page.keyboard.press('KeyF')
    await wait(600)
    await page.evaluate(() => document.querySelector('[data-module="key1"] .unit-remove')?.click())
    await page.keyboard.press('KeyF')
    await wait(600)
    await edited()
  }
  const now = await page.evaluate(() => [...document.querySelectorAll('.dock-hint')].map((h) => h.textContent).join(' | '))
  check('a rack played through a kit says so', now.includes('Drum Kit: each named row plays a pad'), now)
  const gutter = await page.$eval('.roll-canvas', (el) => Number(el.dataset.gutter ?? 0))
  check('and the roll makes room to name its rows by pad', gutter > 40, String(gutter))
}

await finish()
