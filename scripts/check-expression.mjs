import { check, finish, flushAutosave, frames, open, settle, waitUntil } from './harness.mjs'

/**
 * End-to-end check for the Expression's panel: a formula typed into it is
 * checked as it is typed, a mistake is named and never reaches the rack, a
 * good one is handed over on Enter and undoes like any edit, keys typed into
 * the field stay in the field, and the graph draws.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1100 } })
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const rack = async () => {
  await flushAutosave(page)
  return page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}').racks?.bench?.patch ?? { modules: [] })
}
const field = '.expr-formula'
const formula = () => page.$eval(field, (el) => el.value)
const status = () => page.$eval('.expr-status', (el) => ({ text: el.textContent, error: el.classList.contains('error') }))
const withCtrl = async (key) => {
  await page.keyboard.down('Control')
  await page.keyboard.press(key)
  await page.keyboard.up('Control')
}
const replaceWith = async (text) => {
  await page.click(field, { clickCount: 3 })
  await withCtrl('KeyA')
  await page.keyboard.type(text)
}
/** How many pixels of the graph are drawn on. */
const inked = () =>
  page.$eval('.expr-screen', (c) => {
    const g = c.getContext('2d')
    const d = g.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
    return n
  })

console.log('\nadding one')
{
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyK')
  await page.keyboard.up('Control')
  await settle(200)
  await page.keyboard.type('expression')
  await settle(100)
  await page.keyboard.press('Enter')
  await frames(page)
  check('it arrives from the module search', (await rack()).modules.some((m) => m.type === 'expr'))
  check('with its starting formula in the field', (await formula()) === 'sin(pi * x) * a + b', await formula())
  check('and a graph drawn', await waitUntil(page, () => {
    const c = document.querySelector('.expr-screen')
    return !!c && c.width > 0
  }) && (await inked()) > 200)
}

if (process.env.SHOT_MATH) {
  await page.$eval('.expr-face', (el) => el.scrollIntoView({ block: 'center' }))
  await settle(200)
  await page.screenshot({ path: process.env.SHOT_MATH })
}

console.log('\ntyping a formula')
{
  const before = await page.evaluate(() => !!document.querySelector('.rack-flipped'))
  await replaceWith('floor(t * 4) % 2')
  check('keys typed into the field stay there (F does not flip the rack)', (await page.evaluate(() => !!document.querySelector('.rack-flipped'))) === before)
  check('a good draft says Enter will use it', (await status()).text.includes('Enter'), (await status()).text)
  check('and the rack has not heard it yet', (await rack()).modules.find((m) => m.type === 'expr')?.text === undefined)
  await page.keyboard.press('Enter')
  await frames(page)
  check('Enter hands it to the rack', (await rack()).modules.find((m) => m.type === 'expr')?.text === 'floor(t * 4) % 2')
  check('a formula of t alone is drawn against t', (await page.$eval('.expr-prompt', (e) => e.textContent)) === 'f(t) =')

  await replaceWith('sin(pi * ')
  const err = await status()
  check('a mistake is named as it is typed', err.error && /end|short/i.test(err.text), err.text)
  check('and marks the field', await page.$eval(field, (el) => el.classList.contains('invalid')))
  await page.keyboard.press('Enter')
  await frames(page)
  check('Enter does not hand a broken formula over', (await rack()).modules.find((m) => m.type === 'expr')?.text === 'floor(t * 4) % 2')
  await page.keyboard.press('Escape')
  check('Esc puts the field back', (await formula()) === 'floor(t * 4) % 2')
  check('and the graph still draws the formula in use', (await inked()) > 200)
}

console.log('\nundo, and bytebeat')
{
  await page.click('.expr-screen')
  await withCtrl('KeyZ')
  await frames(page)
  check('a formula undoes like any edit', (await rack()).modules.find((m) => m.type === 'expr')?.text === undefined)
  check('and the field follows', await waitUntil(page, () => document.querySelector('.expr-formula')?.value === 'sin(pi * x) * a + b'))

  const clicked = await page.evaluate(() => {
    const unit = document.querySelector('.expr-face')?.closest('.unit')
    const b = [...(unit?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === 'bytebeat')
    b?.click()
    return !!b
  })
  check('Mode has a bytebeat position', clicked)
  await replaceWith('t*(t>>5|t>>8)')
  await page.keyboard.press('Enter')
  await frames(page)
  check('a bytebeat one-liner is taken as typed', (await rack()).modules.find((m) => m.type === 'expr')?.text === 't*(t>>5|t>>8)')
  check('and drawn against t', (await page.$eval('.scope-legend', (e) => e.textContent)) !== '' && (await inked()) > 200)
}

await page.$eval('.expr-face', (el) => el.scrollIntoView({ block: 'center' }))
await settle(200)
// Only when asked: a run of the suite leaves nothing behind.
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })

await finish()
