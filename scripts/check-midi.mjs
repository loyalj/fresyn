import { check, finish, open, settle, waitUntil } from './harness.mjs'

/**
 * End-to-end check for controller mapping: a pretend controller is plugged
 * in through a stand-in for Web MIDI, a knob, a button and a track's mute are
 * learnt by clicking them and moving a control, and the mapped controls then
 * move them -- the knob only once it has picked the value up. The mappings
 * are kept across a reload, and a click while learning never turns a knob.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1300, height: 1000 } })

// One controller, "Test Pad": its input, whose messages the check sends with
// __midi.send, and its output, whose messages from the page land in __midi.out.
await page.evaluateOnNewDocument(() => {
  const port = { name: 'Test Pad', state: 'connected', onmidimessage: null }
  const out = { name: 'Test Pad', state: 'connected', send: (data) => window.__midi.out.push([...data]) }
  const access = { inputs: new Map([['pad', port]]), outputs: new Map([['pad', out]]), onstatechange: null }
  navigator.requestMIDIAccess = () => Promise.resolve(access)
  window.__midi = { send: (bytes) => port.onmidimessage?.({ data: new Uint8Array(bytes) }), out: [] }
})
await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })

const send = async (...messages) => {
  for (const m of messages) {
    await page.evaluate((b) => window.__midi.send(b), m)
    await settle(30)
  }
}
const cc = (number, value, channel = 1) => [0xb0 | (channel - 1), number, value]

const menu = async (label, item) => {
  const bar = await page.evaluateHandle(
    (t) => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === t),
    label,
  )
  await bar.asElement().click()
  await settle(120)
  const row = await page.evaluateHandle(
    (t) => [...document.querySelectorAll('.menu-item .menu-text')].find((e) => e.textContent.trim() === t),
    item,
  )
  await row.asElement().click()
  await settle(150)
}
const rows = () => page.$$eval('.midi-maps tr', (trs) => trs.map((tr) => tr.textContent))
const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.prefs.v1') ?? '{}'))

// The filter's first knob: what it is, and where it stands.
const KNOB = '.unit-flip[data-module="lpf1"] .knob[data-midi-param]'
const param = await page.$eval(KNOB, (el) => el.dataset.midiParam)
const knob = () =>
  page.$eval(`${KNOB} svg`, (svg) => ({
    now: Number(svg.getAttribute('aria-valuenow')),
    min: Number(svg.getAttribute('aria-valuemin')),
    max: Number(svg.getAttribute('aria-valuemax')),
  }))

console.log('\nlearning')
{
  await menu('Edit', 'MIDI learn')
  await waitUntil(page, () => document.body.classList.contains('midi-learning'))
  check('MIDI learn turns MIDI on, opens the panel and starts learning', !!(await page.$('.midi-panel')))
  check('the controller is listed', /Test Pad/.test(await page.$eval('.midi-status', (e) => e.textContent)))

  const before = await knob()
  const box = await (await page.$(`${KNOB} svg`)).boundingBox()
  // A press and a drag that would turn the knob, if the click were let through.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y - 60, { steps: 5 })
  await page.mouse.up()
  await settle(150)
  check('picking a knob does not turn it', (await knob()).now === before.now)
  check('the knob picked is lit', await page.$eval(KNOB, (e) => e.hasAttribute('data-midi-armed')))
  check('and the panel says what it is waiting for', /Now move a control/.test(await page.$eval('.midi-hint', (e) => e.textContent)))

  await send(cc(21, 30), cc(21, 32), cc(21, 35))
  await waitUntil(page, () => document.querySelectorAll('.midi-maps tr').length === 1, { timeout: 3000 })
  const [row] = await rows()
  check('moving a control maps it onto the knob', /CC 21/.test(row) && row.includes('lpf1'), row)
  check('as a knob with ends', (await page.$eval('.midi-maps select', (s) => s.value)) === 'absolute')

  await page.click('.dock-play')
  await settle(100)
  check('picking Play does not play', !(await page.$('.dock-play.on')))
  await send(cc(30, 127), cc(30, 0))
  await waitUntil(page, () => document.querySelectorAll('.midi-maps tr').length === 2, { timeout: 3000 })
  const playRow = (await rows()).find((r) => /CC 30/.test(r)) ?? ''
  check('a button is learnt onto Play', /Play/.test(playRow), playRow)

  await page.keyboard.press('Escape')
  await settle(100)
  check('Escape stops learning and leaves the panel open', !(await page.evaluate(() => document.body.classList.contains('midi-learning'))) && !!(await page.$('.midi-panel')))
}

console.log('\nplaying the mapped controls')
{
  const start = await knob()
  const t = (v) => (v - start.min) / (start.max - start.min)
  // The knob is somewhere in its travel; a slider at the far end from it has
  // not picked it up.
  const far = t(start.now) > 0.5 ? 0 : 127
  await send(cc(21, far))
  check('a slider standing elsewhere does not move the knob', (await knob()).now === start.now)
  check('the monitor says why', /pick it up/.test(await page.$eval('.midi-monitor', (e) => e.textContent)))
  await send(cc(21, 127 - far))
  const crossed = await knob()
  check('passing the value picks it up and moves it', crossed.now !== start.now && (far === 0 ? crossed.now === crossed.max : crossed.now === crossed.min), JSON.stringify(crossed))
  await send(cc(21, 64))
  check('and it follows from then on', (await knob()).now !== crossed.now)
  await settle(200)
  check('a mapped knob wears a badge naming its control while the controller is there',
    (await page.$eval(KNOB, (el) => el.getAttribute('data-midi-badge'))) === 'CC21')

  await send(cc(30, 127), cc(30, 0))
  await waitUntil(page, () => !!document.querySelector('.dock-play.on'), { timeout: 3000 }).catch(() => {})
  check('the button plays', !!(await page.$('.dock-play.on')))
  await send(cc(30, 127), cc(30, 0))
  await settle(150)
  check('and stops', !(await page.$('.dock-play.on')))
}

console.log('\na track\'s mute, by its place in the list')
{
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyM')
  await page.keyboard.up('Control')
  await settle(300)
  const mute = await page.$('.track [data-midi-param="mute"]')
  check('the track list is showing', !!mute)
  if (mute) {
    await menu('Edit', 'MIDI learn')
    await waitUntil(page, () => document.body.classList.contains('midi-learning'))
    await mute.click()
    await settle(100)
    check('picking Mute does not mute', !(await page.$('.track [data-midi-param="mute"].on')))
    await send([0x99, 36, 100], [0x89, 36, 0])
    await waitUntil(page, () => document.querySelectorAll('.midi-maps tr').length === 3, { timeout: 3000 })
    const row = (await rows()).find((r) => /Note C2/.test(r)) ?? ''
    check('a pad sending a note is learnt onto it, as a button', /Mute/.test(row) && /ch 10/.test(row), row)
    await page.keyboard.press('Escape')
    await send([0x99, 36, 100], [0x89, 36, 0])
    await settle(150)
    check('the pad mutes the first track', !!(await page.$('.track [data-midi-param="mute"].on')))
    await send([0x99, 36, 100], [0x89, 36, 0])
    await settle(150)
    check('and unmutes it', !(await page.$('.track [data-midi-param="mute"].on')))
  }
}

console.log('\nkept')
{
  const kept = (await prefs()).midiMappings ?? []
  check('the mappings are kept with this machine', kept.length === 3, JSON.stringify(kept))
  await page.reload({ waitUntil: 'networkidle0' })
  await menu('Edit', 'MIDI controllers')
  await waitUntil(page, () => document.querySelectorAll('.midi-maps tr').length === 3, { timeout: 3000 }).catch(() => {})
  check('and listed again after a reload', (await rows()).length === 3)
  const forget = await page.$('.midi-maps tr button')
  await forget.click()
  await settle(150)
  check('a mapping can be forgotten', (await rows()).length === 2 && ((await prefs()).midiMappings ?? []).length === 2)
}

console.log('\nimporting a MIDI file')
{
  // A two-part file: an electric piano with a volume ride, and drums.
  const vl = (n) => {
    const out = [n & 0x7f]
    while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80)
    return out
  }
  const trk = (events) => {
    const body = events.flat()
    return [0x4d, 0x54, 0x72, 0x6b, 0, 0, (body.length >> 8) & 255, body.length & 255, ...body]
  }
  const name = (s) => [0, 0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))]
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, 0x01, 0xe0,
    ...trk([[0, 0xff, 0x51, 3, 0x08, 0x52, 0xae], [0, 0xff, 0x06, 4, 0x4c, 0x6f, 0x6f, 0x70], [0, 0xff, 0x2f, 0]]),
    ...trk([name('Keys'), [0, 0xc0, 4], [0, 0xb0, 7, 120], [0, 0x90, 60, 100], [...vl(480), 0x80, 60, 0], [0, 0xb0, 7, 60], [0, 0x90, 64, 90], [...vl(480), 0x80, 64, 0], [0, 0xff, 0x2f, 0]]),
    ...trk([name('Beat'), [0, 0x99, 36, 110], [...vl(240), 0x89, 36, 0], [...vl(240), 0x99, 38, 100], [...vl(240), 0x89, 38, 0], [0, 0xff, 0x2f, 0]]),
  ]
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const path = join(mkdtempSync(join(tmpdir(), 'fresyn-midi-')), 'Groove.mid')
  writeFileSync(path, Buffer.from(bytes))

  const project = async () => {
    await settle(600)
    return page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}'))
  }
  const upload = async () => {
    const input = await page.$('input[type=file][accept*=".mid"]')
    await input.uploadFile(path)
    await waitUntil(page, () => !!document.querySelector('.midi-import'), { timeout: 3000 }).catch(() => {})
  }
  const press = (text) => page.evaluate((t) => [...document.querySelectorAll('.midi-import button')].find((b) => b.textContent.includes(t))?.click(), text)

  check('Project offers Import MIDI', await page.evaluate(() => [...document.querySelectorAll('.menubar-label')].some((b) => b.textContent.trim() === 'Project')))
  await upload()
  check('a MIDI file is read and its parts listed', (await page.$$eval('.midi-import-parts li', (li) => li.map((x) => x.textContent))).join('|').match(/Keys.*Electric Piano 1.*2 notes\|Beat.*Drum Kit.*2 notes/) !== null)
  await press('Open as new project')
  const opened = await project()
  check('opened as a new project, named for the file', opened.name === 'Groove' && opened.song.tracks.map((t) => t.name).join() === 'Keys,Beat', JSON.stringify(opened.song?.tracks?.map((t) => t.name)))
  check('at the file\'s tempo, with its marker as a section', Math.round(opened.song.tempo) === 110 && opened.song.sections?.[0]?.name === 'Loop')
  check('each part a pattern on its own lane', opened.song.patterns.length === 2 && opened.song.playlist.length === 2)
  check('the drums on a Drum Kit, the keys on a voice from the library',
    opened.racks[opened.song.tracks[1].id].modules?.some?.((m) => m.type === 'kit') ?? JSON.stringify(opened.racks[opened.song.tracks[1].id]).includes('"kit"'))
  check('the volume ride is a lane on the keys\' strip', opened.song.patterns[0].automation?.[0]?.target === `strip/${opened.song.tracks[0].id}/gain`)

  await upload()
  await press('Add at bar')
  const both = await project()
  check('added to the project, its tracks join the song\'s', both.song.tracks.length === 4 && both.song.tempo === opened.song.tempo, String(both.song.tracks.length))
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  check('and the adding is one step of undo', (await project()).song.tracks.length === 2)
}

console.log('\nDAW mode: a Mackie Control surface')
{
  if (!(await page.$('.midi-panel'))) await menu('Edit', 'MIDI controllers')
  await waitUntil(page, () => !!document.querySelector('.midi-devices input'), { timeout: 3000 }).catch(() => {})
  await page.evaluate(() => { window.__midi.out = [] })
  await page.click('.midi-devices input')
  await settle(500)
  const out = () => page.evaluate(() => window.__midi.out)
  const first = await out()
  check('switched on, the surface is told how things stand', first.some((m) => m[0] === 0xe0) && first.some((m) => m[0] === 0x90 && m[1] === 24 && m[2] === 0x7f), JSON.stringify(first).slice(0, 200))
  check('the panel says what the strips are', /Strips are tracks 1–8/.test(await page.$eval('.midi-panel', (e) => e.textContent)))
  await settle(300)
  check('and the tracks under the strips are marked in the track list', !!(await page.$('.track[data-mcu-strip="1"]')))

  const doc = async () => {
    await settle(600)
    return page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}').song)
  }
  const tracks = (await doc()).tracks
  await page.evaluate(() => { window.__midi.out = [] })
  await send([0x90, 16, 127], [0x90, 16, 0])
  const muted = await doc()
  check('Mute on strip 1 mutes track 1', muted.tracks[0].mute === true)
  check('and lights its button', (await out()).some((m) => m[0] === 0x90 && m[1] === 16 && m[2] === 0x7f))
  await send([0x90, 16, 127], [0x90, 16, 0])
  check('and again unmutes it', !(await doc()).tracks[0].mute)

  await send([0x90, 25, 127], [0x90, 25, 0])
  const selected = await page.$eval('.track.on', (e) => e.dataset.track)
  check('Select on strip 2 puts track 2 on the bench', selected === tracks[1].id, `${selected} vs ${tracks[1].id}`)

  // The fader: track 1 is at 0 dB, about nine tenths of the way up.
  const at = (p) => { const v = Math.round(p * 16383); return [0xe0, v & 0x7f, v >> 7] }
  await send(at(0.2))
  check('a fader standing low does not drag a loud track down', (await doc()).tracks[0].gain === tracks[0].gain)
  await send(at(0.95), at(0.5))
  const faded = (await doc()).tracks[0].gain
  check('once it passes the level it takes it', faded < 0.2 && faded > 0, String(faded))
  await send([0xb0, 16, 0x45])
  check('a knob turned left pans its track left', ((await doc()).tracks[0].strip?.pan ?? 0) < 0)

  await page.evaluate(() => { window.__midi.out = [] })
  await send([0x90, 94, 127], [0x90, 94, 0])
  await waitUntil(page, () => !!document.querySelector('.dock-play.on'), { timeout: 3000 }).catch(() => {})
  check('Play plays', !!(await page.$('.dock-play.on')))
  await settle(400)
  check('and lights Play', (await out()).some((m) => m[0] === 0x90 && m[1] === 94 && m[2] === 0x7f))
  await send([0x90, 93, 127], [0x90, 93, 0])
  await settle(300)
  check('Stop stops', !(await page.$('.dock-play.on')))

  await send([0x90, 0, 127], [0x90, 0, 0])
  await waitUntil(page, () => !!document.querySelector('.roll-rec.on'), { timeout: 3000 }).catch(() => {})
  check('R on strip 1 puts track 1 on the bench and arms ● Rec', !!(await page.$('.roll-rec.on')) && (await page.$eval('.track.on', (e) => e.dataset.track)) === tracks[0].id)
  await settle(400)
  check('and lights its R and Record', (await out()).some((m) => m[1] === 0 && m[2] === 0x7f) && (await out()).some((m) => m[1] === 95 && m[2] === 0x7f))
  await send([0x90, 95, 127], [0x90, 95, 0])
  await send([0x90, 93, 127], [0x90, 93, 0])
  await settle(300)
  check('Record and Stop end it', !(await page.$('.roll-rec.on')) && !(await page.$('.dock-play.on')))

  check('the monitor says what each did', /DAW mode · Stop/.test(await page.$eval('.midi-monitor', (e) => e.textContent)))
  check('DAW mode is kept with this machine', JSON.stringify((await prefs()).mcuDevices) === JSON.stringify(['Test Pad']))
}

await finish()
