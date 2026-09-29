/**
 * End-to-end check for Audio settings: the dialog opens from the Edit menu,
 * reads the device once it is open, rebuilds the context when the buffer or
 * the sample rate changes without the rack going quiet, and remembers what
 * was chosen across a reload.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
import { check, finish, open, settle, waitUntil } from './harness.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 900 } })
await page.goto(url, { waitUntil: 'networkidle0' })

const openDialog = async () => {
  const edit = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Edit'),
  )
  await edit.asElement().click()
  await settle(120)
  const item = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.menu-item .menu-text')].find((e) => e.textContent.trim() === 'Audio settings...'),
  )
  await item.asElement().click()
  await waitUntil(page, () => !!document.querySelector('.audio-sheet'))
}

const readout = () => page.evaluate(() => document.querySelector('.audio-readout')?.textContent ?? '')
const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.prefs.v1') ?? '{}').audio ?? {})
/** No "Audio stopped" card: a rebuild that failed would put one up. */
const noFailure = () =>
  page.evaluate(() => ![...document.querySelectorAll('.notice-text')].some((e) => /Audio stopped/.test(e.textContent)))

// Before anything has played there is nothing to measure.
await openDialog()
check('it opens from the Edit menu', true)
check('it waits for the device before measuring', /Not measured yet/.test(await readout()))
check('the buffer starts at Low', (await page.$eval('#audio-latency', (e) => e.value)) === 'low')

await page.keyboard.press('Escape')
await waitUntil(page, () => !document.querySelector('.audio-sheet'))
check('Escape closes it', true)

// Open the device the way a person does, then look again.
await page.click('.trigger')
await waitUntil(page, () => !!document.querySelector('.led.on'))
await openDialog()
await waitUntil(page, () => !!document.querySelector('.audio-total'))
check('it measures the open device', /ms/.test(await readout()), await readout())

// A new buffer means a new context; the readout comes back once it is up.
await page.select('#audio-latency', 'balanced')
await waitUntil(page, () => !!document.querySelector('.audio-total'), { timeout: 8000 })
check('Balanced is remembered', (await prefs()).latency === 'balanced')
check('the rebuilt device is measured', /ms/.test(await readout()), await readout())
check('the rebuild did not fail', await noFailure())

await page.select('#audio-rate', '44100')
await waitUntil(page, () => /44\.1 kHz/.test(document.querySelector('.audio-readout')?.textContent ?? ''), {
  timeout: 8000,
})
check('the device runs at the chosen rate', /44\.1 kHz/.test(await readout()), await readout())
check('the rate is remembered', (await prefs()).sampleRate === 44100)

await page.select('#audio-latency', 'custom')
await waitUntil(page, () => !!document.querySelector('.audio-ms input'))
await page.click('.audio-ms input', { clickCount: 3 })
await page.type('.audio-ms input', '1000')
await page.keyboard.press('Enter')
await settle(100)
check('a custom buffer is held to its bounds', (await prefs()).latency === 500, JSON.stringify(await prefs()))
check('still no failure', await noFailure())

await page.keyboard.press('Escape')
await waitUntil(page, () => !document.querySelector('.audio-sheet'))

// The rack still plays after all that.
await page.mouse.click(5, 5)
await waitUntil(page, () => !document.querySelector('.led.on'), { timeout: 4000 }).catch(() => {})
await page.click('.trigger')
await waitUntil(page, () => !!document.querySelector('.led.on'))
check('the rack still plays after the rebuilds', await noFailure())

await page.reload({ waitUntil: 'networkidle0' })
await openDialog()
const kept = await page.evaluate(() => ({
  latency: document.querySelector('#audio-latency').value,
  ms: document.querySelector('.audio-ms input')?.value,
  rate: document.querySelector('#audio-rate').value,
}))
check('the settings survive a reload', kept.latency === 'custom' && kept.ms === '500' && kept.rate === '44100', JSON.stringify(kept))

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })

await finish()
