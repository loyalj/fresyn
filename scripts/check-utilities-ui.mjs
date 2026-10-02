import { check, finish, flushAutosave, open, settle as wait, waitUntil } from './harness.mjs'

/**
 * End-to-end check for the Utilities menu and the Timing utility: opened from
 * the menu bar, worked with the song still usable around it, dragged, closed
 * with Escape, and found as it was left after a reload. Then the others: the
 * metronome counted, the converter worked, a key explored and set, a
 * progression and a rhythm written into the pattern.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
const { page, url } = await open({ viewport: { width: 1400, height: 1000 } })
// Counts audio contexts: the rack opens one the first time it is played, so a
// Space that reached it instead of the tap pad would show up here.
await page.evaluateOnNewDocument(() => {
  window.__contexts = 0
  window.__tones = 0
  const Real = window.AudioContext
  window.AudioContext = class extends Real {
    constructor(...a) {
      super(...a)
      window.__contexts++
    }
    // A metronome's click and a test tone are each an oscillator; the rack
    // makes none, so this counts what the utilities sound.
    createOscillator() {
      window.__tones++
      return super.createOscillator()
    }
  }
})
const context = page.browser().defaultBrowserContext()
await context.overridePermissions(new URL(url).origin, ['clipboard-read', 'clipboard-write']).catch(() => {})
await page.goto(url, { waitUntil: 'networkidle0' })
// A clean start: no utility left open from a run before.
await page.evaluate(() => localStorage.removeItem('fresyn.prefs.v1'))
await page.reload({ waitUntil: 'networkidle0' })

const panel = () => page.$('.utility-panel')

async function openTiming() {
  const menu = (
    await page.evaluateHandle(() =>
      [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Utilities'),
    )
  ).asElement()
  if (!menu) return false
  await menu.click()
  await wait(120)
  const item = (
    await page.evaluateHandle(
      () => [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.includes('Timing')) ?? null,
    )
  ).asElement()
  if (!item) return false
  await item.click()
  await waitUntil(page, () => !!document.querySelector('.utility-panel .timing'), { timeout: 5000 }).catch(() => {})
  return !!(await panel())
}

/** Type into a field in the panel and commit it, as a person would. */
async function type(selector, text) {
  const el = await page.$(selector)
  await el.click({ clickCount: 3 })
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await wait(60)
}

const text = (selector) => page.$eval(selector, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '')

console.log('\nthe menu')
{
  check('the Utilities menu opens the Timing panel', await openTiming())
  check('titled Timing', (await text('.utility-head h2')) === 'Timing')
  check('the rest of the app is not behind a backdrop', !(await page.$('.sheet-backdrop')))
}

console.log('\nsong length')
{
  await type('.timing-row input[aria-label^="Tempo"]', '120')
  await page.select('.timing-sig select', '4')
  await type('.timing-row input[aria-label="Beats in a bar"]', '4')
  await type('.timing-duration', '3:00')
  check('three minutes at 120 in 4/4 is 90 bars', (await text('.timing-answer strong')) === '90 bars', await text('.timing-answer'))

  await type('.timing-duration', '101')
  check('a length that is not whole bars says what is over', (await text('.timing-answer')).startsWith('50 bars and 2 beats'), await text('.timing-answer'))

  await type('.timing-row input[aria-label="Bars"]', '96')
  check('bars back to a length', (await page.$eval('.timing-duration', (e) => e.value)) === '3:12')

  await page.select('.timing-sig select', '8')
  await type('.timing-row input[aria-label="Beats in a bar"]', '6')
  await type('.timing-duration', '3:00')
  check('6/8 at 120 counts quarter notes: 120 bars in three minutes', (await text('.timing-answer strong')) === '120 bars', await text('.timing-answer'))
  await page.select('.timing-sig select', '4')
  await type('.timing-row input[aria-label="Beats in a bar"]', '4')
}

