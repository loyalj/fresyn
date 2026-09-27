/**
 * Drives the Sampler in a real browser, end to end.
 *
 * The one module whose work happens outside the rack: a file is chosen,
 * hashed, stored in IndexedDB, decoded, drawn, handed to the worklet and
 * played. Every one of those links can break on its own and still leave a
 * panel that looks right, so this one puts a real WAV through a real file
 * input and then reads back what the page did with it -- the waveform it
 * drew, what the patch says it is pointed at, and whether the audio survives
 * a reload with nothing dropped on it a second time.
 *
 * Needs `npm run dev -- --port 5199` in another terminal.
 * Point CHROME_PATH at a Chromium build if the default is wrong.
 */
import puppeteer from 'puppeteer-core'
import { join } from 'node:path'
import { writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'

const CHROME =
  process.env.CHROME_PATH ||
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
const URL = process.env.DEV_URL || 'http://localhost:5199/'
const FLIP_SETTLE = 700

/** A short stereo hit, written where the page's file input can reach it. */
function writeWav() {
  const rate = 44100
  const frames = Math.round(rate * 0.4)
  const bytes = Buffer.alloc(44 + frames * 4)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(36 + frames * 4, 4)
  bytes.write('WAVE', 8)
  bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * 4, 28)
  bytes.writeUInt16LE(4, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(frames * 4, 40)
  for (let i = 0; i < frames; i++) {
    const t = i / rate
    const decay = Math.exp(-t * 8)
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 300 * t) * decay * 0.8 * 32767), 44 + i * 4)
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 450 * t) * decay * 0.8 * 32767), 46 + i * 4)
  }
  const dir = mkdtempSync(join(tmpdir(), 'fresyn-'))
  const path = join(dir, 'hit.wav')
  writeFileSync(path, bytes)
  return path
}

const wav = writeWav()

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 2200 })

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
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms))

await page.goto(URL, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

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

console.log('\nadding a sampler')
{
  check('the Sampler is in the Modules menu', await addModule('Sampler'))
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('.unit-id')].map((e) => e.textContent),
  )
  check('it arrives on the rack', ids.includes('smp1'), ids.join(', '))
  check(
    'it opens asking for a file',
    await page.evaluate(() => !!document.querySelector('[data-module="smp1"] .sampler-empty')),
  )
}

console.log('\nloading a file')
{
  const input = await page.$('[data-module="smp1"] .sampler-file')
  check('the panel has a file input to drive', !!input)
  if (input) {
    await input.uploadFile(wav)
    // Hashing, storing and decoding are all asynchronous.
    await settle(1200)
  }

  const drawn = await page.evaluate(() => {
    const path = document.querySelector('[data-module="smp1"] .sampler-trace')
    return path?.getAttribute('d')?.length ?? 0
  })
  check('a waveform is drawn', drawn > 400, `${drawn} chars of path`)

  const caption = await page.evaluate(
    () => document.querySelector('[data-module="smp1"] .sampler-caption')?.textContent ?? '',
  )
  check('the caption names the file', caption.includes('hit.wav'), caption)
  check('and says how long it is', caption.includes('0.40 s'), caption)
  check('and that it is stereo', caption.includes('stereo'), caption)
}

console.log('\nit reaches the audio thread')
{
  // Patch it to the mixer and play it: the meters are driven from the audio
  // thread, so a bar that moves is the sample arriving in the worklet.
  await page.keyboard.press('Tab')
  await settle(FLIP_SETTLE)
  const centre = (m, p) =>
    page.evaluate(
      (mod, port) => {
        const el = document.querySelector(`.jack[data-module="${mod}"][data-port="${port}"]`)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      },
      m,
      p,
    )

  const from = await centre('smp1', 'l')
  const to = await centre('mix1', 'in2')
  check('both jacks were found', !!from && !!to)
  if (from && to) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    await settle(200)
  }
  await page.keyboard.press('Tab')
  await settle(FLIP_SETTLE)

  // Its own Trigger button, so nothing else in the rack is sounding.
  const trigger = await page.evaluate(() => {
    const el = document.querySelector('[data-module="smp1"] .trigger')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  check('the panel has a trigger', !!trigger)

  const fill = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.strip-meter-fill')].map((e) => {
        const m = /inset\(([\d.]+)%/.exec(e.style.clipPath || '')
        return m ? 1 - Number(m[1]) / 100 : 0
      }),
    )

  if (trigger) {
    await page.mouse.move(trigger.x, trigger.y)
    await page.mouse.down()
    await settle(500)
    const sounding = await fill()
    await page.mouse.up()
    check('playing it moves a meter', sounding.some((v) => v > 0.05), `[${sounding.map((v) => v.toFixed(2))}]`)
  }
}

