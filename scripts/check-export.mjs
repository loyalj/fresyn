/**
 * End-to-end render: drives the export panel, takes delivery of the zip the
 * browser downloads, and extracts it with a real unzip implementation.
 *
 * Extraction matters more than it looks. The zip writer is hand-rolled, and a
 * wrong CRC or a wrong offset still reads back fine through the same code that
 * wrote it -- only a different implementation will reject it.
 *
 * Needs `npm run dev -- --port 5199` in another terminal.
 * Point CHROME_PATH at a Chromium build if the default is wrong.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
const URL = process.env.DEV_URL || 'http://localhost:5199/'

const downloads = mkdtempSync(join(tmpdir(), 'fresyn-wav-'))
const extracted = join(downloads, 'unzipped')

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 1000 })

const problems = []
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) problems.push('console: ' + m.text())
})
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms))

const waitForFile = async (dir, ext, timeoutMs = 20000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const hits = readdirSync(dir).filter((f) => f.endsWith(ext))
    if (hits.length) return hits
    await settle(150)
  }
  return []
}

await page.goto(URL, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const cdp = await page.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })

// --- triggers live on the panels --------------------------------------
console.log('\ntriggers live on the panels')
{
  check('the transport footer is gone', await page.evaluate(() => !document.querySelector('.transport')))
  const withTrigger = await page.evaluate(() =>
    [...document.querySelectorAll('.unit-face-front')]
      .filter((u) => u.querySelector('.trigger'))
      .map((u) => u.querySelector('.unit-id')?.textContent),
  )
  // One in the stock rack: the oscillator's own, which is what makes it a
  // plucked note rather than a drone. It has no Trigger module; its Keyboard
  // is played by its own keys.
  check('the oscillator has one', withTrigger.includes('osc1'), withTrigger.join(','))
  check('nothing else in the stock rack does', withTrigger.length === 1, withTrigger.join(','))
}

// --- the recorder is a rack module -------------------------------------
console.log('\nthe recorder lives on its own panel')
{
  // The stock rack has none: the mixer drives the speakers by itself, and a
  // recorder is what you add when you want files. So adding one is the first
  // step of any render, and the first thing worth checking.
  check(
    'the stock rack has no render controls',
    await page.evaluate(() => !document.querySelector('.export-panel')),
  )


/**
 * Add a module from the Modules menu, wherever in its submenus it lives.
 *
 * The group a module belongs to is declared on its definition, which this
 * script cannot import -- so the groups are walked until the name turns up,
 * and a module that moves between them needs nothing changed here.
 */
const addModule = async (name) => {
  const menu = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Modules'),
  )
  const trigger = menu.asElement()
  if (!trigger) return false
  await trigger.click()
  await settle(120)

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
    await settle(120)
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
      await settle(300)
      return true
    }
  }
  await page.keyboard.press('Escape')
  await settle(120)
  return false
}

