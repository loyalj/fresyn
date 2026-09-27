import { check, finish, flipRack, flushAutosave, frames, open, settle as wait, waitUntil } from './harness.mjs'

/**
 * End-to-end check for the working tools around the rack and the dock: the
 * module search, finishing a cable into a new module, bypass, copying
 * modules, cable colours, the library's own shelves, the Music toggle, and
 * keeping house on patterns and tracks -- and that the settings you leave the
 * roll in are there after a reload.
 *
 * Every step goes through the real app, and what it did is read back out of
 * the autosave, which is the document itself.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 *
 * An edit used to be followed by a 700 ms sleep so the autosave's debounce
 * had passed before the document was read. stored() flushes the autosave the
 * way the app does on pagehide instead, and an edit gets two frames to land.
 * The one exception is before a reload that checks the dock's own settings,
 * which are saved on a debounce of their own that pagehide does not flush.
 */
// Tall, so the whole stock rack and the dock are on screen at once.
const { page, url } = await open({ viewport: { width: 1280, height: 1900 } })

/** An edit has landed: React has committed it and scheduled the autosave. */
const edited = () => frames(page)

const stored = async () => {
  await flushAutosave(page)
  return page.evaluate(() => {
    const raw = localStorage.getItem('fresyn.project.v1')
    return raw ? JSON.parse(raw) : null
  })
}
/** The rack on the bench, as the autosave has it. */
const rack = async () => {
  const p = await stored()
  return p?.racks?.bench?.patch ?? { modules: [], cables: [] }
}

async function pickMenu(menu, item) {
  const handle = await page.evaluateHandle(
    (name) => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === name),
    menu,
  )
  const el = handle.asElement()
  if (!el) return false
  await el.click()
  await wait(120)
  const itemHandle = await page.evaluateHandle(
    (name) => [...document.querySelectorAll('.menu-item .menu-text')].find((e) => e.textContent.trim() === name) ?? null,
    item,
  )
  const itemEl = itemHandle.asElement()
  if (!itemEl) {
    await page.keyboard.press('Escape')
    return false
  }
  await itemEl.click()
  await wait(200)
  return true
}

const press = async (key, mods = []) => {
  for (const m of mods) await page.keyboard.down(m)
  await page.keyboard.press(key)
  for (const m of [...mods].reverse()) await page.keyboard.up(m)
}

const clickText = async (selector, text) => {
  const h = await page.evaluateHandle(
    (s, t) => [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t) ?? null,
    selector,
    text,
  )
  const el = h.asElement()
  if (el) await el.click()
  return !!el
}

const centreOf = (selector) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, selector)

// A fresh session, so nothing left behind by the last run can pass for work.
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

console.log('\nmodule search')
{
  await press('KeyK', ['Control'])
  await wait(200)
  check('Ctrl+K opens it', !!(await page.$('.search-input')))
  await page.keyboard.type('form')
  await wait(100)
  const top = await page.evaluate(() => document.querySelector('.search-row.at .search-name')?.textContent)
  check('typing narrows it to what matches', top === 'Formant', String(top))
  await press('Enter')
  await edited()
  const modules = (await rack()).modules
  check('Enter adds it', modules.some((m) => m.type === 'formant'), modules.map((m) => m.id).join())
  check('and the search closes', !(await page.$('.search-input')))
  check('it is in the Modules menu too', await pickMenu('Modules', 'Search...'))
  check('which opens the same box', !!(await page.$('.search-input')))
  await press('Escape')
  await wait(150)
  check('Escape closes it', !(await page.$('.search-input')))
}

