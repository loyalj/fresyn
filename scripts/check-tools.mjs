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

const laneAt = (bar, lane) =>
  page.evaluate((bar, lane) => {
    const r = document.querySelector('.playlist-layer').getBoundingClientRect()
    const w = parseFloat(getComputedStyle(document.querySelector('.playlist-grid')).getPropertyValue('--bar-w'))
    return { x: r.left + bar * w, y: r.top + lane * 24 + 12 }
  }, bar, lane)
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
    await page.click('.playlist-pattern.on .playlist-name', { clickCount: 3 })
    await page.keyboard.type(text)
    await press(key)
    await edited()
    return (await stored()).song
  }
  let song = await renameTo('Chorus')
  check('a pattern can be renamed', song.patterns[1]?.name === 'Chorus', song.patterns.map((p) => p.name).join())
  song = await renameTo('Verse', 'Escape')
  check('Escape keeps the name it had', song.patterns[1]?.name === 'Chorus', song.patterns.map((p) => p.name).join())
  await page.click('.playlist-pattern.on .playlist-name', { clickCount: 3 })
  await press('Backspace')
  await press('Enter')
  await edited()
  song = (await stored()).song
  check('and a blank name is not kept', song.patterns[1]?.name === 'Chorus', song.patterns.map((p) => p.name).join())
  await page.click('.playlist-pattern.on .swatch')
  await edited()
  song = (await stored()).song
  check('and given a colour', typeof song.patterns[1]?.color === 'number')
  await page.click('.playlist-pattern.on button[aria-label="Copy Chorus"]')
  await edited()
  song = (await stored()).song
  check('a row copies its own pattern', song.patterns.length === 3, song.patterns.map((p) => p.name).join())
  await page.click('.playlist-pattern.on button[aria-label^="Delete"]')
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

