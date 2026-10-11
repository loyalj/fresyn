import { check, finish, flushAutosave, open, settle, waitUntil } from './harness.mjs'

/**
 * End-to-end check for the master rack: the Mix view's master strip adds it
 * and puts it on the bench, the audio thread is given it, the track list
 * lists it above the tracks, the roll has nothing to write for it, it is
 * kept with the project, and it can be taken away again.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1000 } })
// What the page tells the audio thread about racks.
await page.evaluateOnNewDocument(() => {
  window.__racks = []
  const Real = window.AudioWorkletNode
  window.AudioWorkletNode = class extends Real {
    constructor(...a) {
      super(...a)
      for (const t of a[2]?.processorOptions?.tracks ?? []) window.__racks.push({ type: 'track', id: t.id })
      const post = this.port.postMessage.bind(this.port)
      this.port.postMessage = (msg, ...rest) => {
        if (msg?.type === 'track' || msg?.type === 'removeTrack') window.__racks.push({ type: msg.type, id: msg.id })
        return post(msg, ...rest)
      }
    }
  }
})
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const MASTER = '~master'
const saved = async () => {
  await flushAutosave(page)
  return page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}'))
}
const view = async (name) => {
  if (!(await page.$('.dock-toggle'))) {
    await page.click('.dock-fold')
    await settle(200)
  }
  await page.evaluate((n) => [...document.querySelectorAll('.dock-toggle')].find((b) => b.textContent.trim() === n)?.click(), name)
  await settle(300)
}
const rackButton = () => page.$eval('.mix-master-rack .dock-toggle', (b) => ({ text: b.textContent.trim(), on: b.classList.contains('on') }))

console.log('\nadding it')
{
  await view('Mix')
  check('the master strip offers a rack', (await rackButton()).text === '+ Rack')
  // Something to hear once it is there, so the audio thread is running.
  await page.click('.dock-play')
  await page.click('.mix-master-rack .dock-toggle')
  const project = await saved()
  check('a click adds one, kept with the project', !!project.racks?.[MASTER], JSON.stringify(Object.keys(project.racks ?? {})))
  check('a Bus In, passing the mix through', project.racks?.[MASTER]?.patch.modules.map((m) => m.type).join() === 'busin')
  check('and is no track of the song', !project.song.tracks.some((t) => t.id === MASTER))
  check('it goes on the bench', await waitUntil(page, () => !!document.querySelector('[data-module="bus1"]')))
  check('named Master', await page.evaluate(() => document.querySelector('.rack-index-title')?.selectedOptions[0]?.textContent.trim() === 'Master'))
  check('the button says so', (await rackButton()).text === 'Rack' && (await rackButton()).on)
  check('the audio thread is given it', await waitUntil(page, (id) => window.__racks.some((m) => m.type === 'track' && m.id === id), { args: [MASTER] }))
  await page.click('.dock-play')
}

console.log('\non the bench')
{
  await view('Roll')
  check('the track list lists it above the tracks', !!(await page.$('.tracks-rows > .track-master.on:first-child')))
  check('and the roll says it has nothing to write', !!(await page.$('.roll-master')))
  await page.click('.tracks-rows .track:not(.track-master) .track-name')
  await settle(200)
  check('another track goes back on the bench', !(await page.$('[data-module="bus1"]')) && !(await page.$('.roll-master')))
  await page.click('.track-master-name')
  check('and the master comes back from the list', await waitUntil(page, () => !!document.querySelector('[data-module="bus1"]')))
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
}

console.log('\nkept, and taken away')
{
  await page.reload({ waitUntil: 'networkidle0' })
  check('it comes back with the project', !!(await saved()).racks?.[MASTER])
  // The audio thread is built when something first plays.
  await view('Mix')
  await page.click('.dock-play')
  check('and the audio thread is built with it', await waitUntil(page, (id) => window.__racks.some((m) => m.type === 'track' && m.id === id), { args: [MASTER] }))
  await page.click('.mix-master-rack .track-remove')
  const project = await saved()
  check('× takes it away', !project.racks?.[MASTER])
  check('and from the audio thread', await waitUntil(page, (id) => window.__racks.some((m) => m.type === 'removeTrack' && m.id === id), { args: [MASTER] }))
  check('the strip offers it again', (await rackButton()).text === '+ Rack')
  await page.click('.dock-play')
}

await finish()