console.log('\na cable let go of over nothing')
{
  await flipRack(page, true)
  const from = await centreOf('.jack[data-module="osc1"][data-port="env"]')
  check('a free output to start from', !!from)
  if (from) {
    const before = (await rack()).modules.length
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 300, from.y + 30, { steps: 8 })
    await page.mouse.up()
    await wait(200)
    const title = await page.evaluate(() => document.querySelector('.search')?.getAttribute('aria-label'))
    check('offers the modules that could take it', title === 'Finish the cable', String(title))
    await page.keyboard.type('ladder cv')
    await wait(100)
    const top = await page.evaluate(() => document.querySelector('.search-row.at .search-name')?.textContent)
    check('jack by jack', top === 'Ladder Filter › CV', String(top))
    await press('Enter')
    await edited()
    const after = await rack()
    const added = after.modules.find((m) => m.type === 'ladder' && m.id !== 'lpf1')
    check('picking one adds it', after.modules.length === before + 1 && !!added, added?.id)
    check(
      'and plugs the cable into the jack picked',
      after.cables.some((c) => c.from.module === 'osc1' && c.from.port === 'env' && c.to.module === added?.id && c.to.port === 'cv'),
    )
    const order = after.modules.map((m) => m.id)
    check('next to where the cable came from', order.indexOf(added?.id) === order.indexOf('osc1') + 1, order.join())

    // Pulling a patched cable out and dropping it on nothing still just
    // unplugs it: that is how a cable comes out.
    const jack = await centreOf(`.jack[data-module="${added?.id}"][data-port="cv"]`)
    if (jack) {
      await page.mouse.move(jack.x, jack.y)
      await page.mouse.down()
      await page.mouse.move(jack.x + 250, jack.y + 40, { steps: 6 })
      await page.mouse.up()
      await edited()
      check('a cable pulled out and let go of is unplugged', !(await page.$('.search')) &&
        !(await rack()).cables.some((c) => c.to.module === added?.id && c.to.port === 'cv'))
    }
  }
}

console.log('\nbypass')
{
  const lamp = await page.$('.unit-flip[data-module="lpf1"] .unit-face-back .unit-bypass')
  check('a filter has a bypass lamp', !!lamp)
  check('an oscillator does not', !(await page.$('.unit-flip[data-module="osc1"] .unit-bypass')))
  if (lamp) {
    await lamp.click()
    await edited()
    check('it switches the module out', (await rack()).modules.find((m) => m.id === 'lpf1')?.bypass === true)
    check('and the panel says so', await page.evaluate(() => !!document.querySelector('.unit-flip[data-module="lpf1"].bypassed')))
    await lamp.click()
    await edited()
    check('and back in', !(await rack()).modules.find((m) => m.id === 'lpf1')?.bypass)
  }
}

console.log('\ncable colours')
{
  const colored = () =>
    page.evaluate(() => [...document.querySelectorAll('.cables g.cable:not(.cable-dragging)')].map((g) => g.style.getPropertyValue('--cable-h')))
  const bySignal = await colored()
  check('by signal, sound and control cables differ', new Set(bySignal).size >= 2, [...new Set(bySignal)].join(','))
  const mid = await page.evaluate(() => {
    const path = document.querySelector('.cables g.cable .cable-line')
    if (!path) return null
    const p = path.getPointAtLength(path.getTotalLength() / 2)
    const box = path.ownerSVGElement.getBoundingClientRect()
    return { x: box.left + p.x, y: box.top + p.y }
  })
  if (mid) {
    const before = (await rack()).cables.length
    await page.keyboard.down('Alt')
    await page.mouse.click(mid.x, mid.y)
    await page.keyboard.up('Alt')
    await edited()
    const cables = (await rack()).cables
    check('Alt+click gives a cable its own colour', cables.some((c) => typeof c.color === 'number'))
    check('rather than unplugging it', cables.length === before)
  }
}

