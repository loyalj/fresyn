/**
 * Verifies that the app owns its input: keys it claims never reach the
 * browser, right-click belongs to the rack, the wheel tunes a knob instead
 * of scrolling past it, and the escape hatches for browser shortcuts and
 * text fields still work.
 *
 * Starts its own dev server (see harness.mjs); set DEV_URL to use a running
 * one, and CHROME_PATH if Chrome is not where the harness looks.
 */
import { check, finish, flipRack, open, settle, waitUntil } from './harness.mjs'

// Short on purpose, so the page is definitely scrollable.
const { page, url } = await open({ viewport: { width: 1200, height: 700 } })

await page.goto(url, { waitUntil: 'networkidle0' })
const cdp = await page.createCDPSession()

// Record whether each event reached the browser with its default intact.
await page.evaluate(() => {
  window.__seen = []
  for (const type of ['keydown', 'keyup', 'contextmenu']) {
    document.addEventListener(type, (e) => {
      window.__seen.push({ type, code: e.code ?? null, prevented: e.defaultPrevented })
    })
  }
})
const lastSeen = (type) =>
  page.evaluate((t) => [...window.__seen].reverse().find((s) => s.type === t) ?? null, type)
const clearSeen = () => page.evaluate(() => { window.__seen = [] })

const scrollY = () => page.evaluate(() => window.scrollY)
const cableCount = () =>
  page.evaluate(() => document.querySelectorAll('.cables g.cable:not(.cable-dragging)').length)

check('the page is tall enough to scroll', await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight))

// --- space ------------------------------------------------------------
console.log('\nspace holds the gate without scrolling')
{
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.keyboard.down('Space')
  await settle(120)
  check('a single press does not scroll', (await scrollY()) === 0, `scrollY=${await scrollY()}`)

  // Auto-repeat is the case that actually leaked: the old handler returned
  // early on repeat, before it reached preventDefault.
  //
  // The scroll assertion below is weak for this case -- a CDP-synthesised
  // repeat does not drive Chrome's native scroll the way a held key does, so
  // it passes either way. The 'keydown was prevented' check is what actually
  // pins the repeat path; it fails if the early return comes back.
  for (let i = 0; i < 6; i++) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      code: 'Space',
      key: ' ',
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32,
      autoRepeat: true,
    })
  }
  await settle(120)
  check('auto-repeat does not scroll', (await scrollY()) === 0, `scrollY=${await scrollY()}`)

  await page.keyboard.up('Space')
  check('keydown was prevented', (await lastSeen('keydown'))?.prevented === true)
  check('keyup was prevented', (await lastSeen('keyup'))?.prevented === true)
}

// --- space with a button focused --------------------------------------
console.log('\nspace after clicking a button')
{
  await page.click('.trigger')
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.keyboard.down('Space')
  await settle(100)
  await page.keyboard.up('Space')
  check('still does not scroll', (await scrollY()) === 0, `scrollY=${await scrollY()}`)
  check('the key never reaches the focused button', (await lastSeen('keydown'))?.prevented === true)
}

// --- arrow keys --------------------------------------------------------
console.log('\narrow keys')
{
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('PageDown')
  await settle(120)
  check('arrows and page keys do not scroll', (await scrollY()) === 0, `scrollY=${await scrollY()}`)
}

// --- tab and F ---------------------------------------------------------
// Tab used to turn the rack round, which left a keyboard with no way to get
// from one control to the next. It moves the focus now, and F flips.
console.log('\ntab moves focus; F flips')
{
  const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? '')
  await clearSeen()
  await page.keyboard.press('Tab')
  await settle(300)
  const after = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? '')
  check('Tab moved the focus', before !== after, `${before} -> ${after}`)
  check('Tab was not taken from the browser', (await lastSeen('keydown'))?.prevented === false)
  check('Tab did not flip the rack', await page.evaluate(() => !document.querySelector('.rack-flipped')))

  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))
  await flipRack(page, true)
  check('F flips the rack', await page.evaluate(() => !!document.querySelector('.rack-flipped')))

  // Typing an F into a field is typing, not turning the rack round.
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'fprobe'
    document.body.appendChild(input)
    input.focus()
  })
  await page.keyboard.type('ff')
  await settle(200)
  check(
    'F in a field types, and does not flip',
    (await page.evaluate(() => document.querySelector('#fprobe').value)) === 'ff' &&
      (await page.evaluate(() => !!document.querySelector('.rack-flipped'))),
  )
  await page.evaluate(() => document.querySelector('#fprobe').remove())
}

