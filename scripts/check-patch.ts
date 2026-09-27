/**
 * Checks for patch editing and the save format.
 *
 * Saved files get hand-edited and outlive the module list they were written
 * against, so loading leans on being defensive rather than on the file being
 * well formed.
 *
 * Run with: npm run check:patch
 */
import { compile, withBypass } from '../src/patch/compile'
import {
  connect as wireUp,
  copyModules,
  pasteModules,
  setCableColor,
  toggleBypass,
} from '../src/patch/edit'
import { signalOf } from '../src/patch/defs'
import { defOf } from '../src/patch/defs'
import { triggerPatch } from '../src/patch/defaultPatch'
import {
  addModule,
  initialValues,
  moveModule,
  nextModuleId,
  removeModule,
} from '../src/patch/edit'
import {
  canRedo,
  canUndo,
  commit,
  HISTORY_LIMIT,
  initHistory,
  redo,
  undo,
} from '../src/patch/history'
import { isZip, makeBundle, readBundle } from '../src/patch/bundle'
import { fromStored, toStored, PATCH_FORMAT } from '../src/patch/serialize'
import type { Patch } from '../src/patch/types'

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// --- editing ---------------------------------------------------------
console.log('\nediting the rack')
{
  const base = triggerPatch()

  check('a new id does not collide', nextModuleId(base, 'osc') === 'osc2', nextModuleId(base, 'osc'))
  check('an unused type starts at 1', nextModuleId(base, 'vca') === 'vca1', nextModuleId(base, 'vca'))
  check('a slug is used, not the type', nextModuleId(base, 'ladder') === 'lpf2', nextModuleId(base, 'ladder'))

  // The stock rack is hand-named. If those ids drift from what the generator
  // produces, an added module lands beside a differently-named twin.
  const mismatched = base.modules.filter(
    (m) => !new RegExp(`^${defOf(m.type).slug}\\d+$`).test(m.id),
  )
  check(
    'stock ids follow the slug scheme',
    mismatched.length === 0,
    mismatched.map((m) => `${m.id}:${m.type}`).join(','),
  )

  const added = addModule(base, { id: nextModuleId(base, 'lfo'), type: 'lfo', params: {} })
  check('adding a module grows the rack', added.modules.length === base.modules.length + 1)
  check('the original patch is untouched', base.modules.length === triggerPatch().modules.length)
  check('a new module compiles', compile(added).warnings.length === 0)

  const removed = removeModule(base, 'lpf1')
  check('removing a module shrinks the rack', removed.modules.length === base.modules.length - 1)
  check(
    'its cables go with it',
    removed.cables.every((c) => c.from.module !== 'lpf1' && c.to.module !== 'lpf1'),
  )
  check('what is left still compiles', compile(removed).warnings.length === 0)

  const order = (p: ReturnType<typeof triggerPatch>) => p.modules.map((m) => m.id).join(',')
  const first = base.modules[0].id
  const moved = moveModule(base, first, 1)
  check('moving down reorders', moved.modules[1].id === first, order(moved))
  check('moving past the top is a no-op', order(moveModule(base, first, -1)) === order(base))
  const last = base.modules[base.modules.length - 1].id
  check('moving past the bottom is a no-op', order(moveModule(base, last, 1)) === order(base))
  check(
    'reordering does not change what compiles',
    compile(moved).modules.length === compile(base).modules.length,
  )
}

