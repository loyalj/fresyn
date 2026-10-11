import { check, finish, flushAutosave, open, settle, waitUntil } from './harness.mjs'

/**
 * End-to-end check for sounds on the timeline: an audio file dropped on the
 * playlist becomes a sound, a clip of it and an audio track to play it on;
 * the clip is drawn as a waveform; the sound paints like a pattern without
 * taking the roll; and playing sends its clips to the audio thread.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1000 } })
// Every sound event the page sends the audio thread.
await page.evaluateOnNewDocument(() => {
  window.__sounds = []
  const Real = window.AudioWorkletNode
  window.AudioWorkletNode = class extends Real {
    constructor(...a) {
      super(...a)
      const post = this.port.postMessage.bind(this.port)
      this.port.postMessage = (msg, ...rest) => {
        if (msg?.type === 'schedule') for (const e of msg.events) if (String(e.kind).startsWith('sound')) window.__sounds.push(e)
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
const view = async (name) => {
  if (!(await page.$('.dock-toggle'))) {
    await page.click('.dock-fold')
    await settle(200)
  }
  await page.evaluate((n) => [...document.querySelectorAll('.dock-toggle')].find((b) => b.textContent.trim() === n)?.click(), name)
  await settle(300)
}

/** Drop a second of a 220 Hz tone, as a WAV file, on the playlist at a bar and lane. */
const drop = (bar, lane) =>
  page.evaluate(
    ({ bar, lane }) => {
      const rate = 48000
      const n = rate
      const buf = new ArrayBuffer(44 + n * 2)
      const v = new DataView(buf)
      const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
      str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
      str(36, 'data'); v.setUint32(40, n * 2, true)
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 0.5 * (1 - i / n) * 32767), true)
      const file = new File([buf], 'Guard line.wav', { type: 'audio/wav' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const layer = document.querySelector('.playlist-layer')
      const r = layer.getBoundingClientRect()
      const bars = [...document.querySelectorAll('.playlist-ruler [data-bar], .playlist-bar')]
      const barW = parseFloat(getComputedStyle(document.querySelector('.playlist-meter')).getPropertyValue('--bar-w')) || 64
      const x = r.left + bar * barW + 4
      const y = r.top + lane * 24 + 12
      for (const type of ['dragenter', 'dragover', 'drop']) {
        layer.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
      }
      return bars.length
    },
    { bar, lane },
  )

console.log('\ndropping a file')
{
  await view('Song')
  check('the playlist is showing', !!(await page.$('.playlist-layer')))
  await drop(1, 1)
  check('a clip appears', await waitUntil(page, () => !!document.querySelector('.playlist-clip.sound'), { timeout: 10000 }))
  const project = await saved()
  const sound = project.song.patterns.find((p) => p.audio)
  check('a sound, named for the file', sound?.name === 'Guard line', JSON.stringify(sound))
  const track = project.song.tracks.find((t) => t.id === sound?.audio.track)
  check('on a new audio track, also named for it', track?.name === 'Guard line')
  check('whose rack is a Clips module', project.racks?.[track?.id]?.patch.modules.some((m) => m.type === 'clips'))
  const clip = project.song.playlist.find((c) => c.pattern === sound?.id)
  check('the clip is where it was dropped', clip?.lane === 1 && clip?.tick > 0, JSON.stringify(clip))
  check('two beats long at 120: one second', sound?.length === 1920, `${sound?.length}`)
  check('drawn as a waveform', await waitUntil(page, () => {
    const pts = document.querySelector('.playlist-clip.sound polygon')?.getAttribute('points') ?? ''
    return pts.split(' ').some((p) => Number(p.split(',')[1]) < 0.9)
  }))
  check('and listed as a sound', !!(await page.$('.playlist-pattern.sound .playlist-sound-mark')))
}

console.log('\npainting it')
{
  const before = (await saved()).song.playlist.length
  await page.click('.playlist-pattern.sound .playlist-name')
  await settle(100)
  check('picking it lights it', !!(await page.$('.playlist-pattern.sound.on')))
  const r = await page.$eval('.playlist-layer', (el) => el.getBoundingClientRect().toJSON())
  await page.mouse.click(r.left + 300, r.top + 3 * 24 + 12)
  const project = await saved()
  const sound = project.song.patterns.find((p) => p.audio)
  check('a click paints another clip of it', project.song.playlist.length === before + 1 && project.song.playlist.at(-1).pattern === sound.id)
  await view('Roll')
  const opts = await page.$$eval('.dock-group[aria-label="Pattern"] select option', (os) => os.map((o) => o.textContent.trim()))
  check('the roll still writes into a pattern, and does not offer the sound', !opts.includes('Guard line') && opts.length >= 2, JSON.stringify(opts))
  check('the audio track is marked as one', !!(await page.$('.track .track-kind[title^="An audio track"]')))
}

console.log('\nplaying')
{
  await view('Song')
  await page.click('.dock-play')
  check('the audio thread is told to play the sound', await waitUntil(page, () => window.__sounds.some((e) => e.kind === 'sound' || (e.kind === 'soundSync' && e.voices.length)), { timeout: 5000 }),
    JSON.stringify(await page.evaluate(() => window.__sounds.slice(0, 4))))
  await page.click('.dock-play')
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
}

console.log('\nkept')
{
  await page.reload({ waitUntil: 'networkidle0' })
  await view('Song')
  check('the sound comes back with the project, waveform and all', await waitUntil(page, () => {
    const pts = document.querySelector('.playlist-clip.sound polygon')?.getAttribute('points') ?? ''
    return pts.split(' ').some((p) => Number(p.split(',')[1]) < 0.9)
  }, { timeout: 10000 }))
}

await finish()
