import { check, finish, flushAutosave, frames, open, settle as wait, waitUntil } from './harness.mjs'

/**
 * End-to-end check for the song's tempo and time signature as they change
 * along it: the Song view's Tempo and Time lanes, the ruler and grid they
 * redraw, and the dock fields that say there are changes.
 *
 * Every step goes through the real app, and what it did is read back out of
 * the autosave, which is the document itself.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks. Set SHOT to
 * a file path to keep a picture of the playlist at the end.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1000 } })

const BAR = 960 * 4
const PPQ = 960

/** An edit has landed: React has committed it and scheduled the autosave. */
const edited = () => frames(page)

const stored = async () => {
  await flushAutosave(page)
  return page.evaluate(() => {
    const raw = localStorage.getItem('fresyn.project.v1')
    return raw ? JSON.parse(raw) : null
  })
}
const song = async () => (await stored()).song

/** Where bar `n` (from 0) starts on the ruler, and how wide it is. */
const bar = (n) =>
  page.evaluate((i) => {
    const r = document.querySelectorAll('.playlist-ruler .playlist-bar')[i].getBoundingClientRect()
    return { left: r.left, width: r.width }
  }, n)

/** The middle of a timing lane, 0 for tempo and 1 for time, at an x. */
const lane = (which, x) =>
  page.evaluate(
    (w, px) => {
      const r = document.querySelectorAll('.timing-layer')[w].getBoundingClientRect()
      return { x: px, y: r.top + r.height / 2 }
    },
    which,
    x,
  )

