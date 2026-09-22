/**
 * Checks for patch editing and the save format.
 *
 * Saved files get hand-edited and outlive the module list they were written
 * against, so loading leans on being defensive rather than on the file being
 * well formed.
 *
 * Run with: npm run check:patch
 */
import { compile } from '../src/patch/compile'
import { defOf } from '../src/patch/defs'
import { defaultPatch } from '../src/patch/defaultPatch'
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
import { fromStored, toStored, PATCH_FORMAT } from '../src/patch/serialize'

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// --- editing ---------------------------------------------------------
console.log('\nediting the rack')
{
  const base = defaultPatch()

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
  check('the original patch is untouched', base.modules.length === defaultPatch().modules.length)
  check('a new module compiles', compile(added).warnings.length === 0)

  const removed = removeModule(base, 'lpf1')
  check('removing a module shrinks the rack', removed.modules.length === base.modules.length - 1)
  check(
    'its cables go with it',
    removed.cables.every((c) => c.from.module !== 'lpf1' && c.to.module !== 'lpf1'),
  )
  check('what is left still compiles', compile(removed).warnings.length === 0)

  const order = (p: ReturnType<typeof defaultPatch>) => p.modules.map((m) => m.id).join(',')
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
  const patch = defaultPatch()
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

console.log(failures === 0 ? '\nall clear' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