console.log('\nediting clips')
{
  await clickText('.dock-views .dock-toggle', 'Song')
  await wait(200)
  const drag = async (from, to, mods = []) => {
    for (const m of mods) await page.keyboard.down(m)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.up()
    for (const m of mods) await page.keyboard.up(m)
    await edited()
    return (await stored()).song.playlist
  }
  check('the Song view has no pattern menu on the bar: its list is beside the lanes',
    await page.evaluate(() => !document.querySelector('.dock-bar select[aria-label="Pattern"]')))
  let playlist = await drag(await laneAt(0.5, 0), await laneAt(3.5, 0))
  check('dragging a clip slides it to another bar', playlist.length === 1 && playlist[0].tick === 3 * 3840, JSON.stringify(playlist))

  // By its right-hand edge: drawn out to two bars, the pattern repeats.
  const clip = await (await page.$('.playlist-clip')).boundingBox()
  playlist = await drag({ x: clip.x + clip.width - 2, y: clip.y + clip.height / 2 }, await laneAt(5, 0))
  check('dragging its end trims it -- here, out to two bars', playlist[0].length === 2 * 3840, JSON.stringify(playlist))
  check('and the repeat is drawn', (await page.$$('.playlist-clip .seam')).length === 1)

  const cut = await laneAt(4, 0)
  await page.keyboard.down('Control')
  await page.mouse.click(cut.x, cut.y)
  await page.keyboard.up('Control')
  await edited()
  playlist = (await stored()).song.playlist
  check('a Ctrl+click splits it in two where it was clicked',
    playlist.length === 2 && playlist[0].length === 3840 && playlist[1].tick === 4 * 3840 && playlist[1].length === 3840,
    JSON.stringify(playlist))

  // Shift+drag copies: the one grabbed is picked, so it is the one copied.
  playlist = await drag(await laneAt(4.5, 0), await laneAt(6.5, 1), ['Shift'])
  check('Shift+drag copies a clip, into another lane too', playlist.length === 3 && playlist[2].tick === 6 * 3840 && playlist[2].lane === 1,
    JSON.stringify(playlist))
  // The copy is what is picked now, so Delete takes it away.
  await press('Delete')
  await edited()
  check('and Delete deletes what is picked', (await stored()).song.playlist.length === 2)
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

console.log('\nfolders, hiding, finding and pinning tracks')
{
  /** Pick a row from the menu that is open, by its label. */
  const fromMenu = async (label) => {
    const ok = await page.evaluate((label) => {
      const row = [...document.querySelectorAll('.context-menu button')].find((b) => b.querySelector('.menu-text')?.textContent === label)
      row?.click()
      return !!row
    }, label)
    await edited()
    return ok
  }
  const moreFor = async (index) => {
    await (await page.$$('.track .track-more'))[index].click()
    await wait(100)
  }
  const shownTracks = () => page.$$eval('.track .track-name', (els) => els.map((e) => e.value))

  await clickText('.tracks-foot .track-add', '+ Folder')
  await edited()
  let song = (await stored()).song
  check('+ Folder makes an empty folder', song.folders?.length === 1 && (await page.$$('.track-folder')).length === 1)
  const folder = song.folders[0].id

  // Filed by dragging its grip onto the folder's row.
  // Measured after the press: pressing a track also puts its rack on the
  // bench, and a rack of another height moves the dock under the pointer.
  const grip = await (await page.$$('.track-grip'))[0].boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await edited()
  const header = await (await page.$('.track-folder')).boundingBox()
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2, { steps: 6 })
  await page.mouse.up()
  await edited()
  song = (await stored()).song
  const filed = song.tracks.find((t) => t.folder === folder)
  check('dragging a track onto a folder files it there', !!filed, JSON.stringify(song.tracks.map((t) => t.folder)))
  check('drawn under it', (await page.$$('.track.in-folder')).length === 1)

  await page.click('.track-folder .track-fold')
  await edited()
  check('a folder folds its tracks away', (await page.$$('.track.in-folder')).length === 0 && (await stored()).song.folders[0].collapsed === true)
  await page.click('.track-folder .track-fold')
  await edited()

  await page.click('.track-folder .track-flag[aria-label^="Mute"]')
  await edited()
  check('a folder\'s mute silences its tracks', await page.evaluate(() => !!document.querySelector('.track.in-folder.silent')))
  await page.click('.track-folder .track-flag[aria-label^="Mute"]')
  await edited()

  // Search.
  const loose = song.tracks.find((t) => t.folder !== folder)
  await page.click('.tracks-search')
  // By the folder's name, which finds the tracks filed in it.
  await page.keyboard.type(song.folders[0].name)
  await wait(100)
  check('a search narrows the list, here by folder name', (await shownTracks()).join() === filed.name, (await shownTracks()).join())
  await press('Escape')
  await wait(100)
  check('and Escape clears it', (await shownTracks()).length === 2)

  // Hidden: out of the list, still playing, and back with the toggle.
  const before = await shownTracks()
  await moreFor(before.indexOf(loose.name))
  check('a track\'s menu can hide it', await fromMenu('Hide (still plays)'))
  check('which takes it out of the list', !(await shownTracks()).includes(loose.name))
  check('and says one is hidden', await page.evaluate(() => /1 hidden/.test(document.querySelector('.tracks-hidden')?.textContent ?? '')))
  check('without muting it', !(await stored()).song.tracks.find((t) => t.id === loose.id).mute)
  await page.click('.tracks-hidden')
  await wait(100)
  check('the toggle lists it again, marked', (await page.$$('.track.hidden-track')).length === 1)
  await moreFor((await shownTracks()).indexOf(loose.name))
  await fromMenu('Show')
  check('and its menu shows it', !(await stored()).song.tracks.find((t) => t.id === loose.id).hidden)
  check('after which there is nothing hidden to toggle', !(await page.$('.tracks-hidden')))

  // Pinned: to the top of the list, out of the folder's rows.
  await moreFor((await shownTracks()).indexOf(filed.name))
  await fromMenu('Pin to the top')
  check('a pinned track goes to the top', (await shownTracks())[0] === filed.name, (await shownTracks()).join())
  check('above a rule', !!(await page.$('.tracks-rule')))
  await moreFor(0)
  await fromMenu('Pin to the top')

  // Taking the folder away keeps its track.
  await (await page.$('.track-folder .track-more')).click()
  await wait(100)
  await fromMenu('Remove folder (keeps its tracks)')
  song = (await stored()).song
  check('removing a folder keeps its tracks', !song.folders && song.tracks.length === 2 && song.tracks.every((t) => !t.folder))
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
  const BAR = 3840
  /** A point on the sections strip, so many bars along. */
  const strip = (bars) =>
    page.evaluate((bars) => {
      const r = document.querySelector('.playlist-section-layer').getBoundingClientRect()
      const w = parseFloat(getComputedStyle(document.querySelector('.playlist-grid')).getPropertyValue('--bar-w'))
      return { x: r.left + bars * w, y: r.top + r.height / 2 }
    }, bars)
  const sections = async () => (await stored()).song.sections ?? []
  const where = (list) => list.map((x) => `${x.name}@${x.tick / BAR}+${x.length / BAR}`).join(', ')

  let at = await strip(0.5)
  await page.mouse.click(at.x, at.y)
  await edited()
  let list = await sections()
  check('a click on the empty strip makes a four-bar section', list.length === 1 && list[0].tick === 0 && list[0].length === 4 * BAR, where(list))
  // A bar number inside a section cuts it in two there.
  const numbers = await page.$$('button.playlist-bar')
  await numbers[3].click()
  await edited()
  list = await sections()
  check('a click on a bar number splits the section over it', list.length === 2 && list[1].tick === 3 * BAR && list[0].length === 3 * BAR, where(list))
  // Drawn out across empty strip: as long as the drag.
  const from = await strip(6.2)
  const to = await strip(8.1)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  await edited()
  list = await sections()
  check('dragging across the strip makes a section that long', list.length === 3 && list[2].tick === 6 * BAR && list[2].length === 2 * BAR, where(list))

  const first = await page.$('.playlist-section')
  await first.click({ clickCount: 2 })
  await wait(150)
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.type('Intro')
  await press('Enter')
  await edited()
  list = await sections()
  check('a double-click renames it', list[0]?.name === 'Intro', where(list))
  // The double-click's first click looped it; one more stops that, and one
  // more starts it again.
  await (await page.$('.playlist-section')).click()
  await wait(250)
  check('a click on a looped section stops looping it', await page.evaluate(() => !document.querySelector('.playlist-section.on')))
  await (await page.$('.playlist-section')).click()
  await wait(200)
  check('and a click loops it', await page.evaluate(() => !!document.querySelector('.playlist-section.on')))
  check('lit in the ruler', await page.evaluate(() => document.querySelectorAll('.playlist-bar.in-section').length === 3))

  // Its × takes the label and leaves the music.
  const clipsBefore = (await stored()).song.playlist.length
  const last = (await page.$$('.playlist-section'))[2]
  await last.hover()
  await (await last.$('.playlist-section-remove')).click()
  await edited()
  list = await sections()
  check('a section\'s × removes it', list.length === 2, where(list))
  check('and leaves its music', (await stored()).song.playlist.length === clipsBefore)

  // Dragged by its body to the front: the song closes up behind it.
  const second = await (await page.$$('.playlist-section'))[1].boundingBox()
  const front = await strip(0.2)
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2)
  await page.mouse.down()
  await page.mouse.move(front.x, front.y, { steps: 8 })
  await page.mouse.up()
  await edited()
  list = await sections()
  check('dragging a section moves it', list[0]?.tick === 0 && list[0].length === BAR && list[1]?.name === 'Intro' && list[1].tick === BAR, where(list))
  check('and the one being looped is still looped where it went',
    await page.evaluate(() => document.querySelector('.playlist-section.on')?.textContent?.includes('Intro') ?? false))

  // Dragged into empty time past the end, it slides there, drawn under the
  // pointer all the way.
  const intro = await (await page.$$('.playlist-section'))[1].boundingBox()
  // Held by its middle, a bar and a half in: let go at 11.6 bars, it starts
  // at 10.1, which the bar snap puts on 10.
  const far = await strip(11.6)
  await page.mouse.move(intro.x + intro.width / 2, intro.y + intro.height / 2)
  await page.mouse.down()
  await page.mouse.move(far.x, far.y, { steps: 8 })
  const inHand = await page.evaluate(() => document.querySelector('.playlist-section.sliding')?.getBoundingClientRect().left ?? null)
  await page.mouse.up()
  await edited()
  list = await sections()
  check('a section in hand follows the pointer', inHand !== null && inHand > intro.x + 100, `${intro.x} -> ${inHand}`)
  check('and slides into empty time', list.some((x) => x.name === 'Intro' && x.tick === 10 * BAR), where(list))
  check('the Song view leaves the track list to the roll', !(await page.$('.tracks')))

  await page.evaluate(() => {
    const s = [...document.querySelectorAll('.dock-field select')].find((x) => [...x.options].some((o) => o.value === '3/4'))
    s.value = '3/4'
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await edited()
  const song = (await stored()).song
  check('the time signature can be set', song.meter?.beats === 3 && song.meter?.unit === 4, JSON.stringify(song.meter))
  check('and the sections keep their bars', song.sections.some((m) => m.name === 'Intro' && m.tick === 10 * 3 * 960), JSON.stringify(song.sections))
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

console.log('\nnotices that stay, and every warning')
{
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'fresyn-notice-'))

  // A file that is not a patch at all: an error, which has to outlast news.
  const junk = join(dir, 'junk.json')
  writeFileSync(junk, 'this is not json')
  await (await page.$('.patch-file')).uploadFile(junk)
  await waitUntil(page, () => !!document.querySelector('.notice-warn'))
  await wait(4500)
  check(
    'a file that will not open says so until dismissed',
    await page.evaluate(() => /not valid JSON/.test(document.querySelector('.notice-warn')?.textContent ?? '')),
  )
  await page.click('.notice-warn .notice-close')

  // A patch with two cables to jacks that do not exist: it opens, and both
  // warnings are there to read, not only the first.
  const patch = (await stored())?.racks?.bench?.patch
  const [a, b] = patch.modules
  patch.cables.push(
    { id: 'x1', from: { module: a.id, port: 'nowhere' }, to: { module: b.id, port: 'nothing' } },
    { id: 'x2', from: { module: 'ghost', port: 'out' }, to: { module: b.id, port: 'in' } },
  )
  const bad = join(dir, 'bad.fpatch.json')
  writeFileSync(bad, JSON.stringify({ version: 1, name: 'Bad cables', patch }))
  await (await page.$('.patch-file')).uploadFile(bad)
  await waitUntil(page, () => /warning/.test(document.querySelector('.notice-warn')?.textContent ?? ''))
  const more = await page.$('.notice-warn .notice-more')
  check('a load with warnings offers the rest of them', !!more)
  if (more) {
    await more.click()
    await frames(page)
    const listed = await page.$$eval('.notice-details li', (li) => li.length)
    check('and lists them when asked', listed >= 1, `${listed} listed`)
  }
  await wait(4500)
  check('and stays up to be read', !!(await page.$('.notice-warn')))
  await page.click('.notice-warn .notice-close')
  await press('KeyZ', ['Control'])
  await edited()
}