// --- history ---------------------------------------------------------
console.log('\nundo history')
{
  const h0 = initHistory('a')
  check('a fresh history has nowhere to go', !canUndo(h0) && !canRedo(h0))

  const h1 = commit(h0, 'b')
  check('committing records the previous state', canUndo(h1) && h1.present === 'b')
  check('committing the same value is a no-op', commit(h1, 'b') === h1)

  const h2 = commit(h1, 'c')
  const back = undo(h2)
  check('undo steps back', back.present === 'b')
  check('undo offers a way forward', canRedo(back))
  check('redo steps forward again', redo(back).present === 'c')
  check('undo then redo is the original', redo(back).past.length === h2.past.length)

  check('undo past the start is a no-op', undo(h0) === h0)
  check('redo past the end is a no-op', redo(h2) === h2)

  // A new edit after undoing abandons what was undone.
  const branched = commit(back, 'd')
  check('a new edit clears the redo stack', !canRedo(branched) && branched.present === 'd')

  // Coalescing is what stops a knob drag filling the history one frame at a
  // time; it replaces the current entry rather than pushing a new one.
  const folded = commit(commit(h1, 'x', true), 'y', true)
  check('coalesced edits do not stack up', folded.past.length === h1.past.length)
  check('coalescing keeps the latest value', folded.present === 'y')
  check('undo after coalescing lands before the whole gesture', undo(folded).present === 'a')

  let deep = initHistory(0)
  for (let i = 1; i <= HISTORY_LIMIT + 25; i++) deep = commit(deep, i)
  check('history is capped', deep.past.length === HISTORY_LIMIT, String(deep.past.length))
  check('the newest steps are the ones kept', deep.past[deep.past.length - 1] === HISTORY_LIMIT + 24)
}

// --- round trip ------------------------------------------------------
console.log('\nsaving and loading')
{
  const patch = triggerPatch()
  const values = initialValues(patch)
  values['lpf1.cutoff'] = 812.5
  values['mix1.pan3'] = -0.75

  const stored = toStored('Test Rack', patch, values)
  const reloaded = fromStored(JSON.parse(JSON.stringify(stored)))

  if ('error' in reloaded) {
    check('round trip survives JSON', false, reloaded.error)
  } else {
    check('round trip survives JSON', true)
    check('the name comes back', reloaded.name === 'Test Rack')
    check('no warnings on our own file', reloaded.warnings.length === 0, reloaded.warnings.join('; '))
    check('every module comes back', reloaded.patch.modules.length === patch.modules.length)
    check('every cable comes back', reloaded.patch.cables.length === patch.cables.length)

    const back = initialValues(reloaded.patch)
    check('knob positions come back', back['lpf1.cutoff'] === 812.5, String(back['lpf1.cutoff']))
    check('bipolar knobs come back', back['mix1.pan3'] === -0.75, String(back['mix1.pan3']))
    check('the reloaded patch compiles clean', compile(reloaded.patch).warnings.length === 0)
  }
}

// --- a patch that names audio ----------------------------------------
/**
 * A Sampler's file reference has to survive a save, and a file this browser
 * has never seen has to survive a load.
 *
 * The second half is the one that matters: a patch shared with somebody else
 * names audio they do not have, and the right answer is a module that comes
 * up silent and says which file it wants -- not a patch that refuses to open.
 */