console.log('\nsections')
{
  const clickButton = async (label) => {
    const b = (
      await page.evaluateHandle(
        (l) => [...document.querySelectorAll('.timing-sections-head button')].find((x) => x.textContent.trim() === l),
        label,
      )
    ).asElement()
    await b.click()
    await wait(60)
  }
  await clickButton('Typical song')
  const rows = await page.$$eval('.timing-plan tbody tr', (r) => r.length)
  check('a typical song fills in eight sections', rows === 8, `${rows}`)
  check('they add up to 88 bars', (await text('.timing-plan tfoot td')) === '88', await text('.timing-plan tfoot'))
  check('two bars short of three minutes', (await text('.timing-budget')).startsWith('2 bars to go'), await text('.timing-budget'))

  // Keys typed into a panel stay in it: F flips the rack everywhere else.
  const flippedBefore = await page.evaluate(() => !!document.querySelector('.unit-flip.flipped'))
  const name = await page.$('.timing-plan tbody tr input[type="text"]')
  await name.click({ clickCount: 3 })
  await page.keyboard.type('Fanfare')
  await wait(100)
  const flippedAfter = await page.evaluate(() => !!document.querySelector('.unit-flip.flipped'))
  check('typing a name does not play the rack', flippedBefore === flippedAfter)
  check('and the name is taken', (await page.$eval('.timing-plan tbody tr input[type="text"]', (e) => e.value)) === 'Fanfare')

  await type('.timing-plan tbody tr:first-child input[type="number"]', '10')
  check('a longer intro takes the budget to exactly three minutes', (await text('.timing-budget')) === 'Exactly 3:00.')
  await type('.timing-plan tbody tr:first-child input[type="number"]', '12')
  check('and past it', (await text('.timing-budget')).startsWith('2 bars over'), await text('.timing-budget'))
}

console.log('\nnote lengths')
{
  const tab = (await page.evaluateHandle(() => [...document.querySelectorAll('.timing-tabs button')].find((b) => b.textContent === 'Note lengths'))).asElement()
  await tab.click()
  await wait(80)
  const cell = async (note, column) =>
    page.evaluate(
      (n, c) => {
        const row = [...document.querySelectorAll('.timing-notes tbody tr')].find((r) => r.querySelector('th')?.textContent.trim() === n)
        return row?.querySelectorAll('td')[c]?.textContent.trim() ?? ''
      },
      note,
      column,
    )
  check('a quarter at 120 is 500 ms', (await cell('1/4', 0)) === '500')
  check('a dotted eighth is 375 ms', (await cell('1/8', 1)) === '375')
  check('an eighth triplet is 166.67 ms', (await cell('1/8', 2)) === '166.67')

  const quarter = (await page.evaluateHandle(() => {
    const row = [...document.querySelectorAll('.timing-notes tbody tr')].find((r) => r.querySelector('th')?.textContent.trim() === '1/4')
    return row.querySelector('td button')
  })).asElement()
  await quarter.click()
  await wait(100)
  check('clicking a value copies it', (await text('.timing-status')).includes('500'), await text('.timing-status'))

  const hz = (await page.evaluateHandle(() => [...document.querySelectorAll('.timing-units button')].find((b) => b.textContent === 'Hz'))).asElement()
  await hz.click()
  await wait(60)
  check('a sixteenth at 120 is 8 Hz', (await cell('1/16', 0)) === '8')
}