console.log('\nthe Music dock fits the window')
{
  await page.evaluate(() => localStorage.setItem('fresyn.dock.v1', JSON.stringify({ open: true, height: 620 })))
  await page.setViewport({ width: 390, height: 780 })
  await page.reload({ waitUntil: 'networkidle0' })
  await waitUntil(page, () => !!document.querySelector('.dock-body'))
  const { dock, inner } = await page.evaluate(() => ({
    dock: document.querySelector('.dock').getBoundingClientRect().height,
    inner: innerHeight,
  }))
  check('a height saved on a big screen is capped on a small one', dock <= inner * 0.6 + 2, `${Math.round(dock)} of ${inner}`)
  await page.setViewport({ width: 1280, height: 1900 })
  await waitUntil(page, () => document.querySelector('.dock-body').getBoundingClientRect().height >= 600)
  check(
    'and given back when the window grows',
    await page.evaluate(() => document.querySelector('.dock-body').getBoundingClientRect().height >= 600),
  )
}

console.log('\nnames rename on a double-click')
{
  const trackName = () => page.$eval('.track.on .track-name', (i) => i.value)
  const was = await trackName()
  await page.click('.track.on .track-name')
  await page.keyboard.type('zz')
  await edited()
  check('a single click on a track name does not start renaming it', (await trackName()) === was, await trackName())
  check('and leaves the keys to the rack', await page.$eval('.track.on .track-name', (i) => i.readOnly))
  await page.click('.track.on .track-name', { clickCount: 2 })
  await page.keyboard.type('Bass')
  await press('Enter')
  await edited()
  check('a double-click renames it, replacing the name', (await trackName()) === 'Bass', await trackName())
  check('and Enter puts it back to a label', await page.$eval('.track.on .track-name', (i) => i.readOnly))

  await page.focus('.track.on .track-name')
  await press('F2')
  await page.keyboard.type(was)
  await press('Enter')
  await edited()
  check('F2 renames from the keyboard', (await trackName()) === was, await trackName())

  await clickText('.dock-views .dock-toggle', 'Song')
  await waitUntil(page, () => !!document.querySelector('.playlist-pattern .playlist-name'))
  const patternName = () => page.$eval('.playlist-pattern.on .playlist-name', (i) => i.value)
  const first = await patternName()
  await page.click('.playlist-pattern.on .playlist-name')
  await page.keyboard.type('zz')
  await edited()
  check('a single click on a pattern name only picks it', (await patternName()) === first, await patternName())
  await page.click('.playlist-pattern.on .playlist-name', { clickCount: 2 })
  await page.keyboard.type('Hook')
  await press('Enter')
  await edited()
  check('a double-click renames the pattern', (await patternName()) === 'Hook', await patternName())
  await page.click('.playlist-pattern.on .playlist-name', { clickCount: 2 })
  await page.keyboard.type(first)
  await press('Enter')
  await edited()
}