// --- right click -------------------------------------------------------
console.log('\nright click belongs to the rack')
{
  await clearSeen()
  await page.mouse.click(600, 300, { button: 'right' })
  await settle(100)
  const menu = await lastSeen('contextmenu')
  check('the browser menu is suppressed', menu?.prevented === true, JSON.stringify(menu))
}

// Now make the whole rack visible so a jack can be right-clicked.
await page.setViewport({ width: 1200, height: 1500 })
await settle(400)
{
  const before = await cableCount()
  const jack = await page.evaluate(() => {
    const el = document.querySelector('.jack[data-module="lpf1"][data-port="in"]')
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.click(jack.x, jack.y, { button: 'right' })
  await settle(150)
  const after = await cableCount()
  check('right-clicking a jack unplugs it', after === before - 1, `${before} -> ${after}`)
}

// --- the wheel over a knob --------------------------------------------
console.log('\nthe wheel tunes a knob, and only over a knob')
{
  // The cable sections above leave the rack turned around, and the knobs
  // are on the front of it.
  if (await page.evaluate(() => !!document.querySelector('.rack-flipped'))) {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))
    await flipRack(page, false)
  }
  await page.evaluate(() => window.scrollTo(0, 0))

  // Named, not "the first knob on the page". The checks below are written
  // about this one: its unit is hertz, so the last digit the readout shows is
  // one hertz, which is what makes the shift assertions mean anything. Taking
  // whatever knob came first meant a module added at the top of the stock rack
  // silently moved the test onto a different knob with a different unit, and
  // the failure read as a broken wheel rather than as a moved target.
  //
  // The lookup is spelled out at each use because these bodies run in the
  // page, where a helper declared out here does not exist.
  const KNOB = { unit: 'osc1', label: 'Pitch' }

  const readout = () =>
    page.evaluate((k) => {
      const unit = [...document.querySelectorAll('.unit-face-front')].find(
        (u) => u.querySelector('.unit-id')?.textContent === k.unit,
      )
      const knob = [...(unit?.querySelectorAll('.knob') ?? [])].find(
        (n) => n.querySelector('.knob-label')?.textContent?.trim() === k.label,
      )
      return knob.querySelector('.knob-readout').textContent
    }, KNOB)

  /** The value behind the readout, which is rounded to whole hertz up here. */
  const exact = () =>
    page.evaluate((k) => {
      const unit = [...document.querySelectorAll('.unit-face-front')].find(
        (u) => u.querySelector('.unit-id')?.textContent === k.unit,
      )
      const knob = [...(unit?.querySelectorAll('.knob') ?? [])].find(
        (n) => n.querySelector('.knob-label')?.textContent?.trim() === k.label,
      )
      return Number(knob.querySelector('svg').getAttribute('aria-valuenow'))
    }, KNOB)

  const overKnob = async () => {
    const at = await page.evaluate((k) => {
      const unit = [...document.querySelectorAll('.unit-face-front')].find(
        (u) => u.querySelector('.unit-id')?.textContent === k.unit,
      )
      const knob = [...(unit?.querySelectorAll('.knob') ?? [])].find(
        (n) => n.querySelector('.knob-label')?.textContent?.trim() === k.label,
      )
      const r = knob.querySelector('svg').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, KNOB)
    await page.mouse.move(at.x, at.y)
  }
  const notch = async (deltaY, times = 1) => {
    for (let i = 0; i < times; i++) {
      await page.mouse.wheel({ deltaY })
      await settle(40)
    }
    await settle(120)
  }

  await overKnob()
  const start = await readout()

  await notch(-100)
  const oneUp = await readout()
  check('one notch up changes the value', oneUp !== start, `${start} -> ${oneUp}`)
  check('the page did not scroll', (await scrollY()) === 0, `scrollY=${await scrollY()}`)

  // The wheel keeps its own position so a burst does not stall; if that ever
  // regresses, a run out and back will not land where it started.
  await notch(-100, 9)
  const up = await readout()
  await notch(100, 10)
  check('ten notches out and back returns exactly', (await readout()) === start, `${start} -> ${up} -> ${await readout()}`)

  // Shift is the exact adjustment: a notch moves the last digit the readout
  // is showing, which up at 110 Hz is one hertz.
  const base = await exact()
  await page.keyboard.down('Shift')
  await notch(-100)
  const fine = await exact()
  await notch(100)
  const back = await exact()
  await page.keyboard.up('Shift')
  check('a shifted notch moves one digit of the readout', fine === base + 1, `${base} -> ${fine}`)
  check('and the notch back undoes it', back === base, `${fine} -> ${back}`)

  // And it tidies as it moves. A plain notch leaves the knob between two
  // whole hertz; one shifted notch from there has to land on one of them,
  // because a value you cannot say exactly is a value you cannot set.
  await notch(-100)
  const off = await exact()
  await page.keyboard.down('Shift')
  await notch(100)
  await page.keyboard.up('Shift')
  const on = await exact()
  check('and lands on a round value', Number.isInteger(on) && on < off, `${off} -> ${on}`)

  // Anywhere that is not a knob still belongs to the page. The stock rack is
  // four units, which fits in a tall window with nothing left to scroll, so
  // the window is shortened to give the page somewhere to go.
  await page.setViewport({ width: 1200, height: 420 })
  await settle(200)
  // Outside the rack entirely: the panels are 1040px wide and centred, so
  // this lands on the page background rather than on any control.
  await page.mouse.move(1160, 300)
  await notch(300)
  check('the page still scrolls elsewhere', (await scrollY()) > 0, `scrollY=${await scrollY()}`)
  await page.evaluate(() => window.scrollTo(0, 0))
}

// --- saying a knob's value outright ------------------------------------
/**
 * The wheel and the drag are for finding a value. These are for saying one:
 * typing it into the readout, or carrying it from another knob. Both have to
 * land on the number asked for and refuse a number that means something
 * else, which is the entire point of having them.
 */
console.log()
console.log("a knob's value can be said outright")
{
  await page.setViewport({ width: 1200, height: 1500 })
  await settle(300)
  await page.evaluate(() => window.scrollTo(0, 0))

  /** The middle of one part of the knob carrying `label`, in page coords. */
  // `lpf1::CV Amt` narrows the search to one unit, for a label that more
  // than one module in the rack carries.
  const knobsFor = (l) => {
    const [unit, label] = l.includes('::') ? l.split('::') : [null, l]
    const scope = unit ? `[data-module="${unit}"] .knob` : '.knob'
    return { scope, label }
  }
  const partAt = (label, sel) =>
    page.evaluate(
      ({ scope, label: l }, s) => {
        const knob = [...document.querySelectorAll(scope)].find(
          (k) => k.querySelector('svg')?.getAttribute('aria-label') === l,
        )
        const el = knob?.querySelector(s)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      },
      knobsFor(label),
      sel,
    )
  const valueOf = (label) =>
    page.evaluate(({ scope, label: l }) => {
      const svg = [...document.querySelectorAll(`${scope} svg`)].find(
        (s) => s.getAttribute('aria-label') === l,
      )
      return svg ? Number(svg.getAttribute('aria-valuenow')) : null
    }, knobsFor(label))
  const clickPart = async (label, sel, options) => {
    const at = await partAt(label, sel)
    if (!at) return false
    await page.mouse.click(at.x, at.y, options)
    await settle(150)
    return true
  }
  /** A row of the menu at the pointer, by its label. */
  const row = async (label) => {
    const h = await page.evaluateHandle(
      (l) =>
        [...document.querySelectorAll('.context-menu .menu-item')].find(
          (b) => b.querySelector('.menu-text')?.textContent.trim() === l,
        ) ?? null,
      label,
    )
    return h.asElement()
  }
  const entryOpen = () => page.evaluate(() => !!document.querySelector('.knob-entry'))

  // An FM amount has to be exactly 1.00 for a keyboard to track an
  // oscillator, and "near enough" is audibly wrong.
  check('the readout opens for typing', await clickPart('FM Amt', '.knob-readout'))
  await page.keyboard.type('1.00')
  await page.keyboard.press('Enter')
  await settle(150)
  check('a typed value lands exactly', (await valueOf('FM Amt')) === 1, `${await valueOf('FM Amt')}`)
  check('and the field closes behind it', !(await entryOpen()))

  // A time is not an amount in octaves, and the field says so by staying
  // open rather than by guessing.
  await clickPart('FM Amt', '.knob-readout')
  await page.keyboard.type('250 ms')
  await page.keyboard.press('Enter')
  await settle(150)
  check('a value in the wrong unit is refused', await entryOpen())
  check('and the knob has not moved', (await valueOf('FM Amt')) === 1)
  await page.keyboard.press('Escape')
  await settle(150)
  check('Escape gives up on it', !(await entryOpen()) && (await valueOf('FM Amt')) === 1)

  // A pitch is a note, and a knob that spans twelve octaves cannot be tuned
  // against another one by eye. So the panel says which note it is sounding,
  // the knob takes one as a value, and Alt lands it on one exactly.
  //
  // The note is read from beside the waveform rather than from under the
  // knob: the knob is set in hertz and the note belongs to the module, which
  // is the only thing that knows about the Octave switch as well.
  const noteOf = () =>
    page.evaluate(
      () => document.querySelector('[data-module="osc1"] .osc-wave-note')?.textContent ?? null,
    )

  // Set outright rather than assumed: the wheel section above left this knob
  // wherever it finished with it.
  await clickPart('Pitch', '.knob-readout')
  await page.keyboard.type('110')
  await page.keyboard.press('Enter')
  await settle(150)
  check('a pitch says which note it is', (await noteOf()) === 'A2', String(await noteOf()))

  await clickPart('Pitch', '.knob-readout')
  await page.keyboard.type('A3')
  await page.keyboard.press('Enter')
  await settle(150)
  check('and takes one as a value', Math.abs((await valueOf('Pitch')) - 220) < 0.01, `${await valueOf('Pitch')} Hz`)
  check('and says it back', (await noteOf()) === 'A3', String(await noteOf()))

  // Dragged with Alt held, every value it passes through is a note: a fifth
  // is seven of them, and seven semitones is a different number of hertz
  // wherever you are on the knob.
  const dial = await partAt('Pitch', 'svg')
  await page.keyboard.down('Alt')
  await page.mouse.move(dial.x, dial.y)
  await page.mouse.down()
  await page.mouse.move(dial.x, dial.y - 37, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await settle(150)
  const snapped = await valueOf('Pitch')
  const semitones = 12 * Math.log2(snapped / 440)
  check(
    'Alt-dragging lands on a semitone',
    Math.abs(semitones - Math.round(semitones)) < 0.02 && snapped > 220,
    `${snapped} Hz, ${semitones.toFixed(3)} semitones from A4`,
  )
  check('which the note readout agrees with', !(await noteOf())?.includes('¢'), String(await noteOf()))

  // Copy, and then paste it somewhere it belongs and somewhere it does not.
  await clearSeen()
  check('right-clicking a knob opens a menu', await clickPart('FM Amt', 'svg', { button: 'right' }))
  check('and not the browser\'s one', (await lastSeen('contextmenu'))?.prevented === true)
  const copy = await row('Copy')
  check('the menu offers Copy', !!copy)
  await copy.click()
  await settle(150)

  // The filter's, in octaves like FM Amt. The VCA has a CV Amt too, and it
  // measures nothing.
  await clickPart('lpf1::CV Amt', 'svg', { button: 'right' })
  const paste = await row('Paste')
  check('Paste is offered on a knob in the same unit', !!paste && !(await page.evaluate((b) => b.disabled, paste)))
  await paste.click()
  await settle(150)
  check('and it arrives exactly', (await valueOf('lpf1::CV Amt')) === 1, `${await valueOf('lpf1::CV Amt')}`)

  const cutoffWas = await valueOf('Cutoff')
  await clickPart('Cutoff', 'svg', { button: 'right' })
  const refused = await row('Paste')
  check(
    'Paste is greyed on a knob that measures something else',
    !!refused && (await page.evaluate((b) => b.disabled, refused)),
  )
  await page.keyboard.press('Escape')
  await settle(150)
  check('so the frequency is untouched', (await valueOf('Cutoff')) === cutoffWas)
  check('and the menu is gone', !(await page.evaluate(() => !!document.querySelector('.context-menu'))))
}

// --- a menu owns the keyboard while it is open -------------------------
/**
 * Every key in this app is captured on the window, ahead of whatever has
 * focus. That is what makes the rack playable, and it is also what would make
 * a menu unusable: arrowing down a list would scroll the page, Space would
 * play the instrument instead of choosing a row, and F would turn the rack
 * around behind the menu you were reading.
 */
console.log()
console.log('a menu takes the keyboard off the rack')
{
  const openMenu = async (label) => {
    const h = await page.evaluateHandle(
      (t) => [...document.querySelectorAll('.menubar-label')].find((b) => b.textContent.trim() === t),
      label,
    )
    const el = h.asElement()
    if (!el) return false
    await el.click()
    await settle(150)
    return true
  }
  const menuShowing = () => page.evaluate(() => !!document.querySelector('.menu'))
  const flipped = () => page.evaluate(() => !!document.querySelector('.rack-flipped'))

  await page.evaluate(() => window.scrollTo(0, 0))
  check('a menu opens', await openMenu('Modules'))
  check('and it is showing', await menuShowing())

  // The three keys the rack would otherwise take.
  await clearSeen()
  await page.keyboard.press('ArrowDown')
  await settle(80)
  check('arrow keys do not scroll the rack away', (await scrollY()) === 0, `scrollY=${await scrollY()}`)

  const wasFlipped = await flipped()
  await page.keyboard.press('KeyF')
  await settle(200)
  check('F does not turn the rack around', (await flipped()) === wasFlipped)

  await page.keyboard.press('Escape')
  await settle(200)
  check('Escape closes it', !(await menuShowing()))

  // And the rack has the keyboard back the moment it does. The focus is
  // left on the menu's name, which is a button: an arrow does nothing for a
  // button, so the rack keeps it from scrolling the page, and the menu stays
  // shut.
  await page.evaluate(() => window.scrollTo(0, 0))
  await clearSeen()
  await page.keyboard.press('ArrowDown')
  await settle(120)
  check('the rack has its keys back afterwards', (await lastSeen('keydown'))?.prevented === true)
  check('and still does not scroll', (await scrollY()) === 0, `scrollY=${await scrollY()}`)
  check('and the menu stays shut', !(await menuShowing()))

  // Space is a button's own key, and with no Trigger on it, it presses the
  // focused one -- which, for a menu's name, opens that menu.
  await page.keyboard.press('Space')
  await settle(150)
  check('Space presses the focused button when nothing claims it', await menuShowing())
  await page.keyboard.press('Escape')
  await settle(150)

  // Closing a menu leaves focus on the word it opened from, which is right
  // for a keyboard user and would quietly change what the sections below are
  // testing. Put it back where it was.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))
}

// --- claimed modifier combos ------------------------------------------
console.log()
console.log('claimed modifier combos')
{
  const press = async (mods, code) => {
    await clearSeen()
    for (const m of mods) await page.keyboard.down(m)
    await page.keyboard.press(code)
    for (const m of [...mods].reverse()) await page.keyboard.up(m)
    await settle(80)
    return lastSeen('keydown')
  }

  check('Ctrl+Z is claimed', (await press(['Control'], 'KeyZ'))?.prevented === true)
  check('Ctrl+Shift+Z is claimed', (await press(['Control', 'Shift'], 'KeyZ'))?.prevented === true)
  check('Ctrl+Y is claimed', (await press(['Control'], 'KeyY'))?.prevented === true)
  // An unclaimed combo still belongs to the browser.
  check('Ctrl+B is left alone', (await press(['Control'], 'KeyB'))?.prevented === false)
}

// --- escape hatches ----------------------------------------------------
console.log('\nescape hatches')
{
  await clearSeen()
  // A bound key with a modifier belongs to the browser, not to us.
  await page.keyboard.down('Control')
  await page.keyboard.press('Space')
  await page.keyboard.up('Control')
  await settle(100)
  check('modifier combos pass through', (await lastSeen('keydown'))?.prevented === false)
}

{
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'probe'
    document.body.appendChild(input)
    input.focus()
  })
  await clearSeen()
  await page.keyboard.type('a b')
  await settle(100)
  const value = await page.evaluate(() => document.querySelector('#probe').value)
  check('typing into a field is not swallowed', value === 'a b', `value="${value}"`)
  check('its space is not prevented', (await lastSeen('keydown'))?.prevented === false)

  // Undo inside a text field has to reach the field, not the rack.
  await clearSeen()
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(80)
  check('Ctrl+Z in a field belongs to the field', (await lastSeen('keydown'))?.prevented === false)

  await page.evaluate(() => document.querySelector('#probe').remove())
}