console.log('\ncopying modules')
{
  await flipRack(page, false)
  const spine = await page.$('.unit-flip[data-module="lpf1"] .unit-face-front .unit-spine')
  await spine.click()
  await wait(100)
  check('a click on its ear picks it', await page.evaluate(() => !!document.querySelector('.unit-flip[data-module="lpf1"].selected')))
  await press('KeyC', ['Control'])
  await wait(100)
  const before = (await rack()).modules.length
  await press('KeyV', ['Control'])
  await edited()
  const after = await rack()
  const copies = after.modules.filter((m) => m.type === 'ladder')
  check('Ctrl+C and Ctrl+V copy it', after.modules.length === before + 1, `${before} -> ${after.modules.length}`)
  check('knobs and all', copies.length >= 2 && copies.every((m) => m.params.cutoff === copies[0].params.cutoff))

  // Shift+click picks several; dragging one of them carries them all, closed
  // up into one block, and a click on one that goes nowhere moves nothing.
  const ear = (id) => page.$(`.unit-flip[data-module="${id}"] .unit-face-front .unit-spine .unit-name`)
  await (await ear('key1')).click()
  await page.keyboard.down('Shift')
  await (await ear('vca1')).click()
  await page.keyboard.up('Shift')
  await wait(100)
  const picked = await page.evaluate(() => [...document.querySelectorAll('.unit-flip.selected')].map((e) => e.dataset.module))
  check('Shift+click picks several', picked.join() === 'key1,vca1', picked.join())
  const was = (await rack()).modules.map((m) => m.id)
  await (await ear('key1')).click()
  await edited()
  check('a click on one of them moves nothing', (await rack()).modules.map((m) => m.id).join() === was.join())
  check('and keeps them both picked', await page.evaluate(() => document.querySelectorAll('.unit-flip.selected').length === 2))

  const grip = await (await ear('key1')).boundingBox()
  const last = await (await page.$(`.unit-flip[data-module="${was[was.length - 1]}"]`)).boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2, last.y + last.height + 60, { steps: 20 })
  await page.mouse.up()
  await edited()
  const now = (await rack()).modules.map((m) => m.id)
  check('dragging one of them carries both, as one block', now.slice(-2).join() === 'key1,vca1' && now.length === was.length, now.join())
}

console.log('\nthe library keeps your racks')
{
  await pickMenu('Patch', 'Library...')
  await wait(200)
  await clickText('.sheet-foot .dock-toggle', 'Save this rack here')
  await wait(200)
  const shelf = await page.evaluate(() => document.querySelector('.library-shelf.at span')?.textContent?.trim())
  check('Save this rack here files it under My patches', shelf === 'My patches', String(shelf))
  const names = await page.evaluate(() => [...document.querySelectorAll('.library-row .library-name')].map((e) => e.textContent))
  check('under the track name', names.includes('Rack'), names.join(','))
  const star = await page.$('.library-star')
  await star.click()
  await wait(100)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await wait(150)
  const favs = await page.evaluate(() => [...document.querySelectorAll('.library-row .library-name')].map((e) => e.textContent))
  check('a star puts it on Favourites', favs.includes('Rack'), favs.join(','))
  await press('Escape')
  await wait(150)
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.library.mine.v1') ?? '[]').length)
  check('and it is kept in this browser', kept === 1)
}

console.log('\nthe Music toggle')
{
  const closed = () => page.evaluate(() => !!document.querySelector('.dock.dock-closed'))
  const was = await closed()
  check('View has it', await pickMenu('View', 'Music'))
  check('and it opens or folds the dock', (await closed()) !== was)
  await press('KeyM', ['Control'])
  await wait(150)
  check('so does Ctrl+M', (await closed()) === was)
  if (await closed()) await press('KeyM', ['Control'])
  await wait(200)
}

console.log('\npatterns, kept house')
{
  // Kept where they are listed, on the playlist, the way tracks are on the
  // track list: added from the foot of it; renamed, coloured, copied and
  // deleted on their rows. A new pattern is the one picked, so its row is lit.
  await clickText('.dock-views .dock-toggle', 'Song')
  await wait(200)
  await clickText('.playlist-pane .track-add', '+ Pattern')
  await edited()
  check('a pattern is added from the foot of the playlist', (await stored()).song.patterns.length === 2)
  const renameTo = async (text, key = 'Enter') => {
    await page.click('.playlist-row.on .playlist-name', { clickCount: 3 })
    await page.keyboard.type(text)
    await press(key)
    await edited()
    return (await stored()).song
  }
  let song = await renameTo('Chorus')
  check('a pattern can be renamed', song.patterns[1]?.name === 'Chorus', song.patterns.map((p) => p.name).join())
  song = await renameTo('Verse', 'Escape')
  check('Escape keeps the name it had', song.patterns[1]?.name === 'Chorus', song.patterns.map((p) => p.name).join())
  await page.click('.playlist-row.on .playlist-name', { clickCount: 3 })
  await press('Backspace')
  await press('Enter')
  await edited()
  song = (await stored()).song
  check('and a blank name is not kept', song.patterns[1]?.name === 'Chorus', song.patterns.map((p) => p.name).join())
  await page.click('.playlist-row.on .swatch')
  await edited()
  song = (await stored()).song
  check('and given a colour', typeof song.patterns[1]?.color === 'number')
  await page.click('.playlist-row.on button[aria-label="Copy Chorus"]')
  await edited()
  song = (await stored()).song
  check('a row copies its own pattern', song.patterns.length === 3, song.patterns.map((p) => p.name).join())
  await page.click('.playlist-row.on button[aria-label^="Delete"]')
  await edited()
  check('and deletes its own', (await stored()).song.patterns.length === 2)
  // Undoable, so no confirm -- but it says so, since the placements went too.
  check(
    'and says how to get it back',
    await page.evaluate(() => /Removed .+ Ctrl\+Z to undo/.test(document.querySelector('.notice-text')?.textContent ?? '')),
    await page.evaluate(() => document.querySelector('.notice-text')?.textContent ?? ''),
  )
  await press('KeyZ', ['Control'])
  await edited()
  check('which undoes', (await stored()).song.patterns.length === 3)
}