console.log('\nswing on the roll')
{
  await clickText('.dock-toggle', 'Roll')
  await frames(page)
  const swingOf = async () => (await stored())?.song?.patterns?.[0]?.swing ?? null
  const readout = () => page.evaluate(() => document.querySelector('.swing-readout')?.textContent ?? null)
  check('the roll has a swing control', !!(await page.$('.swing-amount')))
  check('and a new pattern is straight', (await readout()) === 'Off' && (await swingOf()) === null)

  // Eighths chosen while it is off are still eighths once it is turned up.
  await page.select('.swing-field select', '480')
  await edited()
  check('picking the step while straight stores nothing yet', (await swingOf()) === null)
  await page.focus('.swing-amount')
  for (let i = 0; i < 16; i++) await page.keyboard.press('ArrowRight')
  await edited()
  check('the slider turns it up', (await readout()) === '66%', await readout())
  const swing = await swingOf()
  check('and the pattern keeps it, on the step that was picked', swing?.amount === 0.66 && swing?.step === 480, JSON.stringify(swing))

  await page.select('.swing-field select', '240')
  await edited()
  check('the step can be changed while it swings', (await swingOf())?.step === 240)
  await press('KeyZ', ['Control'])
  await edited()
  check('and that change undoes on its own', (await swingOf())?.step === 480, JSON.stringify(await swingOf()))

  await page.focus('.swing-amount')
  await page.keyboard.press('Home')
  await edited()
  check('all the way down is straight again', (await readout()) === 'Off' && (await swingOf()) === null)
}

await finish()
