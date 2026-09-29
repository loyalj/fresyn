import { join } from 'node:path'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { check, finish, flushAutosave, frames, open, problems, settle as wait, waitUntil } from './harness.mjs'

/**
 * End-to-end check for the music dock, in a real browser.
 *
 * The headless checks prove the scheduling arithmetic and the arrangement
 * edits; this proves the part none of them can reach -- that a note drawn
 * with a pointer lands in the document, that a track selected in the list
 * really is the rack on the bench, that a pattern placed on the playlist is
 * the one that plays, and that all of it survives the autosave. Every step
 * goes through the real app, and the sound is read off the mixer's meters
 * rather than out of the engine.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 *
 * Most steps used to sleep 700 ms so the autosave's debounce had passed
 * before the document was read back. stored() flushes the autosave instead,
 * the way the app does on pagehide, and an edit is given two frames to land.
 */
const downloads = mkdtempSync(join(tmpdir(), 'fresyn-'))

const { page, url } = await open({ viewport: { width: 1280, height: 1000 } })

/** An edit has landed: React has committed it and scheduled the autosave. */
const edited = () => frames(page)

const cdp = await page.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })

/** Choose an item from one of the menus on the bar. */
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
    (name) =>
      [...document.querySelectorAll('.menu-item .menu-text')].find(
        (e) => e.textContent.trim() === name,
      ) ?? null,
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

/** Choose an item from a submenu of one of the menus on the bar. */
async function pickNested(menu, submenu, item) {
  const top = await page.evaluateHandle(
    (name) => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === name),
    menu,
  )
  if (!top.asElement()) return false
  await top.asElement().click()
  await wait(120)
  const sub = await page.evaluateHandle(
    (name) => [...document.querySelectorAll('.menu-item .menu-text')].find((e) => e.textContent.trim() === name) ?? null,
    submenu,
  )
  if (!sub.asElement()) {
    await page.keyboard.press('Escape')
    return false
  }
  await sub.asElement().hover()
  await wait(150)
  const leaf = await page.evaluateHandle(
    (name) => [...document.querySelectorAll('.menu-nested .menu-item .menu-text')].find((e) => e.textContent.trim() === name) ?? null,
    item,
  )
  if (!leaf.asElement()) {
    await page.keyboard.press('Escape')
    return false
  }
  await leaf.asElement().click()
  await wait(200)
  return true
}

/** Wait for a file with this extension to finish landing in the download dir. */
async function waitForDownload(ext, seconds = 60) {
  for (let i = 0; i < seconds * 10; i++) {
    const found = readdirSync(downloads).filter((f) => f.endsWith(ext))
    if (found.length) {
      // Chrome renames a .crdownload once the write is complete, but the size
      // can still be settling; wait for it to stop growing.
      const path = join(downloads, found[0])
      let last = -1
      for (let j = 0; j < 60; j++) {
        const size = statSync(path).size
        if (size === last && size > 0) return path
        last = size
        await wait(100)
      }
      return path
    }
    await wait(100)
  }
  return null
}

/** What a WAV header says about itself. */
function readWav(path) {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null
  const channels = b.readUInt16LE(22)
  const rate = b.readUInt32LE(24)
  const bits = b.readUInt16LE(34)
  const dataBytes = b.readUInt32LE(40)
  return { channels, rate, bits, seconds: dataBytes / (rate * channels * (bits / 8)) }
}

// A fresh session every run, so a project left behind by the last one cannot
// make a broken build look like it works.
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

/** The project as the autosave has it, which is the document itself. */
const stored = async () => {
  await flushAutosave(page)
  return page.evaluate(() => {
    const raw = localStorage.getItem('fresyn.project.v1')
    return raw ? JSON.parse(raw) : null
  })
}

const notesOf = async (patternIndex = 0) =>
  (await stored())?.song?.patterns?.[patternIndex]?.notes ?? []

/** Add a module from the Modules menu, wherever in its submenus it lives. */
async function addModule(name) {
  const menu = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Modules'),
  )
  const trigger = menu.asElement()
  if (!trigger) return false
  await trigger.click()
  await wait(120)

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
    await wait(120)
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
      await wait(300)
      return true
    }
  }
  await page.keyboard.press('Escape')
  await wait(120)
  return false
}

console.log('\nthe dock')
{
  check('it starts folded away', (await page.$('.roll-canvas')) === null)
  await page.click('.dock-fold')
  await wait(250)
  check('the fold opens it', (await page.$('.roll-canvas')) !== null)
  check('the transport is there', (await page.$('.dock-play')) !== null)
  check('and so is the track list', (await page.$('.track')) !== null)
  check('with one track to start', (await page.$$('.track')).length === 1)

  // A view button pressed while the dock is folded opens it on that view:
  // asking for the mixer is asking to see it. It never folds it again.
  const viewButton = (name) =>
    page.evaluateHandle((n) => [...document.querySelectorAll('.dock-views .dock-toggle')].find((b) => b.textContent.trim() === n), name)
  await page.click('.dock-fold')
  await wait(250)
  check('folded again', (await page.$('.roll-canvas')) === null)
  await (await viewButton('Mix')).asElement().click()
  await wait(250)
  check('Mix on a folded dock opens it, on the mixer', (await page.$('.mix')) !== null)
  await (await viewButton('Mix')).asElement().click()
  await wait(250)
  check('and pressing it again leaves it open', (await page.$('.mix')) !== null)
  await (await viewButton('Roll')).asElement().click()
  await wait(250)
  check('Roll switches back, still open', (await page.$('.roll-canvas')) !== null)
}