console.log('\nsaving a patch that names audio')
{
  const patch: Patch = {
    modules: [
      { id: 'smp1', type: 'sampler', params: {}, sample: { id: 'abc123', name: 'kick.wav' } },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [],
  }
  const stored = toStored('With audio', patch, initialValues(patch))
  const text = JSON.stringify(stored)
  const reloaded = fromStored(JSON.parse(text))

  check('the patch stays small', text.length < 2000, `${text.length} bytes`)
  if ('error' in reloaded) {
    check('a patch naming audio round trips', false, reloaded.error)
  } else {
    const smp = reloaded.patch.modules.find((m) => m.id === 'smp1')
    check('a patch naming audio round trips', !!smp?.sample)
    check('the hash comes back', smp?.sample?.id === 'abc123', String(smp?.sample?.id))
    check('and the name with it, for when the file is missing', smp?.sample?.name === 'kick.wav')
    check('no warnings on our own file', reloaded.warnings.length === 0, reloaded.warnings.join('; '))
  }

  // Hand-edited nonsense in that field must not take the patch down with it.
  const mangled = JSON.parse(text)
  mangled.patch.modules[0].sample = { name: 'no id here' }
  const survived = fromStored(mangled)
  check(
    'a reference with no hash is dropped, not fatal',
    !('error' in survived) && !survived.patch.modules[0].sample,
  )
}

// --- a bundle, for a rack that carries audio -------------------------
/**
 * A patch with a Sampler in it names files the other machine has never had,
 * so it travels as a zip holding both.
 *
 * Read back through the central directory rather than by walking the local
 * headers, which is what lets a bundle survive being unzipped, looked at and
 * zipped again by a file manager -- so the round trip here is the cheap half
 * of the check, and the layout being legible to whoever opens it is the point
 * of the other half.
 */
console.log('\nbundling a rack with its audio')
{
  const patch: Patch = {
    modules: [
      { id: 'smp1', type: 'sampler', params: {}, sample: { id: 'ab12-34', name: 'kick.wav' } },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [],
  }
  const stored = toStored('Kick rack', patch, initialValues(patch))
  const audio = new Uint8Array(512)
  for (let i = 0; i < audio.length; i++) audio[i] = (i * 7) & 0xff

  const zip = makeBundle(stored, [
    { id: 'ab12-34', name: 'kick.wav', type: 'audio/wav', bytes: audio.buffer as ArrayBuffer },
  ])

  check('the bundle is a zip', zip[0] === 0x50 && zip[1] === 0x4b)
  check('and is recognised as one', isZip(zip.slice().buffer as ArrayBuffer))
  check('while a plain patch is not', !isZip(new TextEncoder().encode(JSON.stringify(stored)).buffer as ArrayBuffer))

  const back = await readBundle(zip.slice().buffer as ArrayBuffer)
  const reloaded = fromStored(back.stored)
  check('the patch comes back out', !('error' in reloaded))
  check('with one sample beside it', back.samples.length === 1, `${back.samples.length}`)

  const sample = back.samples[0]
  check('under its own hash', sample?.id === 'ab12-34', String(sample?.id))
  check('and its own name', sample?.name === 'kick.wav', String(sample?.name))

  // Byte for byte: the file that went in is the file that comes out, which is
  // the whole reason the original bytes are what gets stored.
  const out = new Uint8Array(sample.bytes)
  let same = out.length === audio.length
  for (let i = 0; same && i < out.length; i++) same = out[i] === audio[i]
  check('with its bytes untouched', same, `${out.length} of ${audio.length} bytes`)

  // A bundle whose audio was taken out still opens; the module lands in the
  // state a shared patch already lands in.
  const stripped = makeBundle(stored, [])
  const thin = await readBundle(stripped.slice().buffer as ArrayBuffer)
  check('a bundle with no audio in it still opens', thin.samples.length === 0)
}

// --- patches saved before a module was renamed -----------------------
/**
 * The output stage became the recorder. A file saved the day before that
 * should still open, with its cables intact -- otherwise a rename quietly
 * eats other people's work, which is a worse cost than the name was worth.
 */
console.log('\na patch saved against an older module list')
{
  const legacy = {
    version: 1,
    name: 'Before the rename',
    patch: {
      modules: [
        { id: 'osc1', type: 'osc', params: { pitch: 220 } },
        { id: 'mix1', type: 'mixer', params: {} },
        { id: 'out1', type: 'out', params: { master: 0.7 } },
      ],
      cables: [
        { id: 'a', from: { module: 'osc1', port: 'out' }, to: { module: 'mix1', port: 'in1' } },
        { id: 'b', from: { module: 'mix1', port: 'l' }, to: { module: 'out1', port: 'l' } },
      ],
    },
  }

  const loaded = fromStored(legacy)
  if ('error' in loaded) {
    check('an older patch still loads', false, loaded.error)
  } else {
    check('an older patch still loads', true)
    check('the output module became the recorder', loaded.patch.modules[2]?.type === 'rec')
    check('and kept its id', loaded.patch.modules[2]?.id === 'out1')
    check('nothing was dropped', loaded.warnings.length === 0, loaded.warnings.join('; '))
    check('its cables still land', loaded.patch.cables.length === 2)
    // The master fader is gone; a value for it in the file is simply ignored.
    check('the fader it no longer has is forgotten', !('master' in loaded.patch.modules[2].params))
    check('and it compiles clean', compile(loaded.patch).warnings.length === 0)
  }

  // The sample and hold grew from one channel to four. Its old jacks are
  // channel 1's, so a cable drawn to them has somewhere to land.
  const oldSh = {
    version: 1,
    name: 'One channel',
    patch: {
      modules: [
        { id: 'sh1', type: 'sh', params: { rate: 9 } },
        { id: 'lpf1', type: 'ladder', params: {} },
        { id: 'mix1', type: 'mixer', params: {} },
      ],
      cables: [
        { id: 'a', from: { module: 'sh1', port: 'out' }, to: { module: 'lpf1', port: 'cv' } },
        { id: 'b', from: { module: 'lpf1', port: 'out' }, to: { module: 'mix1', port: 'in1' } },
      ],
    },
  }

  const sh = fromStored(oldSh)
  if ('error' in sh) {
    check('a one-channel sample and hold still loads', false, sh.error)
  } else {
    check('a one-channel sample and hold still loads', true)
    check('its Rate became Rate 1', sh.patch.modules[0]?.params.rate1 === 9)
    check('its Out became Out 1', sh.patch.cables[0]?.from.port === 'out1')
    check('nothing was dropped', sh.warnings.length === 0, sh.warnings.join('; '))
    check('and it compiles clean', compile(sh.patch).warnings.length === 0, compile(sh.patch).warnings.join('; '))
  }
}

// --- hostile input ---------------------------------------------------
console.log('\nfiles that are not quite right')
{
  const bad = (label: string, input: unknown, expectError: boolean) => {
    const r = fromStored(input)
    const isError = 'error' in r
    check(label, isError === expectError, isError ? r.error : 'loaded')
    return r
  }

  bad('null is rejected', null, true)
  bad('a bare string is rejected', 'nope', true)
  bad('no version is rejected', { patch: { modules: [] } }, true)
  bad('a future format is rejected', { version: PATCH_FORMAT + 1, patch: { modules: [] } }, true)
  bad('no modules array is rejected', { version: 1, patch: {} }, true)
  bad('an empty rack is allowed', { version: 1, patch: { modules: [], cables: [] } }, false)

  const unknown = fromStored({
    version: 1,
    name: 'Mixed',
    patch: {
      modules: [
        { id: 'osc1', type: 'osc', params: {} },
        { id: 'weird1', type: 'quantumreverb', params: {} },
        { id: 'osc1', type: 'osc', params: {} },
      ],
      cables: [
        { from: { module: 'osc1', port: 'out' }, to: { module: 'weird1', port: 'in' } },
      ],
    },
  })
  if ('error' in unknown) {
    check('an unknown module type does not fail the load', false, unknown.error)
  } else {
    check('an unknown module type does not fail the load', true)
    check('the unknown module is dropped', unknown.patch.modules.length === 1)
    check('a duplicate id is dropped', unknown.patch.modules.filter((m) => m.id === 'osc1').length === 1)
    check('its cable goes with it', unknown.patch.cables.length === 0)
    check('all three are reported', unknown.warnings.length === 3, unknown.warnings.join(' | '))
  }

  const clamped = fromStored({
    version: 1,
    patch: {
      modules: [{ id: 'lpf1', type: 'ladder', params: { cutoff: 999999, resonance: -5, drive: 'loud' } }],
      cables: [],
    },
  })
  if ('error' in clamped) {
    check('out-of-range values are clamped', false, clamped.error)
  } else {
    const v = initialValues(clamped.patch)
    check('a value over maximum is clamped', v['lpf1.cutoff'] === 18000, String(v['lpf1.cutoff']))
    check('a value under minimum is clamped', v['lpf1.resonance'] === 0, String(v['lpf1.resonance']))
    check('a non-numeric value falls back to the default', v['lpf1.drive'] === 1.5, String(v['lpf1.drive']))
  }
}

// --- bypass, module clipboard, cable colours ----------------------------
console.log('\nbypass')
{
  const mod = (id: string, type: string) => ({ id, type, params: {} })
  let p: Patch = {
    modules: [mod('osc1', 'osc'), mod('lpf1', 'ladder'), mod('dly1', 'delay'), mod('mix1', 'mixer')],
    cables: [],
  }
  p = wireUp(p, { module: 'osc1', port: 'out' }, { module: 'lpf1', port: 'in' })
  p = wireUp(p, { module: 'lpf1', port: 'out' }, { module: 'dly1', port: 'in' })
  p = wireUp(p, { module: 'dly1', port: 'out' }, { module: 'mix1', port: 'in1' })
  p = wireUp(p, { module: 'dly1', port: 'wet' }, { module: 'mix1', port: 'in2' })

  const from = (q: Patch, to: string) => {
    const c = q.cables.find((x) => `${x.to.module}.${x.to.port}` === to)
    return c ? `${c.from.module}.${c.from.port}` : 'nothing'
  }
  const one = withBypass(toggleBypass(p, 'lpf1'))
  check('a bypassed filter passes what fed it on to what it fed', from(one, 'dly1.in') === 'osc1.out', from(one, 'dly1.in'))
  const both = withBypass(toggleBypass(toggleBypass(p, 'lpf1'), 'dly1'))
  check('and two in a row pass it straight through', from(both, 'mix1.in1') === 'osc1.out', from(both, 'mix1.in1'))
  check("a bypassed delay's Wet goes quiet rather than passing the dry", from(both, 'mix1.in2') === 'nothing')
  check('the module is still there, still fed', from(both, 'lpf1.in') === 'osc1.out')
  check('the patch itself is not rewired, only what is compiled', from(toggleBypass(p, 'lpf1'), 'dly1.in') === 'lpf1.out')
  check('switching it back in is the patch it was', JSON.stringify(toggleBypass(toggleBypass(p, 'lpf1'), 'lpf1')) === JSON.stringify(p))
  check('a module that cannot be bypassed is left alone', toggleBypass(p, 'osc1') .modules[0].bypass === undefined)
  check('it compiles clean', compile(toggleBypass(p, 'dly1')).warnings.length === 0, compile(toggleBypass(p, 'dly1')).warnings.join('; '))

  const saved = fromStored(JSON.parse(JSON.stringify(toStored('b', toggleBypass(setCableColor(p, p.cables[0].id, 200), 'lpf1'), {}))))
  const back = 'error' in saved ? null : saved.patch
  check('bypass is saved with the patch', back?.modules.find((m) => m.id === 'lpf1')?.bypass === true)
  check('and so is a cable colour', back?.cables[0].color === 200, String(back?.cables[0].color))
}

console.log('\ncopying modules')
{
  let p: Patch = {
    modules: [
      { id: 'osc1', type: 'osc', params: {} },
      { id: 'lpf1', type: 'ladder', params: {} },
      { id: 'mix1', type: 'mixer', params: {} },
    ],
    cables: [],
  }
  p = wireUp(p, { module: 'osc1', port: 'out' }, { module: 'lpf1', port: 'in' })
  p = wireUp(p, { module: 'lpf1', port: 'out' }, { module: 'mix1', port: 'in1' })
  const values = { 'osc1.pitch': 330, 'lpf1.cutoff': 900 }
  const clip = copyModules(p, values, ['osc1', 'lpf1'])
  check('a copy holds the modules and the cable between them', clip.modules.length === 2 && clip.cables.length === 1)
  check('but not the cable to what was left behind', !clip.cables.some((c) => c.to.module === 'mix1'))
  check('and the knobs where they were standing', clip.modules[0].params.pitch === 330)

  const out = pasteModules(p, values, clip)
  check('pasting gives them fresh ids', out.ids.join() === 'osc2,lpf2', out.ids.join())
  check('wired to each other', out.patch.cables.some((c) => c.from.module === 'osc2' && c.to.module === 'lpf2'))
  check('with their knobs', out.values['osc2.pitch'] === 330 && out.values['lpf2.cutoff'] === 900)
  check('and the originals untouched', out.values['osc1.pitch'] === 330 && out.patch.cables.length === 3)

  const other: Patch = { modules: [{ id: 'mix1', type: 'mixer', params: {} }], cables: [] }
  const there = pasteModules(other, {}, clip)
  check('into another rack as well', there.ids.join() === 'osc1,lpf1' && compile(there.patch).warnings.length === 0, there.ids.join())
}

console.log('\nwhat a cable carries')
{
  check('an oscillator makes sound', signalOf('osc', 'out') === 'audio')
  check('its envelope is control', signalOf('osc', 'env') === 'cv')
  check('an LFO is control', signalOf('lfo', 'out') === 'cv')
  check('a clock is gates', signalOf('clock', 'd4') === 'gate' && signalOf('sh', 'clk3') === 'gate')
  check('a keyboard sends a pitch and a gate', signalOf('keys', 'pitch') === 'cv' && signalOf('keys', 'gate') === 'gate')
  check('a stereo effect sends sound', signalOf('reverb', 'l') === 'audio')
}

console.log(failures === 0 ? '\nall clear' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