/** The change on a lane at a tick, by where it stands. */
const change = (which, tick) =>
  page.evaluate(
    (w, t) => {
      const el = document.querySelectorAll('.timing-layer')[w].querySelector(`.timing-change[data-tick="${t}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + Math.min(8, r.width / 2), y: r.top + r.height / 2, text: el.textContent.trim() }
    },
    which,
    tick,
  )

/** Type into the change's field that has just opened, and let go of it. */
async function typeIn(text) {
  const opened = await waitUntil(page, () => document.activeElement?.classList.contains('timing-edit'))
  if (!opened) return false
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await edited()
  return true
}

await page.goto(url, { waitUntil: 'networkidle0' })
await page.click('.dock-fold')
await wait(250)
const songButton = await page.evaluateHandle(() =>
  [...document.querySelectorAll('.dock-views .dock-toggle')].find((b) => b.textContent.trim() === 'Song'),
)
await songButton.asElement().click()
await waitUntil(page, () => document.querySelector('.playlist-layer'))

console.log('\nthe lanes')
{
  check('there is a tempo lane and a time lane', (await page.$$('.timing-layer')).length === 2)
  check('the tempo at the start is on it', (await change(0, 0))?.text === '120', (await change(0, 0))?.text)
  check('and so is the time signature', (await change(1, 0))?.text === '4/4', (await change(1, 0))?.text)
  const b0 = await bar(0)
  const b1 = await bar(1)
  check('bars start out all the same width', Math.abs(b0.width - b1.width) < 0.5)
}

console.log('\na change of tempo')
{
  const b2 = await bar(2)
  const at = await lane(0, b2.left + 3)
  await page.mouse.click(at.x, at.y)
  check('a click on the lane opens a field to type into', await typeIn('140'))
  const s = await song()
  check('and makes a change there, on the bar', JSON.stringify(s.tempos) === JSON.stringify([{ tick: 2 * BAR, bpm: 140 }]), JSON.stringify(s.tempos))
  check('it is drawn where it is', (await change(0, 2 * BAR))?.text === '140')
  check('the tempo field says there is a change', await page.evaluate(() => document.querySelector('.dock-bar .dock-more')?.textContent === '+1'))

  const c = await change(0, 2 * BAR)
  await page.mouse.click(c.x, c.y)
  check('a click on a change opens it', await typeIn('90'))
  check('and sets it', (await song()).tempos?.[0]?.bpm === 90, JSON.stringify((await song()).tempos))

  const b4 = await bar(4)
  const from = await change(0, 2 * BAR)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 20, from.y, { steps: 3 })
  await page.mouse.move(b4.left + 3, from.y, { steps: 4 })
  await page.mouse.up()
  await edited()
  check('a change is dragged to another bar', JSON.stringify((await song()).tempos) === JSON.stringify([{ tick: 4 * BAR, bpm: 90 }]),
    JSON.stringify((await song()).tempos))

  const opening = await change(0, 0)
  await page.mouse.click(opening.x, opening.y)
  check('the one at the start opens too', await typeIn('100'))
  check('and is the song\'s own tempo', (await song()).tempo === 100)
  check('which the dock\'s field shows', await page.evaluate(() => document.querySelector('.dock-bar input[aria-label^="Tempo"]')?.value === '100'))
}

console.log('\na change of time signature')
{
  const b1 = await bar(1)
  const at = await lane(1, b1.left + 3)
  await page.mouse.click(at.x, at.y)
  check('a click on the time lane opens a field', await typeIn('3/4'))
  const s = await song()
  check('a change of meter is made on the bar', JSON.stringify(s.meters) === JSON.stringify([{ tick: BAR, meter: { beats: 3, unit: 4 } }]), JSON.stringify(s.meters))
  const a = await bar(0)
  const b = await bar(1)
  check('the bar after it is three beats wide', Math.abs(b.width - (a.width * 3) / 4) < 0.5, `${a.width} ${b.width}`)
  check('the next bar starts three beats on', Math.abs((await bar(2)).left - (b.left + b.width)) < 0.5)
  check('the grid draws a stretch per meter', (await page.$$('.playlist-meter')).length === 2)
  check('the tempo change stays on its tick, not its bar', (await song()).tempos?.[0]?.tick === 4 * BAR)
  check('the time field says there is a change', await page.evaluate(() =>
    [...document.querySelectorAll('.dock-bar .dock-more')].some((e) => e.textContent === '+1')))

  // Something that is not a time signature changes nothing.
  const c = await change(1, BAR)
  await page.mouse.click(c.x, c.y)
  await typeIn('3/5')
  check('a meter that cannot be is not taken', (await song()).meters?.[0]?.meter.unit === 4)
  await page.mouse.click(c.x, c.y)
  await typeIn('5/16')
  check('a meter of sixteenths is', JSON.stringify((await song()).meters?.[0]?.meter) === JSON.stringify({ beats: 5, unit: 16 }))
  check('and its bar is five sixteenths wide', Math.abs((await bar(1)).width - ((await bar(0)).width * 5) / 16) < 0.5)
  await page.mouse.click(c.x, c.y)
  await typeIn('3/4')

  // A clip painted in the 3/4 bar starts on its barline.
  const b2 = await bar(2)
  const layer = await page.evaluate(() => document.querySelector('.playlist-layer').getBoundingClientRect().top)
  await page.mouse.click(b2.left + b2.width / 2, layer + 24 + 12)
  await edited()
  const painted = (await song()).playlist.find((p) => p.lane === 1)
  check('a clip painted in bar three starts where bar three does', painted?.tick === BAR + 3 * PPQ, JSON.stringify(painted))

  if (process.env.SHOT) await (await page.$('.dock')).screenshot({ path: process.env.SHOT })

  const from = await change(1, BAR)
  const b3 = await bar(3)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 20, from.y, { steps: 3 })
  await page.mouse.move(b3.left + b3.width * 0.1, from.y, { steps: 4 })
  await page.mouse.up()
  await edited()
  const moved = (await song()).meters
  // Without the change there, bar four starts three bars of 4/4 in.
  check('a meter change is dragged onto a barline', moved?.[0]?.tick === 3 * BAR, JSON.stringify(moved))

  const m = await change(1, 3 * BAR)
  await page.mouse.click(m.x, m.y, { button: 'right' })
  await wait(150)
  const removed = await page.evaluate(() => {
    const item = [...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('Remove this change'))
    item?.click()
    return !!item
  })
  await edited()
  check('and taken away from its menu', removed && !('meters' in (await song())))
}

console.log('\nthe roll')
{
  // The first bar in 7/8: the pattern at the start is ruled in it.
  const opening = await change(1, 0)
  await page.mouse.click(opening.x, opening.y)
  await typeIn('7/8')
  check('the meter at the start is the song\'s own', JSON.stringify((await song()).meter) === JSON.stringify({ beats: 7, unit: 8 }))
  const rollButton = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.dock-views .dock-toggle')].find((b) => b.textContent.trim() === 'Roll'),
  )
  await rollButton.asElement().click()
  await waitUntil(page, () => document.querySelector('.roll-canvas'))
  // With no other change of meter, the song keeps its bars: a one-bar
  // pattern is one bar of 7/8.
  check('a one-bar pattern is one bar of the new meter', (await song()).patterns[0].length === 7 * 480, String((await song()).patterns[0].length))
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('.dock-bar .dock-field')].find((l) => l.textContent.startsWith('Bars'))?.querySelector('select')?.value)
  check('and the roll counts it as one', shown === '1', String(shown))
}

console.log('\na ramp')
{
  // A ramp as a DAW exports one: sixty-four steps a sixteenth apart, put in
  // the saved project as the page reloads -- after it has saved what it had
  // on the way out, and before the app reads it back.
  const doc = await stored()
  doc.song.tempos = Array.from({ length: 64 }, (_, i) => ({ tick: BAR + i * 240, bpm: 101 + i }))
  await page.evaluateOnNewDocument((d) => {
    if (!sessionStorage.getItem('ramp')) {
      sessionStorage.setItem('ramp', '1')
      localStorage.setItem('fresyn.project.v1', d)
    }
  }, JSON.stringify(doc))
  const fresh = page
  await fresh.reload({ waitUntil: 'networkidle0' })
  if (!(await fresh.$('.playlist-layer'))) {
    if (!(await fresh.$('.dock-body'))) await fresh.click('.dock-fold')
    await wait(250)
    const b = await fresh.evaluateHandle(() =>
      [...document.querySelectorAll('.dock-views .dock-toggle')].find((x) => x.textContent.trim() === 'Song'),
    )
    await b.asElement().click()
  }
  await waitUntil(fresh, () => document.querySelector('.timing-layer'))
  const drawn = await fresh.evaluate(() => {
    const lane = document.querySelectorAll('.timing-layer')[0]
    return {
      all: lane.querySelectorAll('.timing-change').length,
      labelled: lane.querySelectorAll('.timing-change:not(.mini)').length,
      curve: !!lane.querySelector('.timing-curve polyline'),
    }
  })
  check('sixty-four changes are not sixty-four labels', drawn.labelled < 20 && drawn.all > 20, JSON.stringify(drawn))
  check('the tempo is drawn as a line across the lane', drawn.curve)
  if (process.env.SHOT) await (await fresh.$('.dock')).screenshot({ path: process.env.SHOT.replace(/\.png$/, '-ramp.png') })
  const lane = await fresh.evaluate(() => {
    const r = document.querySelectorAll('.timing-layer')[0].getBoundingClientRect()
    return { x: r.left + r.width - 40, y: r.top + r.height / 2 }
  })
  await fresh.mouse.click(lane.x, lane.y, { button: 'right' })
  await wait(150)
  const cleared = await fresh.evaluate(() => {
    const item = [...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('Remove every tempo change (64)'))
    item?.click()
    return !!item
  })
  await frames(fresh)
  await flushAutosave(fresh)
  const after = await fresh.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1')).song)
  check('and every one of them goes from the menu at once', cleared && !('tempos' in after), `${cleared} ${after.tempos?.length}`)
}

await finish()
