import { open, finish, settle as wait, waitUntil } from './harness.mjs'
const out = process.env.SHOT_DIR
const themes = (process.env.THEMES ?? 'standard/light').split(',')
const { page, url } = await open({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 })
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.removeItem('fresyn.prefs.v1'))
await page.reload({ waitUntil: 'networkidle0' })
const menu = (await page.evaluateHandle(() => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Utilities'))).asElement()
await menu.click(); await wait(150)
const item = (await page.evaluateHandle(() => [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.includes('Metronome')))).asElement()
await item.click()
await waitUntil(page, () => !!document.querySelector('.metronome'), { timeout: 5000 })
if (process.env.RUN) { await (await page.$('.metronome-go')).click(); await wait(Number(process.env.RUN)) }
await page.mouse.move(5, 5); await wait(200)
console.log(await page.evaluate(() => { const b = document.querySelector('.utility-body'); const r = document.querySelector('.utility-panel').getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)} scrolls=${b.scrollHeight > b.clientHeight}` }))
for (const t of themes) {
  const [theme, mode] = t.split('/')
  await page.evaluate((a, b) => { document.documentElement.dataset.theme = a; document.documentElement.dataset.mode = b }, theme, mode)
  await wait(250)
  await (await page.$(process.env.SEL ?? '.utility-panel')).screenshot({ path: `${out}/metro-${theme}-${mode}.png` })
}
await finish()