/** Draw a note by dragging on the canvas, the way a hand would. */
async function drawNote(rowFromTop, fromX, toX) {
  const box = await page.$eval('.roll-canvas', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  const y = box.y + 16 + rowFromTop * 12 + 4
  await page.mouse.move(box.x + fromX, y)
  await page.mouse.down()
  await page.mouse.move(box.x + toX, y, { steps: 4 })
  await page.mouse.up()
  await wait(120)
}

console.log('\ndrawing notes')
{
  await drawNote(4, 60, 140)
  await edited()
  const notes = await notesOf()
  check('a drag writes a note', notes.length === 1, `got ${notes.length}`)
  check('it is on the bench track', notes[0]?.track === 'bench', `got ${notes[0]?.track}`)
  check('it snapped to the grid', notes[0]?.tick % 240 === 0, `tick ${notes[0]?.tick}`)
  check('the drag gave it a length', notes[0]?.length > 0, `length ${notes[0]?.length}`)

  const box = await page.$eval('.roll-canvas', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  await page.keyboard.down('Alt')
  await page.mouse.click(box.x + 70, box.y + 16 + 4 * 12 + 4)
  await page.keyboard.up('Alt')
  await edited()
  check('alt-click removes it', (await notesOf()).length === 0)

  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await edited()
  check('ctrl+z puts it back', (await notesOf()).length === 1)
}

/**
 * Where things are on the roll. The row height and the scroll are read off
 * the canvas, which publishes them for exactly this; the rest is the roll's
 * own arithmetic -- the ruler on top, the velocity lane under the rows, and
 * the pattern filling the width.
 */
async function rollGeometry() {
  const r = await page.$eval('.roll-canvas', (el) => {
    const b = el.getBoundingClientRect()
    return {
      x: b.x,
      y: b.y,
      w: el.clientWidth,
      h: el.clientHeight,
      rowH: Number(el.dataset.rowH),
      high: Number(el.dataset.high),
      rows: Number(el.dataset.rows),
      scroll: Number(el.dataset.scroll),
      scrollW: Number(el.dataset.scrollW),
    }
  })
  const project = await stored()
  const length = project?.song?.patterns?.[0]?.length ?? 3840
  // The grid stops short of the scroll bar, when there is one.
  const pxPerTick = (r.w - 40 - r.scrollW) / length
  const room = r.h - 16 - 34 - 2
  const viewH = Math.min(room, r.rows * r.rowH)
  // Borders: the canvas has a one-pixel one, which getBoundingClientRect
  // includes and the drawing does not.
  const top = r.y + 1 + 16
  return {
    ...r,
    top,
    bottom: top + viewH,
    tickX: (tick) => r.x + 1 + 40 + tick * pxPerTick,
    pitchY: (pitch) => top - r.scroll + (r.high - pitch) * r.rowH + r.rowH / 2,
  }
}

/**
 * Scroll the rows so `pitch` is in the middle of the view, the way a hand
 * would with the wheel, and say where everything is now. The roll has far
 * more rows than fit, so a row has to be brought into view before it is
 * aimed at.
 */
async function rollAround(pitch) {
  const g = await rollGeometry()
  const mid = (g.top + g.bottom) / 2
  await page.mouse.move(g.tickX(0) + 4, mid)
  // In a trackpad's small steps, which the roll follows to the pixel; a
  // mouse wheel's notches only ever move it a few rows.
  let left = g.pitchY(pitch) - mid
  while (Math.abs(left) >= 1) {
    const step = Math.sign(left) * Math.min(40, Math.abs(left))
    await page.mouse.wheel({ deltaY: step })
    left -= step
  }
  await wait(50)
  return rollGeometry()
}

/** The rows at rest: no wheel notch still gliding. */
const glided = () => waitUntil(page, () => !document.querySelector('.roll-canvas')?.dataset.gliding)

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
  await edited()
}

console.log('\nselecting, copying and stretching')
{
  const g = await rollGeometry()
  check('rows are a comfortable height to aim at', g.rowH >= 16, `${g.rowH.toFixed(1)}px`)
  check('the roll has a row for every one of 128 notes', g.rows === 128, `${g.rows} rows`)
  const [first] = await notesOf()
  const noteX = g.tickX(first.tick + first.length / 2)
  const noteY = g.pitchY(first.pitch)

  // A click selects it, and Ctrl+C / Ctrl+V put a copy at the start of the
  // column under the pointer.
  await page.mouse.click(noteX, noteY)
  await wait(100)
  await press('KeyC', ['Control'])
  await page.mouse.move(g.tickX(1920 + 100), g.pitchY(first.pitch))
  await wait(100)
  await press('KeyV', ['Control'])
  let notes = await notesOf()
  check('a copied note pastes', notes.length === 2, `got ${notes.length}`)
  check(
    'at the start of the column the pointer is over',
    notes[1]?.tick === 1920 && notes[1]?.pitch === first.pitch,
    `tick ${notes[1]?.tick}, pitch ${notes[1]?.pitch}`,
  )

  // Ctrl+D puts another copy of the selection straight after it.
  await press('KeyD', ['Control'])
  notes = await notesOf()
  check('Ctrl+D duplicates it straight after itself', notes.length === 3 && notes[2]?.tick === 1920 + first.length,
    JSON.stringify(notes.map((n) => n.tick)))

  // A rubber band over everything, then up an octave with the keyboard.
  await page.keyboard.down('Control')
  await page.mouse.move(g.tickX(0) + 2, g.top + 2)
  await page.mouse.down()
  await page.mouse.move(g.tickX(3800), g.bottom - 2, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await wait(100)
  await press('ArrowDown', ['Shift'])
  notes = await notesOf()
  check('a Ctrl+drag selects every note it touches, and Shift+Down moves them an octave',
    notes.every((n) => n.pitch === first.pitch - 12), JSON.stringify(notes.map((n) => n.pitch)))

  // The octave down may have scrolled the view to follow the notes.
  const moved = await rollGeometry()
  check('and the view follows them', moved.pitchY(notes[0].pitch) > moved.top && moved.pitchY(notes[0].pitch) < moved.bottom,
    `row at ${moved.pitchY(notes[0].pitch).toFixed(0)}, view ${moved.top.toFixed(0)}..${moved.bottom.toFixed(0)}`)

  // Stretching one of a selection by its end stretches them all by the same.
  const before = notes.map((n) => n.length)
  const endX = moved.tickX(notes[0].tick + notes[0].length) - 1
  const rowY = moved.pitchY(notes[0].pitch)
  await page.mouse.move(endX, rowY)
  await page.mouse.down()
  await page.mouse.move(endX + 60, rowY, { steps: 5 })
  await page.mouse.up()
  await edited()
  notes = await notesOf()
  const grown = notes.map((n, i) => n.length - before[i])
  check('dragging an end stretches the whole selection by the same amount',
    grown[0] > 0 && grown.every((d) => d === grown[0]), `grew by ${grown.join(', ')}`)

  // The rows go on past the Keyboard's two octaves: two more octaves down
  // takes the notes under its bottom key, and the view goes with them.
  await press('ArrowDown', ['Shift'])
  await press('ArrowDown', ['Shift'])
  notes = await notesOf()
  const deep = await rollGeometry()
  check('notes go on down past the bottom of the Keyboard',
    notes[0].pitch < 0 && notes.every((n) => n.pitch === first.pitch - 36), JSON.stringify(notes.map((n) => n.pitch)))
  check('and the view scrolls down to them', deep.pitchY(notes[0].pitch) > deep.top && deep.pitchY(notes[0].pitch) < deep.bottom,
    `row at ${deep.pitchY(notes[0].pitch).toFixed(0)}, view ${deep.top.toFixed(0)}..${deep.bottom.toFixed(0)}`)
  await press('ArrowUp', ['Shift'])
  await press('ArrowUp', ['Shift'])

  // The wheel scrolls the rows when they do not all fit, and Ctrl+wheel
  // makes them taller.
  if (g.bottom - g.top < g.rows * g.rowH) {
    await page.mouse.move(g.tickX(2000), (g.top + g.bottom) / 2)
    // From where the rows are now: the octave move above scrolled them.
    const was = await rollGeometry()
    await page.mouse.wheel({ deltaY: 120 })
    // Part way through its glide, it is between rows: smooth, not stepped.
    await frames(page)
    const mid = await rollGeometry()
    await glided()
    const after = await rollGeometry()
    check('a wheel notch scrolls the rows three rows', Math.abs(after.scroll - was.scroll - 3 * was.rowH) < 0.01,
      `${was.scroll} -> ${after.scroll}, rows ${was.rowH}`)
    check('gliding there rather than jumping', mid.scroll > was.scroll && mid.scroll < after.scroll, `${was.scroll} -> ${mid.scroll} -> ${after.scroll}`)
    for (let i = 0; i < 60; i++) await page.mouse.wheel({ deltaY: -120 })
    await glided()
    check('and stops at the top', (await rollGeometry()).scroll === 0)

    // Wheeling on past the end is still the roll's: whatever scrolls behind
    // it -- the page, or the rack -- stays where it was.
    const scrolled = () =>
      page.evaluate(() =>
        [document.scrollingElement, ...document.querySelectorAll('*')]
          .filter(Boolean)
          .reduce((sum, el) => sum + el.scrollTop, 0),
      )
    // Give whatever can scroll somewhere to go in both directions first, or
    // a rack already at its end could not show the leak.
    await page.evaluate(() => {
      for (const el of [document.scrollingElement, ...document.querySelectorAll('*')]) {
        if (el && el.scrollHeight > el.clientHeight + 40 && !el.closest('.dock')) el.scrollTop = 20
      }
    })
    const behind = await scrolled()
    await page.mouse.wheel({ deltaY: -400 })
    await page.mouse.wheel({ deltaY: 4000 })
    await page.mouse.wheel({ deltaY: 400 })
    await wait(200)
    // The roll's own scroll is drawn, not a DOM scroll, so it is not in the
    // sum: anything that moved here moved behind the roll.
    const behindAfter = await scrolled()
    check('and the rack behind does not scroll with it', behind > 0 && behindAfter === behind,
      `${behind} before, ${behindAfter} after`)
    for (let i = 0; i < 60; i++) await page.mouse.wheel({ deltaY: -120 })
    await glided()

    // The scroll bar down the right is a scroll bar: dragged, it scrolls;
    // clicked, it jumps; and neither lays a note.
    const bar = await rollGeometry()
    const notesBefore = (await notesOf(0)).length
    const barX = bar.x + bar.w - bar.scrollW / 2
    await page.mouse.click(barX, bar.bottom - 4)
    await frames(page)
    const jumped = await rollGeometry()
    check('a click low on the scroll bar jumps the rows down', jumped.scroll > bar.scroll + 100, `${bar.scroll} -> ${jumped.scroll}`)
    check('and lays no note', (await notesOf(0)).length === notesBefore)
    await page.mouse.move(barX, bar.bottom - 4)
    await page.mouse.down()
    await page.mouse.move(barX, bar.top + 4, { steps: 8 })
    await page.mouse.up()
    await frames(page)
    check('dragging the thumb back up scrolls back to the top', (await rollGeometry()).scroll === 0, String((await rollGeometry()).scroll))
    // Taken hold of by the thumb, which is at the top now.
    await page.mouse.move(barX, bar.top + 10)
    await page.mouse.down()
    await page.mouse.move(barX, bar.top + 17, { steps: 3 })
    await page.mouse.up()
    await frames(page)
    const nudged = (await rollGeometry()).scroll
    check('by as little as a pixel of the thumb', nudged > 0 && nudged < 20 * bar.rowH && nudged !== Math.round(nudged / bar.rowH) * bar.rowH,
      String(nudged))
    check('and still no note', (await notesOf(0)).length === notesBefore)
    for (let i = 0; i < 60; i++) await page.mouse.wheel({ deltaY: -120 })
    await glided()
  } else {
    check('the wheel scrolls the rows', false, 'the dock is tall enough to show every row, so nothing to scroll')
  }
  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY: -120 })
  await page.keyboard.up('Control')
  await wait(150)
  const zoomed = await rollGeometry()
  check('Ctrl+wheel makes the rows taller', zoomed.rowH > g.rowH, `${g.rowH.toFixed(1)} -> ${zoomed.rowH.toFixed(1)}`)
  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY: 120 })
  await page.keyboard.up('Control')
  await wait(150)

  // Delete takes the selection away, and undo brings it back.
  await press('Delete')
  check('Delete removes the selection', (await notesOf()).length === 0)
  await press('KeyZ', ['Control'])
  check('and undo brings it back', (await notesOf()).length === 3)

  // Alt+drag paints a note on every step it crosses, spaced by the last
  // length drawn; a right-drag sweeps them away again.
  {
    const row = 20
    const p = await rollAround(row)
    const y = p.pitchY(row)
    const before = (await notesOf()).length
    await page.keyboard.down('Alt')
    await page.mouse.move(p.tickX(10), y)
    await page.mouse.down()
    await page.mouse.move(p.tickX(1900), y, { steps: 12 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await edited()
    let all = await notesOf()
    const painted = all.filter((n) => n.pitch === row)
    const gaps = painted.map((n, i) => (i ? n.tick - painted[i - 1].tick : 0)).slice(1)
    check('Alt+drag paints a line of notes', painted.length >= 3 && all.length === before + painted.length,
      `${painted.length} notes at ${painted.map((n) => n.tick).join(', ')}`)
    check('evenly, at the last length drawn', gaps.length > 0 && gaps.every((d) => d === gaps[0] && d === painted[0].length),
      `gaps ${gaps.join(', ')}`)

    await page.mouse.move(p.tickX(60), y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(p.tickX(1950), y, { steps: 3 })
    await page.mouse.up({ button: 'right' })
    await edited()
    all = await notesOf()
    check('a right-drag erases everything it sweeps over', all.length === before && !all.some((n) => n.pitch === row),
      `${all.length} notes left`)
    await press('KeyZ', ['Control'])
    check('in one step of undo', (await notesOf()).filter((n) => n.pitch === row).length === painted.length)
    await press('KeyZ', ['Control'])
  }

  // A triplet grid, and Quantize bringing a note back to sixteenths.
  {
    const gridSelect = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.dock-field select')].find((s) =>
        [...s.options].some((o) => o.textContent === '1/8 T'),
      ),
    )
    const pick = async (label) => {
      await gridSelect.asElement().evaluate((s, l) => {
        const o = [...s.options].find((x) => x.textContent === l)
        s.value = o.value
        s.dispatchEvent(new Event('change', { bubbles: true }))
      }, label)
      await wait(200)
    }
    await pick('1/8 T')
    const p = await rollAround(22)
    const before = (await notesOf()).length
    await page.mouse.click(p.tickX(330), p.pitchY(22))
    await edited()
    let drawn = (await notesOf()).find((n) => n.pitch === 22)
    check('a triplet grid puts notes on triplets', drawn?.tick === 320, `tick ${drawn?.tick}`)
    await pick('1/16')
    const quantize = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.roll-tools .dock-toggle')].find((b) => b.textContent.trim() === 'Quantize'),
    )
    await quantize.asElement().click()
    await edited()
    drawn = (await notesOf()).find((n) => n.pitch === 22)
    check('Quantize snaps the selected note to the grid', drawn?.tick === 240, `tick ${drawn?.tick}`)
    const humanize = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.roll-tools .dock-toggle')].find((b) => b.textContent.trim() === 'Humanize'),
    )
    await humanize.asElement().click()
    await edited()
    const after = await notesOf()
    check('Humanize keeps every note', after.length === before + 1)
  }

  // A key: the rows off it are shaded, and with Snap on a note drawn on one
  // lands on the scale.
  {
    await page.select('.roll-tools select[aria-label="Scale"]', 'major')
    await wait(300)
    const snap = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.roll-tools .dock-toggle')].find((b) => b.textContent.trim() === 'Snap to key'),
    )
    await snap.asElement().click()
    await edited()
    check('the key is saved with the song', JSON.stringify((await stored()).song.scale) === '{"root":0,"mode":"major","snap":true}',
      JSON.stringify((await stored()).song.scale))
    // The key is in the notes you hear, and the rows are named from this
    // track's tuning, so the row that sounds a C# is worked out from it.
    const zero = Math.round(await page.$eval('.roll-canvas', (el) => Number(el.dataset.rowZero)))
    const cSharp = 12 + (((1 - zero) % 12) + 12) % 12
    const p = await rollAround(cSharp)
    await page.mouse.click(p.tickX(2900), p.pitchY(cSharp))
    await edited()
    const onKey = (await notesOf()).find((n) => n.tick === 2880)
    check('a note drawn on C# with C major snapped lands on D', onKey?.pitch === cSharp + 1,
      `row ${onKey?.pitch}, C# is row ${cSharp}`)
    await page.select('.roll-tools select[aria-label="Scale"]', '')
    await edited()
    check('and No scale takes the key off the song', (await stored()).song.scale === undefined)
  }

  // A chord: one click lays all of it, rooted on the row clicked, and a drag
  // stretches the whole chord.
  {
    await page.select('.roll-tools select[aria-label="Chord"]', 'min7')
    await wait(200)
    const p = await rollAround(14)
    const y = p.pitchY(14)
    await page.mouse.move(p.tickX(3360 + 20), y)
    await page.mouse.down()
    await page.mouse.move(p.tickX(3840) - 2, y, { steps: 4 })
    await page.mouse.up()
    await edited()
    const chord = (await notesOf()).filter((n) => n.tick === 3360)
    check('a chord click lays every note of the chord', chord.map((n) => n.pitch).sort((a, b) => a - b).join() === '14,17,21,24',
      chord.map((n) => n.pitch).join())
    check('and the drag stretches all of them', chord.length > 0 && chord.every((n) => n.length === chord[0].length && n.length === 480),
      chord.map((n) => n.length).join())

    // Its velocity bars are drawn on top of one another, so they are one bar
    // to the eye -- and dragging it, with nothing selected, moves them all.
    await press('Escape')
    const laneBottom = p.y + 1 + p.h - 3
    const barX = p.tickX(3360) + 2
    await page.mouse.move(barX, laneBottom - 4)
    await page.mouse.down()
    await page.mouse.move(barX, laneBottom - 14, { steps: 4 })
    await page.mouse.up()
    await edited()
    const quieter = (await notesOf()).filter((n) => n.tick === 3360)
    check("dragging a chord's velocity bar moves every note of it",
      quieter.length === 4 && quieter.every((n) => n.velocity === quieter[0].velocity && n.velocity < 0.8),
      quieter.map((n) => n.velocity).join(', '))
    await page.select('.roll-tools select[aria-label="Chord"]', '')
    await wait(200)
  }

  // A key down the side sounds the note, and stops when let go.
  const meter = () =>
    page.evaluate(() => {
      let best = 0
      for (const el of document.querySelectorAll('.strip-meter-fill')) {
        const m = /inset\(([\d.]+)%/.exec(el.style.clipPath || '')
        best = Math.max(best, m ? 1 - Number(m[1]) / 100 : 0)
      }
      return best
    })
  const keys = await rollAround(12)
  await page.mouse.move(keys.x + 10, keys.pitchY(12))
  await page.mouse.down()
  let heard = 0
  for (let i = 0; i < 10; i++) {
    await wait(60)
    heard = Math.max(heard, await meter())
  }
  await page.mouse.up()
  check('holding a key in the gutter plays that note', heard > 0.02, `peak ${(heard * 100).toFixed(1)}%`)

  // Back to the one note the rest of this check expects. A click on the
  // ruler to give the roll the keyboard, since the rows have moved.
  await page.mouse.click(g.tickX(3700), g.top - 8)
  await wait(100)
  await press('KeyA', ['Control'])
  await press('Delete')
  await drawNote(4, 60, 140)
  await edited()
  check('and the roll is back to one note', (await notesOf()).length === 1)
}