console.log('\ntap tempo')
{
  const song = async () => {
    await flushAutosave(page)
    return page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}').song ?? {})
  }
  const tab = (await page.evaluateHandle(() => [...document.querySelectorAll('.timing-tabs button')].find((b) => b.textContent === 'Tap tempo'))).asElement()
  await tab.click()
  await wait(100)
  check('the Tap tab gives the panel the focus', await page.evaluate(() => document.activeElement?.classList.contains('utility-panel')))

  // Space at about 100 BPM, as a hand would: down and up, 600 ms apart. The
  // test's own pace is not exact, so each press is timed where the page sees
  // it, and the reading is held to the pace actually tapped.
  await page.evaluate(() => {
    window.__taps = []
    window.addEventListener('keydown', (e) => e.code === 'Space' && !e.repeat && window.__taps.push(e.timeStamp), true)
  })
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Space')
    await wait(600)
  }
  const shown = await text('.timing-tapped strong')
  const bpm = parseFloat(shown)
  const tapped = await page.evaluate(() => {
    const t = window.__taps
    return 60000 / ((t[t.length - 1] - t[0]) / (t.length - 1))
  })
  check('eight taps of Space read as the pace they were tapped at', Math.abs(bpm - tapped) < 0.5, `${shown} for ${tapped.toFixed(2)}`)
  check('which was about 100', Math.abs(bpm - 100) < 5)
  check('Space tapped rather than playing the rack', (await page.evaluate(() => window.__contexts)) === 0)
  check('the tempo is the panel\'s tempo now', Math.abs(Number(await page.$eval('.timing-row input[aria-label^="Tempo"]', (e) => e.value)) - bpm) < 0.11)

  const before = (await song()).tempo
  const whole = Math.round(bpm)
  const click = async (label) => {
    const b = (await page.evaluateHandle((l) => [...document.querySelectorAll('.timing-apply button')].find((x) => x.textContent.trim() === l), label)).asElement()
    await b.click()
    await wait(120)
  }
  await click('From the start')
  check('From the start sets the song\'s opening tempo, as a whole number', (await song()).tempo === whole, `${(await song()).tempo}`)
  check('and says it can be taken back', (await text('.timing-apply .timing-status')).includes('Ctrl+Z'))

  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await wait(120)
  check('Ctrl+Z takes it back', (await song()).tempo === before, `${(await song()).tempo}`)

  await type('.timing-apply input[aria-label="Bar the tempo changes at"]', '5')
  await click('From bar')
  const changes = (await song()).tempos ?? []
  check('From bar 5 adds a tempo change at bar 5', changes.some((c) => c.tick === 4 * 3840 && c.bpm === whole), JSON.stringify(changes))
  check('and leaves the opening tempo alone', (await song()).tempo === before)
  check('the panel counts it as a change the start leaves alone', (await text('.timing-apply-row')).includes('1 later tempo change'))

  // Leaving the tab gives Space back to the rack.
  const lengthTab = (await page.evaluateHandle(() => [...document.querySelectorAll('.timing-tabs button')].find((b) => b.textContent === 'Song length'))).asElement()
  await lengthTab.click()
  await wait(80)
  check('only the Tap tab claims Space', await page.evaluate(() => !document.querySelector('.utility-panel[data-claims-keys]')))
  const notesTab = (await page.evaluateHandle(() => [...document.querySelectorAll('.timing-tabs button')].find((b) => b.textContent === 'Note lengths'))).asElement()
  await notesTab.click()
  await wait(80)
}

