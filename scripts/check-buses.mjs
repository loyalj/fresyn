import { check, finish, flushAutosave, open, settle, waitUntil } from './harness.mjs'

/**
 * End-to-end check for buses in the Mix view: + Bus adds a track whose rack
 * is a Bus In, a strip's output menu routes it there, a send knob turns up a
 * send, a route that would loop is offered greyed out, the audio thread is
 * told, and the routing is kept with the project.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1100 } })
// The last mix the page told the audio thread.
await page.evaluateOnNewDocument(() => {
  window.__mix = null
  const Real = window.AudioWorkletNode
  window.AudioWorkletNode = class extends Real {
    constructor(...a) {
      super(...a)
      // The first mix arrives with the node; later ones as messages.
      if (a[2]?.processorOptions?.mix) window.__mix = a[2].processorOptions.mix
      const post = this.port.postMessage.bind(this.port)
      this.port.postMessage = (msg, ...rest) => {
        if (msg?.type === 'mix') window.__mix = msg.mix
        return post(msg, ...rest)
      }
    }
  }
})
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const saved = async () => {
  await flushAutosave(page)
  return page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}'))
}
const strip = (n) => `.mix-strips > :nth-child(${n} of .mix-strip)`
const options = (n) =>
  page.$$eval(`${strip(n)} .mix-out option`, (os) => os.map((o) => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled })))

console.log('\nadding a bus')
{
  await page.evaluate(() => [...document.querySelectorAll('.dock-view button, button')].find((b) => b.textContent.trim() === 'Mix')?.click())
  await settle(300)
  check('the Mix view is showing', !!(await page.$('.mix-strip:not(.mix-master)')))
  check('with no output menu while there is no bus', !(await page.$('.mix-out')))
  await page.click('.mix-add-bus')
  check('+ Bus adds a strip', await waitUntil(page, () => document.querySelectorAll('.mix-strips > .mix-strip').length === 2))
  check('marked as a bus', !!(await page.$(`${strip(2)} .mix-bus-tag`)))
  const project = await saved()
  const bus = project.song.tracks[1]
  check('a track named for it', bus?.name === 'Bus 1', bus?.name)
  check('whose rack is a Bus In', project.racks?.[bus?.id]?.patch.modules.some((m) => m.type === 'busin'))
}

console.log('\nrouting and sending')
{
  const opts = await options(1)
  check('the first strip can go to the master or the bus', opts.length === 2 && opts[0].text.includes('Master') && opts[1].text.includes('Bus 1'), JSON.stringify(opts))
  check('a bus is not offered itself', !(await page.$(`${strip(2)} .mix-out`)))
  await page.select(`${strip(1)} .mix-out`, opts[1].value)
  let project = await saved()
  check('choosing the bus routes the track there', project.song.tracks[0].strip?.out === opts[1].value)

  const send = `${strip(1)} .mix-sends .knob`
  check('each strip has a send to the bus', (await page.$$(send)).length === 1)
  await page.$eval(`${send} svg`, (el) => el.focus())
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp')
  project = await saved()
  const amount = project.song.tracks[0].strip?.sends?.[opts[1].value] ?? 0
  check('turning it up sets a send', amount > 0, `${amount}`)

  await page.click('.dock-play')
  check('the audio thread is told the route and the send', await waitUntil(page, (id) => window.__mix?.bench?.out === id && window.__mix?.bench?.sends?.[id] > 0, { args: [opts[1].value] }))
  await page.click('.dock-play')
}

console.log('\nno loops')
{
  await page.click('.mix-add-bus')
  await waitUntil(page, () => document.querySelectorAll('.mix-strips > .mix-strip').length === 3)
  const project = await saved()
  const [, first, second] = project.song.tracks.map((t) => t.id)
  await page.select(`${strip(2)} .mix-out`, second)
  const back = await options(3)
  const toFirst = back.find((o) => o.value === first)
  check('a bus fed by another cannot be routed back to it', !!toFirst && toFirst.disabled, JSON.stringify(back))
  const sends = await page.$$eval(`${strip(3)} .mix-sends .knob`, (ks) => ks.length)
  check('nor offered a send to it', sends === 0, `${sends}`)

  await page.reload({ waitUntil: 'networkidle0' })
  const kept = await saved()
  check('the routing is kept with the project', kept.song.tracks[0].strip?.out === first && kept.song.tracks[1].strip?.out === second)
}

await page.evaluate(() => [...document.querySelectorAll('.dock-view button, button')].find((b) => b.textContent.trim() === 'Mix')?.click())
await settle(300)
// Only when asked: a run of the suite leaves nothing behind.
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })

await finish()