console.log('\na second track is a second rack')
{
  // Counted from the document rather than off the page: a unit draws its id
  // on both faces, so the DOM has two of everything.
  const before = (await stored()).racks.bench.patch.modules.length
  await page.click('.track-add')
  await waitUntil(page, () => document.querySelectorAll('.track').length === 2)
  check('a track is added', (await page.$$('.track')).length === 2)
  check('and it is the one selected', await page.$eval('.track.on .track-name', (e) => e.value) !== '')

  // The rack on the bench must be the new track's, not the first one's.
  check('adding a module to it works', await addModule('Noise'))
  await edited()
  const project = await stored()
  const ids = Object.keys(project.racks)
  check('the project holds a rack per track', ids.length === 2, ids.join(', '))

  const counts = ids.map((id) => project.racks[id].patch.modules.length)
  check('the two racks differ', counts[0] !== counts[1], counts.join(' vs '))
  check(
    'and the first one was left alone',
    project.racks.bench.patch.modules.length === before,
    `${project.racks.bench.patch.modules.length} vs ${before}`,
  )

  // Notes drawn now belong to the new track.
  await drawNote(9, 60, 200)
  await edited()
  const notes = await notesOf()
  check('notes go to the selected track', notes.length === 2, `got ${notes.length}`)
  check('the new one names it', notes.some((n) => n.track !== 'bench'), notes.map((n) => n.track).join())

  // And going back puts the first rack in front of you again. Read off the
  // page this time, because the question is what is on the bench.
  await page.click('.track')
  await wait(300)
  // Counted as distinct ids: a unit is drawn on both faces, so every element
  // in a panel appears twice in the DOM.
  const onBench = await page.$eval(
    '.rack',
    (el) => new Set([...el.querySelectorAll('.unit-id')].map((e) => e.textContent)).size,
  )
  check('selecting the first track brings its rack back', onBench === before, `${onBench} vs ${before}`)
}