console.log('\nthe panel')
{
  const before = await page.$eval('.utility-panel', (e) => e.getBoundingClientRect().toJSON())
  const head = await page.$('.utility-head h2')
  const box = await head.boundingBox()
  await page.mouse.move(box.x + 10, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 190, box.y + box.height / 2 + 120, { steps: 6 })
  await page.mouse.up()
  await wait(80)
  const after = await page.$eval('.utility-panel', (e) => e.getBoundingClientRect().toJSON())
  check('dragged by its title', Math.abs(after.x - (before.x - 200)) <= 2 && Math.abs(after.y - (before.y + 120)) <= 2, `${before.x},${before.y} -> ${after.x},${after.y}`)

  // Escape from inside closes it, and nothing else.
  await (await page.$('.timing-units button')).focus()
  await page.keyboard.press('Escape')
  await wait(80)
  check('Escape inside it closes it', !(await panel()))

  await openTiming()
  check('it opens where it was left', await page.$eval('.utility-panel', (e, a) => Math.abs(e.getBoundingClientRect().x - a.x) <= 2, after))
  check('on the tab it was left on', (await text('.timing-tabs button.on')) === 'Note lengths')

  await page.reload({ waitUntil: 'networkidle0' })
  await waitUntil(page, () => !!document.querySelector('.utility-panel .timing'), { timeout: 5000 }).catch(() => {})
  check('a reload finds it still open', !!(await panel()))
  check('and the plan still there', (await page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.prefs.v1') ?? '{}').timing?.sections?.length)) === 8)
}

/** A utility opened from the Utilities menu by name; true once its panel is up. */
async function openUtility(name, selector) {
  const menu = (await page.evaluateHandle(() => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Utilities'))).asElement()
  await menu.click()
  await wait(120)
  const item = (await page.evaluateHandle((n) => [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.includes(n)) ?? null, name)).asElement()
  if (!item) return false
  await item.click()
  await waitUntil(page, (sel) => !!document.querySelector(sel), { timeout: 5000, args: [selector] }).catch(() => {})
  return !!(await page.$(selector))
}
const tones = () => page.evaluate(() => window.__tones)

console.log('\nmetronome')
{
  check('the Utilities menu opens the Metronome', await openUtility('Metronome', '.metronome'))
  await type('.metronome .metronome-bpm', '150')
  const before = await tones()
  await (await page.$('.metronome-go')).click()
  await wait(1300)
  const clicked = (await tones()) - before
  check('Start clicks at the tempo: about three in 1.3 s at 150', clicked >= 3 && clicked <= 5, `${clicked} clicks`)
  check('and the lamps follow it', !!(await page.$('.metronome-lamp.on, .metronome-lamp.sub')))
  check('the first beat is the marked one', !!(await page.$('.metronome-lamp.first')))

  // Space stops it, with the panel focused: its title clicked.
  await (await page.$$('.utility-panel')).at(-1).$('.utility-head h2').then((h) => h.click())
  await page.keyboard.press('Space')
  await wait(250)
  const stoppedAt = await tones()
  await wait(700)
  check('Space stops it while its panel has the focus', (await tones()) === stoppedAt, `${(await tones()) - stoppedAt} more`)
  check('and it says so', (await text('.metronome-go')) === 'Start')

  await page.keyboard.press('Space')
  await wait(500)
  check('and starts it again', (await text('.metronome-go')) === 'Stop')
  await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.utility-panel')].find((p) => p.querySelector('.metronome'))
    panel?.querySelector('.sheet-close')?.click()
  })
  await wait(250)
  const closedAt = await tones()
  await wait(700)
  check('closing the panel stops it', (await tones()) === closedAt && !(await page.$('.metronome')))
}

console.log('\nnotes and frequencies')
{
  check('the Utilities menu opens Notes & frequencies', await openUtility('Notes & frequencies', '.pitch'))
  const main = () => text('.pitch-main strong')
  await type('.pitch-input input', '261.63 Hz')
  check('261.63 Hz is middle C', (await main()) === 'C4', await main())
  await type('.pitch-input input', '445')
  check('445 Hz is an A4 a little sharp', (await main()).replace(/\s+/g, ' ') === 'A4 +19.6¢', await main())
  await type('.pitch-input input', 'Bb2')
  check('a note gives its frequency', (await text('.pitch-facts dd')).startsWith('116.54'), await text('.pitch-facts dd'))

  await type('.pitch .timing-row input[aria-label^="Reference"]', '432')
  await type('.pitch-input input', 'A4')
  check('a reference of 432 is honoured', (await text('.pitch-facts dd')).startsWith('432'))
  await type('.pitch .timing-row input[aria-label^="Reference"]', '440')

  const e4 = (await page.evaluateHandle(() => [...document.querySelectorAll('.pitch-key')].find((k) => k.textContent.startsWith('E4')))).asElement()
  await e4.click()
  await wait(80)
  check('a note in the octave can be picked', (await main()) === 'E4')

  await type('.pitch-transpose input', '12')
  check('twelve semitones up is twice the speed', (await text('.pitch-transpose')).includes('E5') && (await text('.pitch-transpose')).includes('Speed ×2'), await text('.pitch-transpose'))
  check('and the harmonics are listed', (await page.$$('.pitch .timing-table tbody tr')).length === 12)

  const before = await tones()
  await (await page.$('.pitch-play')).click()
  await wait(300)
  check('the play button sounds it', (await tones()) === before + 1)
}

/** The project as saved, flushed first. */
async function saved() {
  await flushAutosave(page)
  return page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.project.v1') ?? '{}'))
}
const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('fresyn.prefs.v1') ?? '{}'))
/** A button in a panel by its text. */
async function button(scope, label) {
  return (
    await page.evaluateHandle(
      (s, l) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent.replace(/\s+/g, ' ').trim() === l) ?? null,
      scope,
      label,
    )
  ).asElement()
}
async function closePanel(selector) {
  await page.evaluate((sel) => {
    const panel = [...document.querySelectorAll('.utility-panel')].find((p) => p.querySelector(sel))
    panel?.querySelector('.sheet-close')?.click()
  }, selector)
  await wait(150)
}