console.log('\nsurviving a reload')
{
  await page.reload({ waitUntil: 'networkidle0' })
  await settle(1500)

  const back = await page.evaluate(() => {
    const path = document.querySelector('[data-module="smp1"] .sampler-trace')
    const caption = document.querySelector('[data-module="smp1"] .sampler-caption')?.textContent ?? ''
    return { drawn: path?.getAttribute('d')?.length ?? 0, caption }
  })
  check('the module comes back with its file', back.drawn > 400, `${back.drawn} chars`)
  check('named, without dropping it again', back.caption.includes('hit.wav'), back.caption)
}

console.log('\nexporting and importing the rack')
{
  // Downloads go to a directory this script can read, so the file the menu
  // produces is the file that goes back in.
  const downloads = mkdtempSync(join(tmpdir(), 'fresyn-out-'))
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })

  const menuItem = async (menu, item) => {
    const mh = await page.evaluateHandle(
      (m) => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === m),
      menu,
    )
    const mel = mh.asElement()
    if (!mel) return false
    await mel.click()
    await settle(150)
    const ih = await page.evaluateHandle(
      (i) =>
        [...document.querySelectorAll('.menu-item .menu-text')].find(
          (e) => e.textContent.trim() === i,
        ) ?? null,
      item,
    )
    const iel = ih.asElement()
    if (!iel) {
      await page.keyboard.press('Escape')
      return false
    }
    await iel.click()
    await settle(400)
    return true
  }

  check('the Patch menu saves a patch', await menuItem('Patch', 'Save patch...'))

  // The write is asynchronous, and Chrome renames a .crdownload when it lands.
  let bundle = null
  for (let i = 0; i < 40 && !bundle; i++) {
    const found = readdirSync(downloads).filter((f) => f.endsWith('.zip'))
    if (found.length) bundle = join(downloads, found[0])
    else await settle(100)
  }
  check('a rack with audio exports as a bundle', !!bundle, bundle ? bundle.split(/[\\/]/).pop() : 'nothing downloaded')

  if (bundle) {
    const size = statSync(bundle).size
    // The WAV alone is 70.6 kB -- 0.4 s, stereo, 16-bit, 44.1 kHz -- and the
    // patch beside it is a couple of kilobytes, so a bundle that had somehow
    // been written without its audio would be a thirtieth of this.
    check('with the audio inside it', size > 60000, `${(size / 1024).toFixed(0)} kB`)

    // Wipe every trace of the sample: local storage for the patch, IndexedDB
    // for the audio. Whatever comes back after this came out of the file.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          localStorage.clear()
          const request = indexedDB.deleteDatabase('fresyn')
          request.onsuccess = () => resolve(null)
          request.onerror = () => resolve(null)
          request.onblocked = () => resolve(null)
        }),
    )
    await page.reload({ waitUntil: 'networkidle0' })
    await settle(600)

    const wiped = await page.evaluate(() =>
      [...document.querySelectorAll('.unit-id')].map((e) => e.textContent),
    )
    check('the rack is back to stock', !wiped.includes('smp1'), wiped.join(', '))

    const patchInput = await page.$('.patch-file')
    check('the patch input takes a file', !!patchInput)
    if (patchInput) {
      await patchInput.uploadFile(bundle)
      await settle(1500)
    }

    const restored = await page.evaluate(() => {
      const path = document.querySelector('[data-module="smp1"] .sampler-trace')
      const caption =
        document.querySelector('[data-module="smp1"] .sampler-caption')?.textContent ?? ''
      return { drawn: path?.getAttribute('d')?.length ?? 0, caption }
    })
    check('the bundle brings the rack back', restored.drawn > 400, `${restored.drawn} chars of path`)
    check(
      'with audio that was not in this browser a moment ago',
      restored.caption.includes('hit.wav'),
      restored.caption,
    )
  }
}

console.log('\nproblems    :', problems.length ? problems : 'none')
await browser.close()

const ok = failures === 0 && problems.length === 0
console.log(ok ? '\nPASS' : `\nFAIL (${failures} check(s))`)
process.exit(ok ? 0 : 1)