console.log('\nmute and solo')
{
  await page.click('.track:nth-child(2) .track-flag[title="Mute"]')
  await edited()
  let tracks = (await stored()).song.tracks
  check('mute is written to the track', tracks[1].mute === true, JSON.stringify(tracks[1]))

  await page.click('.track:nth-child(1) .track-flag[title="Solo"]')
  await edited()
  tracks = (await stored()).song.tracks
  check('solo is written too', tracks[0].solo === true)
  check('and it is exclusive', tracks.filter((t) => t.solo).length === 1)

  await page.click('.track:nth-child(1) .track-flag[title="Solo"]')
  await page.click('.track:nth-child(2) .track-flag[title="Mute"]')
  await edited()
  tracks = (await stored()).song.tracks
  check('both clear again', tracks.every((t) => !t.solo && !t.mute))
}

console.log('\npatterns and the playlist')
{
  // From the roll, through the last row of the pattern menu: the playlist,
  // with its own add button, is not on screen here.
  await page.select('.dock-bar select[aria-label="Pattern"]', '__new')
  await edited()
  const project = await stored()
  check('a second pattern is added', project.song.patterns.length === 2, `got ${project.song.patterns.length}`)
  check('and it is empty', project.song.patterns[1].notes.length === 0)

  // The roll follows the new pattern, so the notes from the first are gone
  // from view -- and drawing here writes into the second.
  await drawNote(6, 40, 100)
  await edited()
  check('notes go into the new pattern', (await notesOf(1)).length === 1)
  check('and the first one is untouched', (await notesOf(0)).length === 2)

  // In song: a pattern that is not in the song yet -- this new one -- says so.
  const inSong = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.dock-toggle')].find((b) => b.textContent.trim() === 'In song'),
  )
  await inSong.asElement().click()
  await wait(200)
  const hint = await page.evaluate(() => document.querySelector('.dock-hint')?.textContent ?? '')
  check('In song says when the pattern is not in the song', hint.includes('Not in the song'), hint)
  const pat = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.dock-toggle')].find((b) => b.textContent.trim() === 'Pattern'),
  )
  await pat.asElement().click()
  await wait(200)

  // Copy in one pattern, choose another from the dropdown, and paste: with
  // the pointer over the roll the keys are the roll's, even though the last
  // thing clicked was the dropdown.
  {
    const [lead] = await notesOf(1)
    const g = await rollAround(lead.pitch)
    await page.mouse.click(g.tickX(lead.tick + lead.length / 2), g.pitchY(lead.pitch))
    await wait(100)
    await press('KeyC', ['Control'])
    // Focused first, as a click on it would leave it: `select` alone changes
    // the value without ever taking the keyboard, which is not what a hand does.
    await page.focus('.dock-bar select[aria-label="Pattern"]')
    await page.select('.dock-bar select[aria-label="Pattern"]', 'main')
    await wait(300)
    await page.mouse.move(g.tickX(2900), g.pitchY(lead.pitch))
    await wait(100)
    await press('KeyV', ['Control'])
    const pasted = await notesOf(0)
    check('a note copied in one pattern pastes into another', pasted.length === 3 && pasted.some((n) => n.tick === 2880),
      `${pasted.length} notes: ${pasted.map((n) => n.tick).join(', ')}`)
    await press('KeyZ', ['Control'])
    check('and undoes', (await notesOf(0)).length === 2)
    await page.select('.dock-bar select[aria-label="Pattern"]', 'p1')
    await wait(300)
  }

  const songButton = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.dock-views .dock-toggle')].find(
      (b) => b.textContent.trim() === 'Song',
    ),
  )
  await songButton.asElement().click()
  await wait(300)
  check('the playlist shows', (await page.$('.playlist-layer')) !== null)
  check('with the patterns listed beside it', (await page.$$('.playlist-pattern')).length === 2)
  check('and the one being written chosen to paint with', (await page.$$('.playlist-pattern.on')).length === 1)

  // Paint the chosen pattern -- the second, picked from the dropdown above --
  // into bar three of the second lane. Part way into the bar: a click paints
  // from the start of the snap it falls in.
  const at = await laneAt(2.3, 1)
  await page.mouse.click(at.x, at.y)
  await edited()
  const placed = (await stored()).song.playlist
  const second = (await stored()).song.patterns[1].id
  check('a click places it', placed.length === 2, JSON.stringify(placed))
  check(
    'the second pattern, at the bar and in the lane clicked',
    placed.some((p) => p.pattern === second && p.tick === 960 * 4 * 2 && p.lane === 1),
    JSON.stringify(placed),
  )

  await page.mouse.click(at.x, at.y, { button: 'right' })
  await edited()
  check('and a right-click takes it off', (await stored()).song.playlist.length === 1)
  await page.mouse.click(at.x, at.y)
  await wait(400)
}

