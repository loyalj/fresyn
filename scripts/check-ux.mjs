import { check, finish, flushAutosave, open, settle, waitUntil } from './harness.mjs'

/**
 * End-to-end check for the usability batch: the dock's share of the window,
 * the transport's position counter and Stop, the roll's folded toolbar, a
 * loop drawn on the playlist's ruler, a clip's menu and mute, the command
 * palette, hearing a library sound before loading it, listening at a jack,
 * and fading the cables.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1000 } })
// What the page tells the audio thread, for the audition and the jack.
await page.evaluateOnNewDocument(() => {
  window.__sent = []
  const Real = window.AudioWorkletNode
  window.AudioWorkletNode = class extends Real {
    constructor(...a) {
      super(...a)
      const post = this.port.postMessage.bind(this.port)
      this.port.postMessage = (msg, ...rest) => {
        if (msg && ['track', 'removeTrack', 'listen'].includes(msg.type)) window.__sent.push({ type: msg.type, id: msg.id, track: msg.track, slot: msg.slot })
        return post(msg, ...rest)
      }
    }
  }
})
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const song = async () => {
  await flushAutosave(page)
  return page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}').song)
}
const sent = () => page.evaluate(() => window.__sent)
const button = (text) => page.evaluate((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t)?.click(), text)
const menu = async (label, ...path) => {
  await (await page.evaluateHandle((t) => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === t), label)).asElement().click()
  await settle(150)
  for (const item of path) {
    const el = (await page.evaluateHandle((t) => [...document.querySelectorAll('.menu-item .menu-text')].find((e) => e.textContent.trim() === t) ?? null, item)).asElement()
    if (!el) return false
    // A submenu opens as the pointer comes onto it; a press would close it again.
    if (await el.evaluate((e) => !!e.closest('[aria-haspopup="menu"]'))) await el.hover()
    else await el.click()
    await settle(150)
  }
  return true
}
const counter = () => page.$eval('.dock-position-bars', (e) => e.textContent)

console.log('\nthe dock and the transport')
{
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyM')
  await page.keyboard.up('Control')
  await settle(300)
  const h = await page.$eval('.dock-body', (e) => e.getBoundingClientRect().height)
  check('the dock opens at about four tenths of the window', Math.abs(h - 400) < 12, `${h}px of 1000`)
  check('a position counter sits by Play, at the top', (await counter()) === '1.1.1' && /0:00\.0/.test(await page.$eval('.dock-position-time', (e) => e.textContent)))

  await page.click('.dock-position')
  await page.keyboard.type('1.3')
  await page.keyboard.press('Enter')
  await settle(100)
  check('a position typed in is where Play will start', (await counter()) === '1.3.1')
  await page.click('.dock-play')
  await waitUntil(page, () => !!document.querySelector('.dock-play.on'), { timeout: 3000 }).catch(() => {})
  await settle(300)
  const playing = await counter()
  check('and Play starts there', /^1\.[34]\./.test(playing), playing)
  await page.click('.dock-stop')
  await settle(200)
  check('Stop stops', !(await page.$('.dock-play.on')))
  await page.click('.dock-stop')
  await settle(100)
  check('and Stop again goes back to the start', (await counter()) === '1.1.1')
}

console.log('\nthe roll\'s toolbar')
{
  const rows = await page.$eval('.roll-tools', (e) => e.getBoundingClientRect().height)
  check('fits on one row', rows < 40, `${rows}px`)
  check('the key and chord are folded away', await page.$eval('.roll-write-panel', (e) => e.hidden))
  await page.click('.roll-write-open')
  await settle(100)
  check('Write opens them', !(await page.$eval('.roll-write-panel', (e) => e.hidden)) && !!(await page.$('.roll-write-panel select[aria-label="Chord"]')))
  await page.mouse.click(700, 100)
  await settle(100)
  check('a press elsewhere folds them again', await page.$eval('.roll-write-panel', (e) => e.hidden))
  check('Humanize is on Tools', await page.$eval('.roll-tools select[aria-label="Tools"]', (s) => [...s.options].some((o) => o.value === 'humanize')))
  await page.click('.roll-help-open')
  await settle(100)
  check('and the roll\'s hints are behind ?', /Alt\+drag paints/.test(await page.$eval('.roll-help-panel', (e) => (e.hidden ? '' : e.textContent))))
  await page.click('.roll-help-open')
}

console.log('\na loop on the ruler, and a clip\'s menu')
{
  await button('Song')
  await settle(300)
  const bars = await page.$$('.playlist-ruler .playlist-bar')
  const a = await bars[1].boundingBox()
  const b = await bars[2].boundingBox()
  await page.mouse.move(a.x + 4, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2, { steps: 8 })
  await page.mouse.up()
  await settle(150)
  await page.click('.playlist-loop-set')
  await settle(200)
  const looped = (await song()).loop
  check('picked bars can be looped', looped?.from === 3840 && looped?.to === 3 * 3840, JSON.stringify(looped))
  check('and the loop is drawn on the ruler', !!(await page.$('.playlist-loop')))
  await page.click('.playlist-loop-clear')
  await settle(200)
  check('and cleared from it', !(await song()).loop && !(await page.$('.playlist-loop')))

  const clip = await (await page.$('.playlist-clip')).boundingBox()
  await page.mouse.move(clip.x + 10, clip.y + 5)
  await page.click('.playlist-clip-menu')
  await settle(150)
  check('a clip\'s ▾ opens its menu', await page.evaluate(() => [...document.querySelectorAll('.menu-item')].some((e) => e.textContent.includes('Mute clip'))))
  await page.evaluate(() => [...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('Mute clip'))?.click())
  await settle(300)
  check('Mute clip mutes that clip', (await song()).playlist[0].mute === true && !!(await page.$('.playlist-clip.muted')))
  check('and the clip is still there', (await song()).playlist.length === 1)
  await button('Roll')
}

console.log('\nthe command palette')
{
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyK')
  await page.keyboard.up('Control')
  await settle(200)
  check('Ctrl+K is a command palette', /command, track, pattern or module/.test(await page.$eval('.search-input', (e) => e.placeholder)))
  await page.keyboard.type('compact rack')
  await settle(100)
  const first = await page.$eval('.search-row.at .search-name', (e) => e.textContent)
  check('a menu command is found by its words', /Compact rack/.test(first), first)
  await page.keyboard.press('Enter')
  await settle(300)
  check('and Enter runs it', !!(await page.$('.rack.compact')) && !(await page.$('.search')))
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyK')
  await page.keyboard.up('Control')
  await settle(200)
  await page.keyboard.type('ladder')
  await settle(100)
  check('modules are still in it', /Ladder Filter/.test(await page.$eval('.search-row.at .search-name', (e) => e.textContent)))
  await page.keyboard.press('Escape')
  await menu('View', 'Compact rack')
}

console.log('\nhearing a sound before loading it')
{
  await menu('Patch', 'Library...')
  await waitUntil(page, () => !!document.querySelector('.library-listen'), { timeout: 5000 }).catch(() => {})
  await page.evaluate(() => { window.__sent = [] })
  const before = JSON.stringify((await song()).tracks)
  await page.click('.library-listen')
  await settle(400)
  check('▶ plays it on a track of its own', (await sent()).some((m) => m.type === 'track' && m.id === '__audition'))
  check('and leaves the song alone', JSON.stringify((await song()).tracks) === before)
  await waitUntil(page, () => window.__sent.some((m) => m.type === 'removeTrack' && m.id === '__audition'), { timeout: 6000 }).catch(() => {})
  check('which is taken away once it has played', (await sent()).some((m) => m.type === 'removeTrack' && m.id === '__audition'))
  await page.keyboard.press('Escape')
  await settle(200)
}

console.log('\nlistening at a jack, and fading the cables')
{
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.keyboard.press('KeyF')
  await settle(900)
  await page.evaluate(() => { window.__sent = [] })
  const jack = await page.$('.unit-face-back .jack[data-module="osc1"][data-port="out"]')
  await page.evaluate((el) => el.scrollIntoView({ block: 'center' }), jack)
  await settle(200)
  const j = await jack.boundingBox()
  await page.keyboard.down('Alt')
  await page.mouse.move(j.x + j.width / 2, j.y + j.height / 2)
  await page.mouse.down()
  await settle(300)
  check('Alt and a press on a jack listens there', (await sent()).some((m) => m.type === 'listen' && m.slot > 0))
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await settle(200)
  check('and letting go hears the rack again', (await sent()).some((m) => m.type === 'listen' && m.slot === -1))
  check('no cable came with it', (await page.$$('.cables g.cable-dragging')).length === 0)
  check('labels are cut out of the cables', (await page.$$('.cables mask rect')).length > 1)

  await menu('View', 'Cables', 'Faded')
  check('View, Cables, Faded fades them', (await page.$eval('svg.cables', (e) => e.style.opacity)) === '0.5')
  await menu('View', 'Cables', 'Solid')
  await page.keyboard.press('KeyF')
}

await finish()