console.log('\nscales and chords')
{
  check('the Utilities menu opens Scales & chords', await openUtility('Scales & chords', '.scales'))
  await page.select('.scales select[aria-label="Key"]', '9')
  await page.select('.scales select[aria-label="Scale"]', 'minor')
  await wait(80)
  const names = await page.$$eval('.scales-chord .scales-name', (e) => e.map((x) => x.textContent).join(' '))
  check('A minor has Am Bdim C Dm Em F G', names === 'Am Bdim C Dm Em F G', names)
  check('and its seven notes lit on the keyboard', (await page.$$('.scales-key.in')).length === 7 * 2 + 1, `${(await page.$$('.scales-key.in')).length}`)
  check('the root marked on the circle', (await text('.scales-node.root text')) === 'A')

  const before = await tones()
  await (await page.$$('.scales-chord-play'))[3].click()
  await wait(200)
  check('a chord clicked is picked', await page.evaluate(() => document.querySelectorAll('.scales-chord')[3].classList.contains('on')))
  check('its notes shown on the keyboard', (await page.$$('.scales-key.chord')).length >= 3)
  check('and it plays through the rack, not a tone of its own', (await tones()) === before && (await page.evaluate(() => window.__contexts)) > 0)

  await (await button('.scales', "Set song's key")).click()
  await wait(80)
  const song = (await saved()).song
  check("Set song's key puts the song in A minor", song.scale?.root === 9 && song.scale?.mode === 'minor', JSON.stringify(song.scale))
  check('and says it is now', !!(await button('.scales', "Song's key")))

  const g = (await page.evaluateHandle(() => [...document.querySelectorAll('.scales-node')].find((n) => n.querySelector('text')?.textContent === 'G'))).asElement()
  await g.click()
  await wait(80)
  check('a place on the circle moves the key there', (await page.$eval('.scales select[aria-label="Key"]', (s) => s.value)) === '7')
  check('and the song keeps its own until asked', !!(await button('.scales', 'Use song\'s')))

  await (await page.$$('.scales-add'))[0].click()
  await wait(80)
  const p = await prefs()
  check('+ adds the chord to the progression', p.harmony?.degrees?.at(-1) === 0 && p.harmony.degrees.length === 5, JSON.stringify(p.harmony?.degrees))
}

console.log('\nprogressions')
{
  check('the Utilities menu opens Progressions', await openUtility('Progressions', '.progression'))
  check('it shares the key', (await page.$eval('.progression select[aria-label="Key"]', (s) => s.value)) === '7')
  check('and the progression', (await page.$$('.progression-strip li')).length === 5)
  await page.evaluate(() => [...document.querySelectorAll('.progression-preset')].find((b) => b.textContent.startsWith('Pop'))?.click())
  await wait(80)
  const chips = await page.$$eval('.progression-strip .scales-name', (e) => e.map((x) => x.textContent).join(' '))
  check('a preset is the key\'s own chords: Pop in G minor', chips === 'Gm Dm E♭ Cm', chips)
  await page.select('.progression select[aria-label="Key"]', '0')
  await page.select('.progression select[aria-label="Scale"]', 'major')
  await page.select('.progression select[aria-label="Rhythm"]', 'beats')
  await page.select('.progression select[aria-label="Voicing"]', 'close')
  await wait(80)
  const chips2 = await page.$$eval('.progression-strip .scales-name', (e) => e.map((x) => x.textContent).join(' '))
  check('and in C major, C G Am F', chips2 === 'C G Am F', chips2)
  check('the explorer follows the key', (await page.$eval('.scales select[aria-label="Key"]', (s) => s.value)) === '0')

  const write = await page.$('.progression .progression-write')
  check('Write names the pattern', (await page.evaluate((b) => b.textContent, write)).startsWith('Write into'))
  check('and can write: the bench rack has a Keyboard', !(await page.evaluate((b) => b.disabled, write)))
  await write.click()
  await wait(120)
  const doc = await saved()
  const pattern = doc.song.patterns[0]
  const notes = pattern.notes.filter((n) => n.track === doc.song.tracks[0].id)
  check('a bar a chord is four bars: the pattern is lengthened', pattern.length === 960 * 16, `${pattern.length / 3840} bars`)
  check('four chords of three notes on every beat', notes.length === 4 * 4 * 3, `${notes.length} notes`)
  check('each on a beat', notes.every((n) => n.tick % 960 === 0))
  const first = notes.filter((n) => n.tick === 0).map((n) => n.pitch).sort((a, b) => a - b)
  const fourth = notes.filter((n) => n.tick === 960 * 12).map((n) => n.pitch).sort((a, b) => a - b)
  check('C then, a bar a chord later, F: the same shapes', first[1] - first[0] === 4 && first[2] - first[0] === 7 && fourth[0] - first[0] === 5, `${first} / ${fourth}`)
  check('and it says so', (await text('.progression .timing-status')).startsWith('Wrote 4 chords'))

  await write.click()
  await wait(120)
  const again = (await saved()).song.patterns[0].notes.filter((n) => n.track === doc.song.tracks[0].id)
  check('writing again replaces rather than doubles', again.length === notes.length)
  await closePanel('.scales')
  await closePanel('.progression')
}