console.log('\npicking bars on the ruler')
{
  const BAR = 960 * 4
  const bar = (i) =>
    page.evaluate((n) => {
      const r = document.querySelectorAll('.playlist-ruler .playlist-bar')[n].getBoundingClientRect()
      return { left: r.left, width: r.width, y: r.top + r.height / 2 }
    }, i)
  const song = async () => (await stored()).song
  const before = await song()
  const sectionsBefore = (before.sections ?? []).length
  // From the start of bar 2 to half way through bar 3.
  const b2 = await bar(1)
  const b3 = await bar(2)
  await page.mouse.move(b2.left + 2, b2.y)
  await page.mouse.down()
  await page.mouse.move(b2.left + b2.width / 2, b2.y, { steps: 3 })
  await page.mouse.move(b3.left + b3.width / 2, b3.y, { steps: 3 })
  await page.mouse.up()
  await wait(150)
  const name = await page.evaluate(() => document.querySelector('.playlist-range-name')?.textContent)
  check('dragging along the bar numbers picks whole bars', name === 'Bars 2–3', name)
  check('and is not a click on a bar number', ((await song()).sections ?? []).length === sectionsBefore)
  check('the bars are shown picked down every lane', (await page.$('.playlist-range')) !== null)

  const clickRange = async (label) => {
    await page.evaluate(
      (l) => [...document.querySelectorAll('.playlist-range-tools .dock-toggle')].find((b) => b.textContent.trim() === l)?.click(),
      label,
    )
    await edited()
  }
  const later = before.playlist.find((p) => p.tick >= 2 * BAR)
  await clickRange('Insert')
  const opened = await song()
  check('Insert puts in two empty bars, moving what comes after',
    opened.playlist.some((p) => p.pattern === later.pattern && p.tick === later.tick + 2 * BAR), JSON.stringify(opened.playlist))
  await press('KeyZ', ['Control'])
  check('and undoes', JSON.stringify((await song()).playlist) === JSON.stringify(before.playlist))

  await clickRange('Duplicate')
  check('Duplicate plays the bars twice', (await song()).playlist.length === before.playlist.length + 1, JSON.stringify((await song()).playlist))
  check('and picks the copy', (await page.evaluate(() => document.querySelector('.playlist-range-name')?.textContent)) === 'Bars 4–5')
  await press('KeyZ', ['Control'])

  // Back on the first pick, from the keyboard this time. Measured again, in
  // case the range's buttons moved anything.
  const top = (await bar(1)).y
  check('picking bars does not move the lanes', Math.abs(top - b2.y) < 1, `${b2.y} -> ${top}`)
  await page.mouse.move(b2.left + 2, top)
  await page.mouse.down()
  await page.mouse.move(b3.left + b3.width / 2, top, { steps: 4 })
  await page.mouse.up()
  await wait(100)
  await press('Delete', ['Control'])
  const cut = await song()
  check('Ctrl+Delete takes the bars out of the song', cut.playlist.length === before.playlist.length - 1, JSON.stringify(cut.playlist))
  check('and lets go of them', (await page.$('.playlist-range')) === null)
  await press('KeyZ', ['Control'])
  check('which undoes like anything else', JSON.stringify((await song()).playlist) === JSON.stringify(before.playlist))

  // A click on a bar number is still a click.
  const b5 = await bar(4)
  await page.mouse.click(b5.left + 3, b5.y)
  await edited()
  check('a plain click on a bar number still starts a section', ((await song()).sections ?? []).length === sectionsBefore + 1)
  await press('KeyZ', ['Control'])
}