/** Every module the Modules menu offers, across all of its groups. */
const menuModules = async () => {
  const menu = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Modules'),
  )
  await menu.asElement().click()
  await settle(120)
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll('.menu > .menu-slot > .menu-item .menu-text')].map((e) =>
      e.textContent.trim(),
    ),
  )
  const names = []
  for (const group of groups) {
    const gh = await page.evaluateHandle(
      (g) =>
        [...document.querySelectorAll('.menu > .menu-slot > .menu-item .menu-text')].find(
          (e) => e.textContent.trim() === g,
        ),
      group,
    )
    await gh.asElement().hover()
    await settle(120)
    names.push(
      ...(await page.evaluate(() =>
        [...document.querySelectorAll('.menu-nested .menu-item .menu-text')].map((e) =>
          e.textContent.trim(),
        ),
      )),
    )
  }
  await page.keyboard.press('Escape')
  await settle(120)
  return names
}

  check('a Recorder can be added from the menu', await addModule('Recorder'))
  check(
    'adding a Recorder brings them',
    await page.evaluate(() => !!document.querySelector('.export-panel')),
  )

  const host = await page.evaluate(() => {
    const el = document.querySelector('.export-panel')
    if (!el) return 'no render controls at all'
    const unit = el.closest('.unit-face-front')
    if (!unit) return 'not on a panel'
    return unit.querySelector('.unit-id')?.textContent ?? 'on an unnamed unit'
  })
  check('the render control is on the recorder unit', host === 'rec1', host)

  // The render controls used to live in a strip under the rack, and the module
  // picker with them. Both are gone: the controls are on the recorder's own
  // panel, and modules are added from the menu at the top.
  check(
    'nothing is left under the rack',
    await page.evaluate(() => !document.querySelector('.rack-tools')),
  )

  // One set of render controls, even though a rack may hold more than one
  // recorder: only the first is the one the compiler takes the render from.
  const added = await addModule('Recorder')
  check('the picker offers a second Recorder', added)
  await settle(300)

  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('.unit-face-front .unit-id')].map((e) => e.textContent),
  )
  check('the rack has two recorders', ids.includes('rec1') && ids.includes('rec2'), ids.join(','))
  const count = await page.evaluate(() => document.querySelectorAll('.export-panel').length)
  check('but only one recorder', count === 1, `${count} found`)

  // Put the rack back the way the rest of this run expects it.
  await page.evaluate(() => {
    const unit = [...document.querySelectorAll('.unit-face-front')].find(
      (u) => u.querySelector('.unit-id')?.textContent === 'rec2',
    )
    unit.closest('.unit-flip').querySelector('.unit-remove').click()
  })
  await settle(300)
  check(
    'the spare was removed again',
    // Five stock units plus the recorder this section added.
    (await page.evaluate(() => document.querySelectorAll('.unit-face-front').length)) === 6,
    `${await page.evaluate(() => document.querySelectorAll('.unit-face-front').length)} units`,
  )
}