// --- the keyboard reaches every control ---------------------------------
// A knob is a slider, a switch is a radio group, the tempo is a field you can
// type into. Each takes the keys its kind of control is expected to take.
console.log('\nthe keyboard sets controls')
{
  if (await page.evaluate(() => !!document.querySelector('.rack-flipped'))) {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))
    await flipRack(page, false)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  const knob = '.unit-face-front .knob svg[role="slider"]'
  const knobValue = () =>
    page.evaluate((k) => Number(document.querySelector(k)?.getAttribute('aria-valuenow')), knob)
  const knobBounds = await page.evaluate((k) => {
    const el = document.querySelector(k)
    return el ? { min: Number(el.getAttribute('aria-valuemin')), max: Number(el.getAttribute('aria-valuemax')), tab: el.tabIndex } : null
  }, knob)
  check('a knob is in the tab order', knobBounds?.tab === 0, JSON.stringify(knobBounds))
  await page.evaluate((k) => document.querySelector(k).focus(), knob)
  const start = await knobValue()
  await clearSeen()
  await page.keyboard.press('ArrowUp')
  await settle(100)
  const up = await knobValue()
  check('ArrowUp turns it up', up > start, `${start} -> ${up}`)
  check('and the page did not scroll', (await scrollY()) === 0, `scrollY=${await scrollY()}`)
  await page.keyboard.press('ArrowDown')
  await settle(100)
  const back = await knobValue()
  check('ArrowDown turns it back', Math.abs(back - start) < Math.abs(up - start) / 2 + 1e-6, `${up} -> ${back}`)
  await page.keyboard.press('PageUp')
  await settle(100)
  const paged = await knobValue()
  check('Page Up is a bigger step than an arrow', paged - back > up - start, `${back} -> ${paged}`)
  await page.keyboard.press('Home')
  await settle(100)
  check('Home goes to the bottom', (await knobValue()) === knobBounds.min, `${await knobValue()}`)
  await page.keyboard.press('End')
  await settle(100)
  check('End goes to the top', (await knobValue()) === knobBounds.max, `${await knobValue()}`)
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(100)
  check('Ctrl+Z still undoes with a knob focused', (await knobValue()) !== knobBounds.max, `${await knobValue()}`)

  // A switch: one stop for the whole row, and the arrows move along it.
  const lit = () =>
    page.evaluate(() => {
      const group = document.querySelector('.unit-face-front .switch [role="radiogroup"]')
      const radios = [...(group?.querySelectorAll('[role="radio"]') ?? [])]
      return radios.findIndex((r) => r.getAttribute('aria-checked') === 'true')
    })
  const stops = await page.evaluate(() => {
    const group = document.querySelector('.unit-face-front .switch [role="radiogroup"]')
    return [...(group?.querySelectorAll('[role="radio"]') ?? [])].filter((r) => r.tabIndex === 0).length
  })
  check('a switch is one tab stop', stops === 1, `${stops}`)
  const was = await lit()
  await page.evaluate(() =>
    document.querySelector('.unit-face-front .switch [role="radio"][aria-checked="true"]')?.focus(),
  )
  await page.keyboard.press('ArrowRight')
  await settle(100)
  const moved = await lit()
  check('ArrowRight moves a switch along', moved !== was && moved >= 0, `${was} -> ${moved}`)
  await page.keyboard.press('ArrowLeft')
  await settle(100)
  check('and ArrowLeft brings it back', (await lit()) === was, `${await lit()}`)

  // The tempo is typed, and only lands when it is finished with.
  const tempo = '.dock-bar input[type="number"]'
  const field = () => page.evaluate((t) => document.querySelector(t)?.value, tempo)
  const saved = () =>
    page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('fresyn.project.v1')).song.tempo
      } catch {
        return null
      }
    })
  /** Until the field reads this and the autosave has the same tempo. */
  const landed = (value) =>
    waitUntil(
      page,
      (t, v) => {
        try {
          const song = JSON.parse(localStorage.getItem('fresyn.project.v1')).song
          return document.querySelector(t)?.value === v && song.tempo === Number(v)
        } catch {
          return false
        }
      },
      { args: [tempo, value] },
    )
  const before = await field()
  await page.click(tempo, { clickCount: 3 })
  await page.keyboard.type('1')
  await settle(600)
  check('typing a first digit is not clamped', (await field()) === '1', `${await field()}`)
  check('and the song keeps its tempo meanwhile', String(await saved()) === before, `${await saved()}`)
  await page.keyboard.type('40')
  await page.keyboard.press('Enter')
  await landed('140')
  check('Enter sets the tempo typed', (await field()) === '140' && (await saved()) === 140, `${await field()} / ${await saved()}`)
  await page.click(tempo, { clickCount: 3 })
  await page.keyboard.type('9')
  await page.keyboard.press('Escape')
  await settle(200)
  check('Escape puts it back', (await field()) === '140', `${await field()}`)
  await page.click(tempo, { clickCount: 3 })
  await page.keyboard.type('999')
  await page.evaluate(() => document.activeElement?.blur())
  await landed('300')
  check('leaving the field clamps what was typed', (await field()) === '300' && (await saved()) === 300, `${await field()}`)
  // Back as it was, for the sections below.
  await page.click(tempo, { clickCount: 3 })
  await page.keyboard.type(before)
  await page.keyboard.press('Enter')
  await page.evaluate(() => document.activeElement?.blur())
  await settle(300)
}