console.log('\nthe transport plays what is showing')
{
  const meterFill = () =>
    page.evaluate(() => {
      const bars = [...document.querySelectorAll('.strip-meter-fill')]
      let best = 0
      for (const el of bars) {
        const m = /inset\(([\d.]+)%/.exec(el.style.clipPath || '')
        best = Math.max(best, m ? 1 - Number(m[1]) / 100 : 0)
      }
      return best
    })

  check('there are meters to read', (await page.$('.strip-meter-fill')) !== null)
  check('silent before play', (await meterFill()) < 0.02, `got ${await meterFill()}`)

  // Still in Song view: this plays the arrangement, not one pattern.
  await page.click('.dock-play')
  await waitUntil(page, () => !!document.querySelector('.dock-play.on'))
  check('the button lights', (await page.$('.dock-play.on')) !== null)

  let loudest = 0
  for (let i = 0; i < 30; i++) {
    await wait(100)
    loudest = Math.max(loudest, await meterFill())
  }
  check('the arrangement makes a noise', loudest > 0.05, `peak ${(loudest * 100).toFixed(1)}%`)

  await page.click('.dock-play')
  await waitUntil(page, () => !document.querySelector('.dock-play.on'))
  check('stopping puts it out', (await page.$('.dock-play.on')) === null)
  // Until every bar has fallen to the floor, which a full-scale one takes
  // over a second to do. Below the check's own line, so a reading a frame
  // later cannot land on it.
  await waitUntil(
    page,
    () =>
      [...document.querySelectorAll('.strip-meter-fill')].every((el) => {
        const m = /inset\(([\d.]+)%/.exec(el.style.clipPath || '')
        return (m ? 1 - Number(m[1]) / 100 : 0) < 0.01
      }),
    { timeout: 5000 },
  )
  check('and nothing is left droning', (await meterFill()) < 0.02, `got ${await meterFill()}`)
}

console.log('\nbouncing it to a file')
{
  /** Set up the bounce sheet and press Bounce. */
  const bounceAs = async (format, rate, depthOrQuality) => {
    await waitUntil(page, () => !!document.querySelector('.bounce-sheet'))
    await page.select('.bounce-sheet select[aria-label="Format"]', format)
    await page.select('.bounce-sheet select[aria-label="Sample rate"]', String(rate))
    if (depthOrQuality !== undefined) {
      const which = format === 'ogg' || format === 'mp3' ? 'Quality' : 'Bit depth'
      await page.select(`.bounce-sheet select[aria-label="${which}"]`, String(depthOrQuality))
    }
    await page.evaluate(() =>
      [...document.querySelectorAll('.bounce-sheet .dock-toggle')].find((b) => b.textContent.trim() === 'Bounce').click(),
    )
  }
  check('the Bounce action is there', await pickMenu('Project', 'Bounce song...'))
  check('and asks how to write it', await waitUntil(page, () => !!document.querySelector('.bounce-sheet')))
  await bounceAs('wav', 48000, 24)
  const wav = await waitForDownload('.wav')
  check('a wav was written', !!wav, wav ? wav.split(/[\\/]/).pop() : 'nothing downloaded')

  if (wav) {
    const info = readWav(wav)
    check('it is a readable wav', !!info)
    if (info) {
      check('stereo', info.channels === 2, `${info.channels} channels`)
      check('at the rate asked for', info.rate === 48000, `${info.rate} Hz`)
      check('24-bit', info.bits === 24, `${info.bits} bits`)
      // Two patterns, one in bar one and one in bar three: three bars at
      // 120bpm is six seconds, and the file is never shorter than the
      // arrangement whatever is or is not sounding in it.
      check('as long as the arrangement', info.seconds >= 5.9, `${info.seconds.toFixed(2)}s`)
      check('and not wildly longer', info.seconds < 12, `${info.seconds.toFixed(2)}s`)
    }
    // Silence would be a file of the right length and no use at all.
    const bytes = readFileSync(wav)
    let loudest = 0
    for (let i = 44; i + 2 < bytes.length; i += 3) {
      const v = (bytes[i + 2] << 8) | bytes[i + 1]
      loudest = Math.max(loudest, Math.abs((v << 16) >> 16))
    }
    check('and it is not silence', loudest > 200, `peak ${loudest}`)
  }

  /** A downloaded file, decoded by the browser's own decoders at its own rate. */
  const decode = (path, rate, against) =>
    page.evaluate(
      async (b64, rate, ref) => {
        const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer
        const ctx = new OfflineAudioContext(2, 1, rate)
        const a = await ctx.decodeAudioData(bytes(b64))
        let peak = 0
        for (let c = 0; c < a.numberOfChannels; c++) for (const v of a.getChannelData(c)) peak = Math.max(peak, Math.abs(v))
        let diff = null
        if (ref) {
          const b = await ctx.decodeAudioData(bytes(ref))
          diff = a.length === b.length ? 0 : Infinity
          for (let c = 0; c < 2 && diff !== Infinity; c++) {
            const x = a.getChannelData(c)
            const y = b.getChannelData(c)
            for (let i = 0; i < x.length; i++) diff = Math.max(diff, Math.abs(x[i] - y[i]))
          }
        }
        return { channels: a.numberOfChannels, seconds: a.duration, rate: a.sampleRate, peak, diff }
      },
      readFileSync(path).toString('base64'),
      rate,
      against ? readFileSync(against).toString('base64') : null,
    )

  if (wav) {
    const wavSeconds = readWav(wav)?.seconds ?? 0
    check('FLAC is offered as well', await pickMenu('Project', 'Bounce song...'))
    await bounceAs('flac', 48000, 24)
    const flac = await waitForDownload('.flac')
    check('a flac was written', !!flac)
    if (flac) {
      const d = await decode(flac, 48000, wav)
      check('which the browser decodes', d.channels === 2 && Math.abs(d.seconds - wavSeconds) < 0.01, JSON.stringify(d))
      check('to exactly the samples in the wav', d.diff === 0, `largest difference ${d.diff}`)
      check('in a smaller file', statSync(flac).size < statSync(wav).size, `${statSync(flac).size} against ${statSync(wav).size}`)
    }

    check('OGG Vorbis too', await pickMenu('Project', 'Bounce song...'))
    await bounceAs('ogg', 44100, 5)
    const ogg = await waitForDownload('.ogg')
    check('an ogg was written', !!ogg)
    if (ogg) {
      const d = await decode(ogg, 44100)
      check('which the browser decodes, at the rate asked for', d.channels === 2 && Math.abs(d.seconds - wavSeconds) < 0.05, JSON.stringify(d))
      check('with the music in it', d.peak > 0.01, `peak ${d.peak}`)
      check('much smaller than the wav', statSync(ogg).size < statSync(wav).size / 5, `${statSync(ogg).size} bytes`)
    }

    check('and MP3', await pickMenu('Project', 'Bounce song...'))
    await waitUntil(page, () => !!document.querySelector('.bounce-sheet'))
    await page.select('.bounce-sheet select[aria-label="Format"]', 'mp3')
    const offRates = await page.$$eval('.bounce-sheet select[aria-label="Sample rate"] option:disabled', (o) => o.map((x) => x.value))
    check('an MP3 offers only the rates it can be written at', offRates.join() === '88200,96000', offRates.join())
    await bounceAs('mp3', 48000, 8)
    const mp3 = await waitForDownload('.mp3')
    check('an mp3 was written', !!mp3)
    if (mp3) {
      const d = await decode(mp3, 48000)
      // An MP3 carries encoder delay and padding, so it comes back a touch long.
      check('which the browser decodes', d.channels === 2 && d.seconds >= wavSeconds - 0.01 && d.seconds < wavSeconds + 0.2, JSON.stringify(d))
      check('with the music in it', d.peak > 0.01, `peak ${d.peak}`)
    }

    check('the arrangement exports as MIDI', await pickMenu('Project', 'Export MIDI...'))
    const mid = await waitForDownload('.mid')
    check('a midi file was written', !!mid)
    if (mid) {
      const b = readFileSync(mid)
      check('a type 1 Standard MIDI File', b.toString('latin1', 0, 4) === 'MThd' && b.readUInt16BE(8) === 1, b.toString('latin1', 0, 4))
      check('with a track for each track that plays, after the tempo track', b.readUInt16BE(10) === 3, String(b.readUInt16BE(10)))
    }
  }

  check('stems can be bounced too', await pickNested('Project', 'Bounce stems', 'Channel only (EQ, pan, fader)...'))
  check('through the same sheet', await waitUntil(page, () => !!document.querySelector('.bounce-sheet')))
  await bounceAs('wav', 48000, 24)
  const zip = await waitForDownload('.zip')
  check('a zip of stems was written', !!zip, zip ? zip.split(/[\\/]/).pop() : 'nothing downloaded')
  if (zip) {
    const bytes = readFileSync(zip)
    // Two tracks, so two entries, each a wav of its own.
    const entries = bytes.toString('latin1').split('PK\u0003\u0004').length - 1
    check('with one file per track', entries === 2, `${entries} entries`)
    check(
      'and both have audio in them',
      statSync(zip).size > 200000,
      `${Math.round(statSync(zip).size / 1024)} kB`,
    )
  }
}

console.log('\nit all comes back')
{
  await page.reload({ waitUntil: 'networkidle0' })
  await waitUntil(page, () => !!document.querySelector('.roll-canvas, .playlist'))
  const project = await stored()
  check('the tracks survive a reload', project.song.tracks.length === 2)
  check('the patterns survive', project.song.patterns.length === 2)
  check('the playlist survives', project.song.playlist.length === 2)
  check('and every rack with them', Object.keys(project.racks).length === 2)
  check('the dock reopens as it was', (await page.$('.roll-canvas')) !== null || (await page.$('.playlist')) !== null)
}

console.log('\nswing, drawn where it is heard')
{
  // One swung bar with one note on its second sixteenth, and a second
  // pattern placed over the same bar with a note of its own.
  const P = 12
  await page.evaluate((P) => {
    const project = JSON.parse(localStorage.getItem('fresyn.project.v1'))
    const song = project.song
    const track = song.tracks[0].id
    const [a, b] = song.patterns
    a.length = 3840
    a.notes = [{ track, tick: 240, length: 240, pitch: P, velocity: 1 }]
    a.swing = { amount: 0.75, step: 240 }
    b.length = 3840
    b.notes = [{ track, tick: 1440, length: 240, pitch: P + 3, velocity: 1 }]
    song.playlist = [{ pattern: a.id, tick: 0 }, { pattern: b.id, tick: 0 }]
    localStorage.setItem('fresyn.project.v1', JSON.stringify(project))
  }, P)
  await page.reload({ waitUntil: 'networkidle0' })
  await waitUntil(page, () => !!document.querySelector('.dock-toggle'))
  const roll = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.dock-toggle')].find((b) => b.textContent.trim() === 'Roll'),
  )
  await roll.asElement()?.click()
  await waitUntil(page, () => !!document.querySelector('.roll-canvas'))
  await frames(page)
  const g = await rollAround(P)
  // The right button erases whatever is under it, and nothing where there
  // is nothing -- which is the question being asked.
  const erase = async (tick) => {
    await page.mouse.click(g.tickX(tick), g.pitchY(P), { button: 'right' })
    await edited()
  }

  // Swung hard, the note written at 240 plays from 360 to 480. Where it
  // would sit on a straight grid is empty; where it plays is the note.
  await erase(300)
  check('swung, the grid where the note was written is empty', (await notesOf()).length === 1)
  await erase(420)
  check('and the note is where it is heard', (await notesOf()).length === 0)
  await press('KeyZ', ['Control'])

  // A click in the swung second cell still lands on the written grid.
  await drawNote(0, g.tickX(400) - g.x, g.tickX(470) - g.x)
  await edited()
  const drawn = (await notesOf()).find((n) => n.pitch !== P)
  check('a note drawn in a swung cell is written on the grid', drawn?.tick === 240, JSON.stringify(drawn))

  // The other pattern's note is drawn behind this one, and none of that
  // edit is allowed to copy it in.
  check(
    'and the pattern behind it was not copied into this one',
    !(await notesOf()).some((n) => n.pitch === P + 3),
    JSON.stringify((await notesOf()).map((n) => n.pitch)),
  )
  check('while it keeps its own note', (await notesOf(1)).some((n) => n.pitch === P + 3))

  // Off, the roll is the written grid again.
  check('the View menu can show the written grid', await pickMenu('View', 'Show swing in the roll'))
  await frames(page)
  const before = (await notesOf()).length
  await erase(300)
  check('and then the note is where it was written', (await notesOf()).length === before - 1)
  await pickMenu('View', 'Show swing in the roll')
}

console.log('\nthe rows are named by the notes they play')
{
  const text = (sel) => page.$eval(sel, (el) => el.textContent.trim())
  // Clicked in the page rather than by the mouse: the dock sits over the
  // bottom of the rack, and the Keyboard may be under it.
  const tap = (sel) => page.$eval(sel, (el) => el.click())
  const octaveOf = (s) => Number(/[A-G]#?(-?\d+)/.exec(s)?.[1])
  const osc = await text('[data-module="osc1"] .osc-wave-note')
  const line = await text('.roll-tools-tuning')
  check('the roll names its bottom key by the note the oscillator is tuned to', line.startsWith(`Bottom key ${osc} · osc1`),
    `"${line}" against the oscillator's ${osc}`)
  const panel = await text('[data-module="key1"] .keys-key-name')
  check('and the Keyboard panel names its bottom key the same', osc.startsWith(panel), `${panel} against ${osc}`)

  await tap('[data-module="key1"] button[aria-label="Octave up"]')
  await wait(200)
  const raised = await text('.roll-tools-tuning')
  check("the Keyboard's Octave moves the roll's names an octave", octaveOf(raised) === octaveOf(line) + 1, `${line} -> ${raised}`)
  const raisedPanel = await text('[data-module="key1"] .keys-key-name')
  check('and the panel with it', octaveOf(raisedPanel) === octaveOf(panel) + 1, `${panel} -> ${raisedPanel}`)
  await tap('[data-module="key1"] button[aria-label="Octave down"]')
  await wait(200)
  check('and back', (await text('.roll-tools-tuning')) === line)
}

console.log('\nthe Tools menu')
{
  const tools = '.roll-tools select[aria-label="Tools"]'
  const before = await notesOf()
  await page.select(tools, 'flam')
  await edited()
  const after = await notesOf()
  const room = before.filter((n) => n.tick >= 48).length
  check('Flam from the Tools menu puts a grace note before every note with room for one',
    room > 0 && after.length === before.length + room, `${before.length} notes -> ${after.length}`)
  check('and the menu goes back to its label, ready for the next', (await page.$eval(tools, (el) => el.value)) === '')
  await press('KeyZ', ['Control'])
  check('one Ctrl+Z takes it back', (await notesOf()).length === before.length)
}

console.log('\nrecording notes played in')
{
  // The Keyboard panel is the one input a headless browser has: a key goes
  // down, is held, and comes up over the board, as a finger would.
  const hold = async (n, ms) => {
    await page.evaluate((i) => {
      const key = document.querySelectorAll('[data-module="key1"] .keys-key')[i]
      key.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, buttons: 1 }))
    }, n)
    await wait(ms)
    await page.evaluate(() =>
      document.querySelector('[data-module="key1"] .keys-board').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })),
    )
  }
  // Keys are listed naturals first, then sharps: 0 is C, 2 is E, 4 is G.
  const before = await notesOf()
  await page.click('.roll-rec')
  await waitUntil(page, () => !!document.querySelector('.dock-play.on'))
  check('Rec starts the loop playing', (await page.$('.dock-play.on')) !== null)
  check('and lights while it records', (await page.$('.roll-rec.on')) !== null)
  await wait(300)
  await hold(2, 250)
  await wait(150)
  await hold(4, 400)
  await wait(100)
  await page.click('.roll-rec')
  check('pressing it again stops recording', (await page.$('.roll-rec.on')) === null)
  check('and leaves the loop playing', (await page.$('.dock-play.on')) !== null)
  await page.click('.dock-play')
  await edited()
  const after = await notesOf()
  const taken = after.slice(before.length)
  check('what was played is written into the pattern', taken.length === 2 && taken[0].pitch === 4 && taken[1].pitch === 7,
    JSON.stringify(taken))
  check('each as long as it was held, near enough', taken.length === 2 && taken[1].length > taken[0].length,
    taken.map((n) => n.length).join(', '))

  // Quantize while recording, from the Quantize menu.
  await page.click('.roll-split-more')
  await waitUntil(page, () => !!document.querySelector('.context-menu'))
  const items = await page.evaluate(() => [...document.querySelectorAll('.context-menu .menu-text')].map((e) => e.textContent.trim()))
  check('the Quantize menu offers starts, ends, both and lengths',
    ['Quantize starts', 'Quantize ends', 'Quantize starts and ends', 'Quantize lengths'].every((x) => items.includes(x)), items.join(' | '))
  check('and a strength', items.some((x) => x.startsWith('Strength')))
  await page.evaluate(() =>
    [...document.querySelectorAll('.context-menu .menu-item')].find((e) => e.textContent.includes('Quantize while recording'))?.click(),
  )
  await wait(150)
  await page.click('.roll-rec')
  await waitUntil(page, () => !!document.querySelector('.dock-play.on'))
  await wait(370)
  await hold(0, 180)
  await wait(80)
  await page.click('.dock-play')
  await edited()
  const snapped = (await notesOf()).slice(after.length)
  check('stopping the loop ends the take', (await page.$('.roll-rec.on')) === null)
  check('a note played in with quantize on lands on the grid', snapped.length === 1 && snapped[0].tick % 240 === 0,
    JSON.stringify(snapped))
  // Put the menu back as it was.
  await page.click('.roll-split-more')
  await waitUntil(page, () => !!document.querySelector('.context-menu'))
  await page.evaluate(() =>
    [...document.querySelectorAll('.context-menu .menu-item')].find((e) => e.textContent.includes('Quantize while recording'))?.click(),
  )
}

console.log('\nthe rack survives it')
{
  check('no page errors', problems.length === 0, problems.slice(0, 3).join(' | '))
}

await finish({ cleanup: () => rmSync(downloads, { recursive: true, force: true }) })