// --- render a batch ----------------------------------------------------
console.log('\nrendering a batch')
{
  // The name lives on the selected track in the dock now.
  if (!(await page.$('.track.on .track-name'))) {
    await page.click('.dock-fold')
    await settle(200)
  }
  await page.click('.track.on .track-name', { clickCount: 3 })
  await page.keyboard.type('Impact')

  // The settings are the panel now; there is nothing to open first.
  check(
    'the export settings are already showing',
    await page.evaluate(() => !!document.querySelector('.export-panel .export-fields')),
  )
  check(
    'with nothing to open or close them',
    await page.evaluate(
      () => !document.querySelector('.export-open, .export-panel .panel-cancel'),
    ),
  )

  // The settings are knobs, like everything else on a panel here.
  check(
    'the settings are knobs',
    (await page.evaluate(() => document.querySelectorAll('.export-panel .knob').length)) === 5,
  )
  check(
    'and no typed fields are left',
    await page.evaluate(() => !document.querySelector('.export-panel input')),
  )

  const knobAt = (label) =>
    page.evaluate((l) => {
      const k = [...document.querySelectorAll('.export-panel .knob')].find(
        (k) => k.querySelector('.knob-label')?.textContent === l,
      )
      if (!k) return null
      const r = k.querySelector('svg').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, label)

  const knobReads = (label) =>
    page.evaluate((l) => {
      const k = [...document.querySelectorAll('.export-panel .knob')].find(
        (k) => k.querySelector('.knob-label')?.textContent === l,
      )
      return k?.querySelector('.knob-readout')?.textContent ?? null
    }, label)

  const seconds = (text) => (/ms/.test(text) ? parseFloat(text) / 1000 : parseFloat(text))

  // A knob is turned, not typed into, so a value is reached rather than set.
  // The wheel is a fixed fraction of the range per notch, which converges
  // without the check having to know the curve behind it.
  const turnUntil = async (label, done) => {
    const at = await knobAt(label)
    if (!at) return false
    await page.mouse.move(at.x, at.y)
    for (let i = 0; i < 300; i++) {
      const reading = await knobReads(label)
      if (done(reading)) return true
      await page.mouse.wheel({ deltaY: done.up ? -100 : 100 })
      await settle(12)
    }
    return false
  }

  const toThree = (r) => r === '3'
  toThree.up = false
  check('Takes can be turned to three', await turnUntil('Takes', toThree), await knobReads('Takes'))

  // Short takes, so auditioning one finishes inside this run.
  const short = (r) => seconds(r) <= 0.35
  short.up = false
  check('Length can be turned down', await turnUntil('Length', short), await knobReads('Length'))

  await page.click('.export-panel .export-go')
  await settle(1500)

  // --- audition --------------------------------------------------------
  const takes = await page.evaluate(() => document.querySelectorAll('.take').length)
  check('every take is listed', takes === 3, `${takes} rows`)
  // Rendering must not write anything; saving is a separate, deliberate step.
  check('rendering wrote no files', readdirSync(downloads).length === 0, readdirSync(downloads).join(','))
  check('takes are kept by default', (await page.evaluate(() => document.querySelectorAll('.take.kept').length)) === 3)

  const waveforms = await page.evaluate(() =>
    [...document.querySelectorAll('.take .waveform path')].map((p) => (p.getAttribute('d') ?? '').length),
  )
  check('each take drew a waveform', waveforms.length === 3 && waveforms.every((n) => n > 100), waveforms.join(','))

  const meta = await page.evaluate(() => document.querySelector('.take-meta')?.textContent ?? '')
  check('a take reports its length and seed', /s .+ dB .+ seed/.test(meta), meta)

  // Playing needs a gesture, which the click supplies. These takes are short
  // -- a trimmed one-shot is a fraction of a second -- so the check has to
  // land before playback ends on its own.
  const isPlaying = () => page.evaluate(() => !!document.querySelector('.take.playing'))

  await page.click('.take .take-wave')
  await settle(60)
  check('clicking a waveform plays it', await isPlaying())

  await settle(600)
  check('it stops itself at the end', !(await isPlaying()))

  await page.click('.take .take-wave')
  await settle(60)
  check('it can be played again', await isPlaying())
  await page.click('.take .take-wave')
  await settle(60)
  check('clicking again stops it early', !(await isPlaying()))

  // Drop the middle take, then save what is left.
  await page.evaluate(() => document.querySelectorAll('.take-keep input')[1].click())
  await settle(200)
  check('a discarded take is excluded', (await page.evaluate(() => document.querySelectorAll('.take.kept').length)) === 2)

  await page.click('.take-panel .export-go')
  const zips = await waitForFile(downloads, '.zip')
  check('a zip was downloaded', zips.length === 1, zips.join(','))
  check('it is named after the patch', zips[0] === 'impact.zip', zips[0])

  if (zips.length) {
    const bytes = readFileSync(join(downloads, zips[0]))
    check('it has a zip signature', bytes[0] === 0x50 && bytes[1] === 0x4b)

    // Extract with something that did not write it.
    let extractError = null
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${join(downloads, zips[0])}' -DestinationPath '${extracted}' -Force`,
        ],
        { stdio: 'pipe' },
      )
    } catch (err) {
      extractError = err.stderr?.toString() || err.message
    }
    check('a real unzip accepts it', extractError === null, String(extractError).slice(0, 200))

    if (!extractError) {
      const wavs = readdirSync(extracted).filter((f) => f.endsWith('.wav')).sort()
      check('it holds only the kept takes', wavs.length === 2, wavs.join(', '))
      // Numbering follows the take, not its position in the zip, so a file
      // still matches the take it came from after some were discarded.
      check('numbering follows the take', wavs.join(',') === 'impact_01.wav,impact_03.wav', wavs.join(','))

      let good = 0
      let identical = 0
      let first = null
      for (const name of wavs) {
        const wav = readFileSync(join(extracted, name))
        const tag = (at) => wav.subarray(at, at + 4).toString('ascii')
        const ok =
          tag(0) === 'RIFF' &&
          tag(8) === 'WAVE' &&
          tag(12) === 'fmt ' &&
          wav.readUInt16LE(20) === 1 &&
          wav.readUInt16LE(22) === 2 &&
          wav.readUInt32LE(24) === 48000 &&
          wav.length > 44
        if (ok) good++
        const audio = wav.subarray(44).toString('base64')
        if (first === null) first = audio
        else if (audio === first) identical++
      }
      check('every wav parses', good === wavs.length, `${good}/${wavs.length}`)
      check('the takes are not copies of each other', identical === 0, `${identical} duplicates`)
    }
  }

  // --- takes belong to the track they were rendered from ---------------
  console.log('\ntakes belong to their track')
  const takeRows = () => page.evaluate(() => document.querySelectorAll('.take').length)

  // A render with takes on the panel asks first: they are not in undo.
  await page.click('.export-panel .export-go')
  await settle(150)
  const asks = await page.evaluate(() => document.querySelector('.export-panel .export-go')?.textContent)
  check('rendering over takes asks first', asks === 'Replace the takes?', asks)
  check('and has not thrown them away yet', (await takeRows()) === 3)
  await page.mouse.move(5, 5)
  await settle(100)

  // Renamed after rendering: the files are still called after the sound
  // the takes are of, as it was called then.
  if (!(await page.evaluate(() => !!document.querySelector('.dock-body')))) {
    await page.click('.dock-fold')
    await settle(200)
  }
  const nameField = await page.$('.track.on .track-name')
  await nameField.click({ clickCount: 3 })
  await page.keyboard.type('Renamed')
  await page.evaluate(() => document.activeElement?.blur())
  await settle(200)
  for (const f of readdirSync(downloads)) if (f.endsWith('.zip')) rmSync(join(downloads, f))
  await page.click('.take-panel .export-go')
  const again = await waitForFile(downloads, '.zip')
  check('downloads are named after the track the takes came from', again[0] === 'impact.zip', again.join(','))

  // Another track has its own recorder panel: no takes, and its own settings.
  await page.click('.track-add')
  await settle(400)
  check('a new track shows none of them', (await takeRows()) === 0, `${await takeRows()} rows`)
  // Through the search, Ctrl+K: the menu helper above is scoped to its own
  // section.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyK')
  await page.keyboard.up('Control')
  await settle(150)
  await page.keyboard.type('Recorder')
  await page.keyboard.press('Enter')
  await settle(300)
  check('its recorder starts from the defaults', (await knobReads('Takes')) === '8', await knobReads('Takes'))
  check('and still has no takes', (await takeRows()) === 0)

  // Back to the first: its takes and its settings are where they were left.
  for (const row of await page.$$('.track')) {
    const name = await row.$eval('.track-name', (i) => i.value)
    if (name === 'Renamed') await (await row.$('.track-db')).click()
  }
  await settle(400)
  check('the first track has its takes back', (await takeRows()) === 3, `${await takeRows()} rows`)
  check('and its settings', (await knobReads('Takes')) === '3', await knobReads('Takes'))

  // Discard asks, then goes.
  await page.click('.take-panel .panel-cancel')
  await settle(100)
  const discarding = await page.evaluate(() => document.querySelector('.take-panel .panel-cancel')?.textContent)
  check('one press on Discard only asks', (await takeRows()) === 3 && discarding === 'Discard all?', discarding)
  await page.click('.take-panel .panel-cancel')
  await settle(150)
  check('the second throws them away', (await takeRows()) === 0)
}

console.log('\nproblems    :', problems.length ? problems : 'none')
await browser.close()
rmSync(downloads, { recursive: true, force: true })

const ok = failures === 0 && problems.length === 0
console.log(ok ? '\nPASS' : `\nFAIL (${failures} check(s))`)
process.exit(ok ? 0 : 1)