// --- trigger key bindings ----------------------------------------------
//
// Last in the file, and it starts and ends on a cleared autosave: this is the
// one section that edits the patch, and a run that left a Trigger on some
// other key would carry into the next run.
//
// On the tutorial rack, because the stock rack has no Trigger to bind: its
// Keyboard is played by its own keys. The tutorial rack keeps one on Space.
console.log('\ntrigger keys')
{
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'networkidle0' })
  // Real clicks: the menu opens on a pointer press, which a scripted
  // element.click() does not make.
  const menu = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Patch'),
  )
  await menu.click()
  await settle(150)
  const item = await page.evaluateHandle(() =>
    [...document.querySelectorAll('[role=menuitem], button')].find((b) => b.textContent.includes('Library')),
  )
  await item.click()
  await page.waitForSelector('.library-row')
  const row = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.library-row')].find(
      (r) => r.querySelector('.library-name')?.textContent?.trim() === 'Tutorial rack',
    ),
  )
  await row.click()
  await waitUntil(page, () => !!document.querySelector('.trigger-cap'))

  const capText = () =>
    page.evaluate(() => document.querySelector('.trigger-cap')?.textContent ?? null)
  const listening = () => page.evaluate(() => !!document.querySelector('.trigger-cap.listening'))

  check('the Trigger has a cap', (await capText()) === 'Space', `${await capText()}`)

  // How full each mixer bar is, read off the geometry the audio thread draws.
  const barFill = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.strip-meter-fill')].map((e) => {
        const m = /inset\(([\d.]+)%/.exec(e.style.clipPath || '')
        return m ? 1 - Number(m[1]) / 100 : 0
      }),
    )
  /**
   * Until some bar shows sound (loud) or every bar is back on the floor.
   * The same reading as barFill, made in the page so the wait ends the
   * frame it comes true; a timeout just leaves the check below to fail.
   */
  const meters = (loud) =>
    waitUntil(
      page,
      (loud) => {
        const fill = [...document.querySelectorAll('.strip-meter-fill')].map((e) => {
          const m = /inset\(([\d.]+)%/.exec(e.style.clipPath || '')
          return m ? 1 - Number(m[1]) / 100 : 0
        })
        return loud ? fill.some((v) => v > 0.05) : fill.every((v) => v < 0.01)
      },
      { args: [loud], timeout: loud ? 3000 : 5000 },
    )

  // Start the engine the way a user does, and let the note decay away again
  // so the meters below start from silence.
  await page.click('.trigger')
  await meters(true)
  await meters(false)

  /** Hold a key for a moment and report whether the rack made a sound. */
  const sounds = async (code) => {
    await page.keyboard.down(code)
    await meters(true)
    const fill = await barFill()
    await page.keyboard.up(code)
    // Until a full-scale bar has fallen all the way to the floor, so the
    // next call starts from silence rather than from this one's tail.
    await meters(false)
    return fill.some((v) => v > 0.05)
  }

  check('Space plays the rack', await sounds('Space'))

  await page.click('.trigger-cap')
  check('clicking the cap starts the wait', await listening())
  check('and it says so', (await capText()) === 'Press a key', `${await capText()}`)

  // Tab moves the focus, so a Trigger may not take it. The refusal has to be
  // visible: a press that silently did nothing would read as a broken cap.
  await page.keyboard.press('Tab')
  await settle(150)
  check('a reserved key is refused', (await capText()) === 'In use', `${await capText()}`)
  check('and the cap keeps waiting', await listening())
  check('the rack did not flip', await page.evaluate(() => !document.querySelector('.rack-flipped')))

  await page.keyboard.press('Escape')
  await settle(150)
  check('Escape ends the wait', !(await listening()))
  check('and leaves the binding alone', (await capText()) === 'Space', `${await capText()}`)

  await page.click('.trigger-cap')
  await page.keyboard.press('KeyW')
  await settle(200)
  check('a key can be assigned', (await capText()) === 'W', `${await capText()}`)
  check('the wait is over', !(await listening()))
  // The cap keeps the focus, and with Space no longer bound, Space would
  // press it -- which is a button doing its job, and not what is being
  // tested below. Put the focus back on the page.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))

  check('the new key plays the rack', await sounds('KeyW'))
  check('and the old one no longer does', !(await sounds('Space')))

  // Undo reaches a binding, because it is a patch edit like any other.
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await settle(250)
  check('undo puts the binding back', (await capText()) === 'Space', `${await capText()}`)

  // --- latch ----------------------------------------------------------
  //
  // The one fire mode with no DSP behind it: the audio thread sees a held
  // gate whose release never arrives, so the whole of latch is up here and
  // this is the only place it can be checked.
  console.log('\nlatch')

  /** Click a position on the Trigger's Mode switch. */
  const setMode = async (label) => {
    const found = await page.evaluate((want) => {
      const unit = [...document.querySelectorAll('.unit-face-front')].find(
        (u) => u.querySelector('.unit-id')?.textContent === 'gate1',
      )
      const button = [...(unit?.querySelectorAll('.switch-buttons button') ?? [])].find(
        (b) => b.textContent?.trim() === want,
      )
      if (!button) return false
      button.click()
      return true
    }, label)
    await settle(150)
    return found
  }

  const isLatched = () =>
    page.evaluate(() => !!document.querySelector('.trigger.latched[aria-pressed="true"]'))

  check('the Trigger has a Mode switch', await setMode('latch'))
  check('nothing is latched yet', !(await isLatched()))

  // Tap and let go. A held gate would have closed here; a latched one does not.
  await page.keyboard.press('Space')
  await settle(150)
  check('a tap latches it on', await isLatched())

  await page.keyboard.press('Space')
  await settle(150)
  check('and the next tap lets it go', !(await isLatched()))

  // Turning Mode off latch while it is on has to release it, or the gate
  // would be held by a control that no longer has any way to close it.
  await page.keyboard.press('Space')
  await settle(150)
  check('latched again', await isLatched())
  await setMode('held')
  check('leaving latch releases it', !(await isLatched()))

  // Back to the stock setting, so the autosave this section clears is the
  // only thing the next run has to undo.
  await setMode('held')

  await page.evaluate(() => localStorage.clear())
}

await finish()
