import { check, finish, flushAutosave, open, settle as wait } from './harness.mjs'

/**
 * End-to-end check for notes stuck on the rack: added from a unit's
 * right-click menu, written in, undone and redone, dragged to another unit,
 * coloured and folded, kept across a reload, hidden from the View menu, put
 * on the back, and taken away and brought back with their module -- all
 * without the audio thread being asked to rebuild anything.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1300, height: 1100 } })
// Counts the rebuilds the page asks of the audio thread.
await page.evaluateOnNewDocument(() => {
  window.__rebuilds = 0
  window.__nodes = 0
  const Real = window.AudioWorkletNode
  window.AudioWorkletNode = class extends Real {
    constructor(...a) {
      super(...a)
      window.__nodes++
      const post = this.port.postMessage.bind(this.port)
      this.port.postMessage = (msg, ...rest) => {
        if (msg?.type === 'track') window.__rebuilds++
        return post(msg, ...rest)
      }
    }
  }
})
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const stored = async () => {
  await flushAutosave(page)
  return page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}')
    const rack = doc.racks?.[Object.keys(doc.racks ?? {})[0]]
    return rack?.patch?.notes ?? []
  })
}
const units = await page.$$eval('.unit-flip', (els) => els.map((e) => e.dataset.module))
const [A, B] = units
const unit = (id) => page.$(`.unit-flip[data-module="${id}"]`)
const flipped = () => page.evaluate(() => !!document.querySelector('.unit-flip.flipped'))

async function addNoteOn(id, dx = 40, dy = 50) {
  const box = await (await unit(id)).boundingBox()
  await page.mouse.click(box.x + dx, box.y + dy, { button: 'right' })
  await wait(120)
  const item = (
    await page.evaluateHandle(() => [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.includes('Add note here')) ?? null)
  ).asElement()
  if (!item) return false
  await item.click()
  await wait(150)
  return true
}
const key = async (combo) => {
  const parts = combo.split('+')
  const k = parts.pop()
  for (const m of parts) await page.keyboard.down(m)
  await page.keyboard.press(k)
  for (const m of parts.reverse()) await page.keyboard.up(m)
  await wait(150)
}
/** Somewhere to put the focus that is not the note: the page's own heading. */
const away = async () => {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await wait(80)
}

/** The audio running, so a rebuild would have somewhere to go: a key on the Keyboard played. */
async function startAudio() {
  const k = await page.$('.keys-key')
  if (!k) return
  const b = await k.boundingBox()
  await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.8)
  await wait(600)
}
await startAudio()
const rebuildsAtStart = await page.evaluate(() => window.__rebuilds)
check('the audio is running, so a rebuild would be seen', (await page.evaluate(() => window.__nodes)) === 1)

console.log('\nadding and writing')
{
  check('a right-click on a unit offers a note', await addNoteOn(A))
  check('and the new note has the focus', await page.evaluate(() => document.activeElement?.classList.contains('rack-note-text')))
  const flippedBefore = await flipped()
  await page.keyboard.type('Keep the filter off, it fights the formant')
  await wait(150)
  check('typing in it never reaches the rack', (await flipped()) === flippedBefore)
  await away()
  const notes = await stored()
  check('it is saved, on its module, with its text', notes.length === 1 && notes[0].module === A && notes[0].face === 'front' && notes[0].text === 'Keep the filter off, it fights the formant', JSON.stringify(notes))
  check('and writing in it rebuilt nothing on the audio thread', (await page.evaluate(() => window.__rebuilds)) === rebuildsAtStart, `${await page.evaluate(() => window.__rebuilds)} vs ${rebuildsAtStart}`)

  await key('Control+z')
  check('one undo takes back the whole burst of typing', (await stored())[0]?.text === '', JSON.stringify(await stored()))
  await key('Control+z')
  check('and one more takes the note away', (await stored()).length === 0)
  await key('Control+Shift+Z')
  await key('Control+Shift+Z')
  check('redo brings it back, written in', (await stored())[0]?.text.startsWith('Keep the filter'))
}

