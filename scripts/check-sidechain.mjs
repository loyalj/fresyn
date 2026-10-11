import { check, finish, flushAutosave, open, settle, waitUntil } from './harness.mjs'

/**
 * End-to-end check for the Track In's panel: it lists the song's other
 * tracks, picking one is kept with the project, one that would close a loop
 * is offered greyed out, and a track that has gone is named as gone.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1100 } })
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const KEY = 'fresyn.project.v1'
const saved = async () => {
  await flushAutosave(page)
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), KEY)
}
const pick = async (n) => {
  // The track list is in the dock, folded away at first.
  if (!(await page.$('.track'))) {
    await page.click('.dock-fold')
    await waitUntil(page, () => !!document.querySelector('.track'))
  }
  await page.click(`.track:nth-child(${n} of .track) .track-name`)
  await settle(200)
}
const options = () =>
  page.$$eval('.trackin-source option', (os) => os.map((o) => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled })))
const textOf = (project, track) => project.racks?.[track]?.patch.modules.find((m) => m.type === 'trackin')?.text

// Two tracks, each rack with a Track In, the second hearing the first.
const start = await saved()
const kick = start.song.tracks[0]
const rack = start.racks[kick.id]
const withTap = (text) => ({
  ...rack,
  patch: { ...rack.patch, modules: [...rack.patch.modules, { id: 'tap1', type: 'trackin', params: {}, ...(text ? { text } : {}) }] },
})
const project = {
  ...start,
  song: { ...start.song, tracks: [{ ...kick, name: 'Kick' }, { ...kick, id: 'bass', name: 'Bass' }] },
  racks: { [kick.id]: withTap(), bass: withTap(kick.id) },
}
await page.evaluate((key, p) => localStorage.setItem(key, JSON.stringify(p)), KEY, project)
await page.reload({ waitUntil: 'networkidle0' })

console.log('\nthe panel')
{
  await pick(2)
  check('a Track In has a menu of tracks', await waitUntil(page, () => !!document.querySelector('.trackin-source')))
  const opts = await options()
  check('listing the other tracks, and not its own', opts.map((o) => o.text).join() === 'No track,Kick', JSON.stringify(opts))
  check('showing the one it hears', (await page.$eval('.trackin-source', (s) => s.value)) === kick.id)
  if (process.env.SHOT) await page.$eval('[data-module="tap1"]', (el) => el.scrollIntoView({ block: 'center' }))
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
}

console.log('\nno loops')
{
  await pick(1)
  const opts = await options()
  const bass = opts.find((o) => o.text === 'Bass')
  check('a track that hears this one is greyed out', !!bass && bass.disabled, JSON.stringify(opts))

  await pick(2)
  await page.select('.trackin-source', '')
  check('choosing No track lets go of it', textOf(await saved(), 'bass') === undefined)

  await pick(1)
  const freed = (await options()).find((o) => o.text === 'Bass')
  check('after which the other way round is offered', !!freed && !freed.disabled, JSON.stringify(freed))
  await page.select('.trackin-source', 'bass')
  check('and picking it is kept with the project', textOf(await saved(), kick.id) === 'bass')
}

console.log('\na track that has gone')
{
  const p = await saved()
  p.song.tracks = p.song.tracks.filter((t) => t.id !== 'bass')
  delete p.racks.bass
  await page.evaluate((key, q) => localStorage.setItem(key, JSON.stringify(q)), KEY, p)
  await page.reload({ waitUntil: 'networkidle0' })
  await pick(1)
  const opts = await options()
  check('is named as gone, not quietly dropped', opts.some((o) => o.text === '(gone)' && o.value === 'bass'), JSON.stringify(opts))
}

await finish()