console.log('\nsliding a placement')
{
  await clickText('.dock-views .dock-toggle', 'Song')
  await wait(200)
  const row = (await page.$$('.playlist-row'))[0]
  const cells = await row.$$('.playlist-cell')
  const a = await cells[0].boundingBox()
  const b = await cells[3].boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 })
  await page.mouse.up()
  await edited()
  const playlist = (await stored()).song.playlist
  check('dragging a placement slides it to another bar', playlist.length === 1 && playlist[0].tick === 3 * 3840, JSON.stringify(playlist))
  await clickText('.dock-views .dock-toggle', 'Roll')
  await wait(200)
}

console.log('\ntracks, kept house')
{
  await page.click('.track-add')
  await edited()
  const ids = (await stored()).song.tracks.map((t) => t.id)
  const grips = await page.$$('.track-grip')
  const top = await (await page.$$('.track'))[0].boundingBox()
  const g = await grips[1].boundingBox()
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(g.x + g.width / 2, top.y + 4, { steps: 6 })
  await page.mouse.up()
  await edited()
  const order = (await stored()).song.tracks.map((t) => t.id)
  check('dragging a track by its grip reorders the list', order.join() === [...ids].reverse().join(), order.join())
  await (await page.$$('.track .swatch'))[0].click()
  await edited()
  check('a track can be given a colour', typeof (await stored()).song.tracks[0].color === 'number')
  const db = await page.evaluate(() => document.querySelector('.track-db')?.textContent)
  check('its level reads in decibels', /dB$/.test(db ?? ''), String(db))

  // Two different actions in quick succession are two steps of undo. Every
  // dock edit used to go out under one key, so these folded into one, and a
  // single Ctrl+Z took both back.
  await (await page.$$('.track .track-flag[aria-label^="Mute"]'))[0].click()
  await (await page.$$('.track .track-flag[aria-label^="Solo"]'))[1].click()
  await edited()
  let t = (await stored()).song.tracks
  check('mute then solo, quickly', !!t[0].mute && !!t[1].solo, JSON.stringify(t.map((x) => [x.mute, x.solo])))
  check(
    'the buttons say whether they are down',
    await page.evaluate(() => document.querySelectorAll('.track .track-flag[aria-pressed="true"]').length === 2),
  )
  await press('KeyZ', ['Control'])
  await edited()
  t = (await stored()).song.tracks
  check('one undo takes back only the solo', !!t[0].mute && !t[1].solo, JSON.stringify(t.map((x) => [x.mute, x.solo])))
  await press('KeyZ', ['Control'])
  await edited()
  t = (await stored()).song.tracks
  check('and the next, the mute', !t[0].mute && !t[1].solo, JSON.stringify(t.map((x) => [x.mute, x.solo])))

  // Removing a track is undoable, so it asks nothing -- and says so.
  await (await page.$$('.track .track-remove'))[1].click()
  await edited()
  check('a track removes with one click', (await stored()).song.tracks.length === ids.length - 1)
  check(
    'and says how to get it back',
    await page.evaluate(() => /Removed .+ -- Ctrl\+Z to undo/.test(document.querySelector('.notice-text')?.textContent ?? '')),
  )
  await press('KeyZ', ['Control'])
  await edited()
  check('which it does', (await stored()).song.tracks.length === ids.length)
}