console.log('\nrhythm')
{
  check('the Utilities menu opens Rhythm', await openUtility('Rhythm', '.rhythm'))
  check('with no drum track it says so', (await text('.rhythm .timing-status')).startsWith('No drum track'))
  check('and cannot write', await page.$eval('.rhythm .progression-write', (b) => b.disabled))

  // The Drum Kit from the library, onto the bench.
  const menu = (await page.evaluateHandle(() => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === 'Patch'))).asElement()
  await menu.click()
  await wait(120)
  await page.evaluate(() => [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.includes('Library'))?.click())
  await waitUntil(page, () => !!document.querySelector('.library-shelf'))
  await page.evaluate(() => [...document.querySelectorAll('.library-shelf')].find((s) => /drum/i.test(s.textContent))?.click())
  await wait(150)
  await page.evaluate(() => [...document.querySelectorAll('.library-row')].find((r) => r.querySelector('.library-name')?.textContent.trim() === 'Drum Kit')?.click())
  await waitUntil(page, () => !document.querySelector('.library-row') && !!document.querySelector('.kit')).catch(() => {})
  await waitUntil(page, () => !!document.querySelector('.rhythm select[aria-label="Lane 1\'s pad"]'), { timeout: 3000 }).catch(() => {})
  check('a Drum Kit on the bench is a drum track', !(await page.$eval('.rhythm .progression-write', (b) => b.disabled)))

  await page.evaluate(() => [...document.querySelectorAll('.rhythm .progression-preset')].find((b) => b.textContent === 'Tresillo')?.click())
  await wait(80)
  check('a groove fills the lanes', (await page.$$('.rhythm-row')).length === 3)
  check('each lane drawn: three in eight is x..x..x.', (await page.$eval('.rhythm-steps', (e) => e.getAttribute('aria-label'))).endsWith('x..x..x.'))
  check('on the kit\'s own pads', (await page.$eval('.rhythm-row select', (s) => s.selectedOptions[0].textContent)) === 'Kick')

  await (await page.$('.rhythm .progression-write')).click()
  await wait(120)
  const doc = await saved()
  const pattern = doc.song.patterns[0]
  const kicks = pattern.notes.filter((n) => n.pitch === 36 - 12)
  const steps = pattern.length / 240
  check('the kick lane fills the pattern, three in every eight', kicks.length === (steps / 8) * 3, `${kicks.length} kicks in ${steps} steps`)
  check('on the tresillo', kicks.every((n) => [0, 3, 6].includes((n.tick / 240) % 8)))
  const hats = pattern.notes.filter((n) => n.pitch === 42 - 12)
  check('the hats left partly to chance', hats.length > steps / 4 && hats.length < steps, `${hats.length} of ${steps}`)
  check('accents louder than the rest', hats.some((n) => n.velocity === 1) && hats.some((n) => n.velocity < 1))

  await (await page.$('.rhythm .timing-song[title^="Roll"]')).click()
  await (await page.$('.rhythm .progression-write')).click()
  await wait(120)
  const rerolled = (await saved()).song.patterns[0].notes.filter((n) => n.pitch === 42 - 12)
  check('Reroll changes what chance left out, and only that', JSON.stringify(rerolled) !== JSON.stringify(hats) && (await saved()).song.patterns[0].notes.filter((n) => n.pitch === 24).length === kicks.length)
  await closePanel('.rhythm')
}

await finish()