console.log('\nmoving, colouring, folding')
{
  const grip = await page.$('.rack-note-grip')
  if (!grip) await finish({ ok: false })
  const g = await grip.boundingBox()
  const target = await (await unit(B)).boundingBox()
  await page.mouse.move(g.x + 60, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + 120, target.y + 40, { steps: 8 })
  await page.mouse.up()
  await wait(150)
  let notes = await stored()
  check('dragged onto another unit, it belongs to that unit', notes[0]?.module === B, JSON.stringify(notes))
  check('and goes where it was let go', Math.abs(notes[0].x - (120 - 60)) <= 6, JSON.stringify(notes[0]))
  await key('Control+z')
  check('the move is one step of undo', (await stored())[0]?.module === A)
  await key('Control+Shift+Z')

  await (await page.$('.rack-note-color')).click()
  await wait(100)
  check('the colour button moves it on to the next colour', (await stored())[0]?.color === 'green')
  await (await page.$('.rack-note-fold')).click()
  await wait(100)
  notes = await stored()
  check('folded, it is its first line', notes[0]?.collapsed === true && (await page.$eval('.rack-note-title', (e) => e.textContent)).startsWith('Keep the filter'))
  await (await page.$('.rack-note-fold')).click()
  await wait(100)
  check('and opens again', !(await stored())[0]?.collapsed && !!(await page.$('.rack-note-text')))
}

console.log('\nkept, and hidden')
{
  await page.reload({ waitUntil: 'networkidle0' })
  await wait(300)
  await startAudio()
  check('the audio is running again after the reload', (await page.evaluate(() => window.__nodes)) === 1)
  const text = await page.$eval(`.unit-flip[data-module="${B}"] .rack-note-text`, (e) => e.value).catch(() => '')
  check('a reload finds it on its unit, as it was', text.startsWith('Keep the filter'))

  const view = (await page.evaluateHandle(() => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'View'))).asElement()
  await view.click()
  await wait(100)
  const show = (await page.evaluateHandle(() => [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.includes('Show notes')))).asElement()
  await show.click()
  await wait(100)
  check('View, Show notes hides them', (await page.$$('.rack-note')).length === 0)
  check('without taking them away', (await stored()).length === 1)
  check('and adding one shows them again', (await addNoteOn(A)) && (await page.$$('.rack-note')).length === 2)
  await away()
  await key('Control+z')
}

console.log('\non the back')
{
  await key('f')
  check('the rack turns round', await flipped())
  await wait(500)
  check('a note can be put on the back', await addNoteOn(A, 60, 30))
  await page.keyboard.type('Sync from the clock')
  await away()
  const back = (await stored()).find((n) => n.face === 'back')
  check('where it is saved as a note on the back', back?.module === A && back.text === 'Sync from the clock', JSON.stringify(await stored()))
  await key('f')
  await wait(500)
  const hidden = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.rack-note')].find((n) => n.closest('.unit-face-back'))
    return el ? getComputedStyle(el).visibility : 'gone'
  })
  check('and is out of sight from the front', hidden === 'hidden', hidden)
}

console.log('\nwith their module')
{
  await key('f')
  await wait(500)
  await page.evaluate((id) => document.querySelector(`.unit-flip[data-module="${id}"] .unit-remove`)?.click(), B)
  await wait(200)
  check('removing a module takes its notes', !(await stored()).some((n) => n.module === B), JSON.stringify(await stored()))
  await key('Control+z')
  check('and undo brings both back', (await stored()).some((n) => n.module === B))
  await key('f')
  await wait(400)
}

// Since the reload: two rebuilds, for the module taken out and put back, and
// none for any of the notes added, written in, hidden, turned round with.
check('only the module coming and going rebuilt the audio, no note did', (await page.evaluate(() => window.__rebuilds)) === 2, `${await page.evaluate(() => window.__rebuilds)} rebuilds`)

await finish()