console.log('\nthe roll comes back as it was left')
{
  const grid = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.dock-field select')].find((s) => [...s.options].some((o) => o.textContent === '1/8 T')),
  )
  await grid.asElement().evaluate((s) => {
    s.value = String([...s.options].find((o) => o.textContent === '1/8').value)
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.select('.roll-tools select[aria-label="Chord"]', 'min7')
  await clickText('.dock-views .dock-toggle', 'In song')
  // The dock's settings debounce on their own, and pagehide does not flush them.
  await wait(700)
  await page.reload({ waitUntil: 'networkidle0' })
  await wait(400)
  const state = await page.evaluate(() => ({
    grid: [...document.querySelectorAll('.dock-field select')]
      .find((s) => [...s.options].some((o) => o.textContent === '1/8 T'))
      ?.selectedOptions[0]?.textContent,
    chord: document.querySelector('.roll-tools select[aria-label="Chord"]')?.value,
    inSong: [...document.querySelectorAll('.dock-toggle.on')].some((b) => b.textContent.trim() === 'In song'),
  }))
  check('the grid', state.grid === '1/8', String(state.grid))
  check('the chord', state.chord === 'min7', String(state.chord))
  check('and what the roll plays', state.inSong)
}

console.log('\npresets, the rack index and the compact rack')
{
  // Back to the first track's rack, which is the one rack() reads: adding a
  // track above put the new one on the bench.
  for (const row of await page.$$('.track')) {
    const name = await row.$eval('.track-name', (i) => i.value)
    if (name === 'Rack') await (await row.$('.track-db')).click()
  }
  // Until that track is the one on the bench and its rack has been drawn: a
  // handle taken on the rack before then belongs to the old one, and comes
  // loose from the page as soon as it is swapped out.
  await waitUntil(page, () => document.querySelector('.track.on .track-name')?.value === 'Rack')
  await edited()
  // A preset saved from one Ladder puts its knobs on another.
  const lpf = await page.$('.unit-flip[data-module="lpf1"] .unit-face-front .unit-presets')
  check('a module has a presets button on its ear', !!lpf)
  if (lpf) {
    await lpf.click()
    await waitUntil(page, () => !!document.querySelector('.preset-sheet input'))
    await page.type('.preset-sheet input', 'Dark')
    await press('Enter')
    await waitUntil(page, () => [...document.querySelectorAll('.preset-load')].some((b) => b.textContent === 'Dark'))
    const listed = await page.evaluate(() => [...document.querySelectorAll('.preset-load')].map((b) => b.textContent))
    check('its knobs can be saved under a name', listed.includes('Dark'), listed.join(','))
    await press('Escape')
    await wait(100)
    const other = (await rack()).modules.find((m) => m.type === 'ladder' && m.id !== 'lpf1')
    const cutoff = (await rack()).modules.find((m) => m.id === 'lpf1').params.cutoff
    const btn = await page.$(`.unit-flip[data-module="${other.id}"] .unit-face-front .unit-presets`)
    // Moved away first, so the loaded value is visibly the preset's.
    await page.evaluate(() => 0)
    await btn.click()
    await wait(150)
    await clickText('.preset-load', 'Dark')
    await edited()
    const loaded = (await rack()).modules.find((m) => m.id === other.id).params.cutoff
    check('and put back on another of its kind', loaded === cutoff, `${loaded} vs ${cutoff}`)
    await press('Escape')
    await wait(100)

    // Saving over a name already there asks first, whatever its case, since
    // the knobs it held are gone for good.
    await lpf.click()
    await wait(150)
    await page.type('.preset-sheet input', 'dark')
    await press('Enter')
    await wait(150)
    const asking = await page.evaluate(() => document.querySelector('.preset-sheet [type="submit"]')?.textContent)
    check('saving over a preset asks first', asking === 'Replace?', asking)
    await press('Enter')
    await wait(150)
    const after = await page.evaluate(() => [...document.querySelectorAll('.preset-load')].map((b) => b.textContent))
    check('and the second press replaces it', after.length === 1 && after[0] === 'dark', after.join(','))

    // And deleting one takes two presses.
    await page.click('.preset-sheet .preset-delete')
    await wait(100)
    const once = await page.evaluate(() => ({
      rows: document.querySelectorAll('.preset-load').length,
      says: document.querySelector('.preset-delete')?.textContent,
    }))
    check('one press on delete only asks', once.rows === 1 && once.says === 'Delete?', JSON.stringify(once))
    await page.click('.preset-sheet .preset-delete')
    await wait(100)
    check('the second deletes it', (await page.evaluate(() => document.querySelectorAll('.preset-load').length)) === 0)
    await press('Escape')
    await wait(100)
  }

  const options = await page.evaluate(() => [...document.querySelectorAll('.rack-index option')].map((o) => o.value).filter(Boolean))
  check('the rack index lists every unit', options.length === (await rack()).modules.length, options.join(','))
  await page.select('.rack-index', 'mix1')
  // Scrolled smoothly, so until it is in view rather than for a guess at it.
  await waitUntil(page, () => {
    const r = document.querySelector('.unit-flip[data-module="mix1"]').getBoundingClientRect()
    return r.top >= 0 && r.bottom <= window.innerHeight + 1
  })
  const seen = await page.evaluate(() => {
    const r = document.querySelector('.unit-flip[data-module="mix1"]').getBoundingClientRect()
    return r.top >= 0 && r.bottom <= window.innerHeight + 1
  })
  check('and choosing one brings it into view', seen)
  check('picked, so it is lit when it arrives', await page.evaluate(() => !!document.querySelector('.unit-flip[data-module="mix1"].selected')))
  // And the focus goes with it, so the next Tab is inside that unit rather
  // than back at the top of the page.
  check(
    'with the focus on it',
    await page.evaluate(() => document.activeElement?.matches('.unit-flip[data-module="mix1"]') ?? false),
    await page.evaluate(() => document.activeElement?.className ?? ''),
  )

  const tall = await page.evaluate(() => document.querySelector('.rack').scrollHeight)
  check('Compact rack is on the View menu', await pickMenu('View', 'Compact rack'))
  await wait(300)
  const short = await page.evaluate(() => document.querySelector('.rack').scrollHeight)
  check('and makes the rack shorter', short < tall * 0.9, `${tall} -> ${short}`)
  await pickMenu('View', 'Compact rack')
  await wait(300)
}

console.log('\nthe mix, measured and levelled')
{
  // A note held down on the roll's keys, for something to measure.
  const roll = await (await page.$('.roll-canvas')).boundingBox()
  await page.mouse.move(roll.x + 12, roll.y + roll.height / 2)
  await page.mouse.down()
  await waitUntil(page, () => /^[−-]?\d+\.\d LUFS$/.test(document.querySelector('.strip-lufs')?.textContent ?? ''))
  const reading = await page.evaluate(() => document.querySelector('.strip-lufs')?.textContent ?? '')
  await page.mouse.up()
  check('the mixer reads its loudness in LUFS while it plays', /^[−-]?\d+\.\d LUFS$/.test(reading), reading)

  // The level choice is on the recorder, so the rack needs one.
  await press('KeyK', ['Control'])
  await wait(150)
  await page.keyboard.type('recorder')
  await press('Enter')
  await edited()
  const levels = await page.evaluate(() => [...document.querySelectorAll('.export-format select')].map((s) => [...s.options].map((o) => o.textContent)))
  check('the recorder offers a level to render to', levels.some((o) => o.includes('−16 LUFS')), JSON.stringify(levels))
}

console.log('\nsections and the time signature')
{
  await clickText('.dock-views .dock-toggle', 'Song')
  await wait(200)
  const slots = await page.$$('button.playlist-marker-slot')
  await slots[0].click()
  await edited()
  let song = (await stored()).song
  check('a click on the sections strip adds a marker', song.markers?.length === 1 && song.markers[0].tick === 0, JSON.stringify(song.markers))
  // A bar number adds one too, even inside a section the strip is covering.
  const numbers = await page.$$('button.playlist-bar')
  await numbers[3].click()
  await edited()
  song = (await stored()).song
  check('and a click on a bar number adds another', song.markers?.length === 2 && song.markers[1].tick === 3 * 3840,
    JSON.stringify(song.markers))
  const chip = await page.$('.playlist-marker')
  await chip.click()
  await wait(200)
  check('a click on a marker loops its section', await page.evaluate(() => !!document.querySelector('.playlist-marker.on')))
  check('lit in the ruler', await page.evaluate(() => document.querySelectorAll('.playlist-bar.in-section').length > 0))
  await chip.click({ clickCount: 2 })
  await wait(150)
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.type('Intro')
  await press('Enter')
  await edited()
  song = (await stored()).song
  check('a double-click renames it', song.markers?.some((m) => m.name === 'Intro'), JSON.stringify(song.markers))

  await page.evaluate(() => {
    const s = [...document.querySelectorAll('.dock-field select')].find((x) => [...x.options].some((o) => o.value === '3/4'))
    s.value = '3/4'
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await edited()
  song = (await stored()).song
  check('the time signature can be set', song.meter?.beats === 3 && song.meter?.unit === 4, JSON.stringify(song.meter))
  check('and the markers keep their bars', song.markers.some((m) => m.tick === 3 * 3 * 960), JSON.stringify(song.markers))
  await clickText('.dock-views .dock-toggle', 'Roll')
  await wait(200)
}

console.log('\nthe song console')
{
  await clickText('.dock-views .dock-toggle', 'Mix')
  await wait(300)
  const strips = await page.$$('.mix-strips .mix-strip')
  const tracks = (await stored()).song.tracks
  check('the Mix view has a strip for every track', strips.length === tracks.length, `${strips.length} strips, ${tracks.length} tracks`)
  check('and the track list gives it the room', !(await page.$('.tracks')))
  check('with the two shared effects and the master', !!(await page.$('.mix-returns')) && !!(await page.$('.mix-master')))

  // A fader, moved from the keyboard: down is quieter, in dB.
  const fader = await page.$('.mix-strips .mix-fader')
  await fader.focus()
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown')
  await edited()
  const gain = (await stored()).song.tracks[0].gain
  check('a fader sets the track level', gain < 0.6 && gain > 0, String(gain))

  // Sixty presses, one drag's worth, are one step back.
  await press('KeyZ', ['Control'])
  await edited()
  check('and a whole fader move undoes in one step', (await stored()).song.tracks[0].gain === 1, String((await stored()).song.tracks[0].gain))

  await clickText('.mix-master .dock-toggle', 'Limit')
  await edited()
  check('the limiter is on by default and can be switched off', (await stored()).song.console?.master.limiter === false)
  await clickText('.mix-master .dock-toggle', 'Limit')
  await edited()

  // Roll, Song and Mix are chosen on the dock's bar, and only there.
  check('the View menu has no Mix of its own', !(await pickMenu('View', 'Mix')))
  await clickText('.dock-views .dock-toggle', 'Roll')
  await wait(200)
}

console.log('\nknob help')
{
  const knob = await page.$('.unit-flip[data-module="lpf1"] .unit-face-front .knob')
  const box = await knob.boundingBox()
  const hover = async () => {
    await page.mouse.move(5, 5)
    await wait(100)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await wait(1100)
    return page.evaluate(() => document.querySelector('.knob-help')?.textContent ?? null)
  }
  const shown = await hover()
  check('resting on a knob explains it, in the manual\'s words', shown === 'CutoffWhere the filter turns over', String(shown))
  await page.mouse.down()
  await wait(50)
  check('and taking hold of it puts the card away', !(await page.$('.knob-help')))
  await page.mouse.up()
  check('the View menu can turn it off', await pickMenu('View', 'Knob help'))
  check('and then nothing shows', (await hover()) === null)
  await page.reload({ waitUntil: 'networkidle0' })
  await wait(400)
  const knob2 = await page.$('.unit-flip[data-module="lpf1"] .unit-face-front .knob')
  const b2 = await knob2.boundingBox()
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2)
  await wait(1100)
  check('and it stays off after a reload', !(await page.$('.knob-help')))
  await pickMenu('View', 'Knob help')
}

await finish()
