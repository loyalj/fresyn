import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine } from './audio/AudioEngine'
import { renderVariation } from './audio/render'
import { encodeWav } from './audio/wav'
import { peakEnvelope } from './audio/waveform'
import { makeZip, type ZipEntry } from './audio/zip'
import { MODE_LATCH } from './dsp/modules/Gate'
import { useInput } from './input/useInput'
import { defOf, MODULE_GROUPS, modulesByGroup } from './patch/defs'
import { defaultPatch } from './patch/defaultPatch'
import { type Template } from './patch/library'
import {
  addModule,
  addModuleAfter,
  cableInto,
  connect,
  disconnect,
  disconnectAt,
  initialValues,
  moveModule,
  nextModuleId,
  reconcileValues,
  removeModule,
  reorderModules,
  setModuleKey,
  type PortRef,
} from './patch/edit'
import { canRedo, canUndo, commit, initHistory, redo, undo, type History } from './patch/history'
import { toStored } from './patch/serialize'
import { downloadBytes, downloadPatch, loadLocal, readPatchFile, saveLocal, slug } from './patch/storage'
import type { Patch, PatchModule } from './patch/types'
import { Cables, type DragState } from './ui/Cables'
import { nearestCable, type JackGeometry } from './ui/cableGeometry'
import { EngineContext } from './ui/EngineContext'
import { ExportPanel, type ExportSettings } from './ui/ExportPanel'
import { jackKey, type JackKind } from './ui/Jack'
import { LibraryDialog } from './ui/LibraryDialog'
import { MenuBar, type MenuDef } from './ui/Menu'
import { RackUnit } from './ui/RackUnit'
import { TakeList, type Take } from './ui/TakeList'
import { THEMES } from './ui/theme'
import { ThemeContext, useAppearanceState } from './ui/ThemeContext'
import { TriggerButton } from './ui/TriggerButton'
import { UnitSpine } from './ui/UnitSpine'
import { useRackDrag } from './ui/useRackDrag'

/** Must match the flip transition in app.css. */
const FLIP_MS = 420
/**
 * Things on a panel that handle their own clicks. The rack hit-tests cables
 * under the pointer, so without this a click on a unit's remove button would
 * also unplug whatever cable happened to run behind it.
 */
const PANEL_CONTROLS = '.jack, .unit-controls, .unit-spine'
const AUTOSAVE_MS = 400
/** Edits to the same control inside this window fold into one undo step. */
const COALESCE_MS = 600
const WAVE_COLUMNS = 200

/** Everything undo and save are concerned with. */
interface Doc {
  patch: Patch
  values: Record<string, number>
  name: string
}

export default function App() {
  // Restore the last session, or start from the stock rack.
  const initialDoc = useMemo<Doc>(() => {
    const loaded = loadLocal()
    const patch = loaded?.patch ?? defaultPatch()
    return { patch, values: initialValues(patch), name: loaded?.name ?? 'Untitled' }
  }, [])

  const [history, setHistory] = useState<History<Doc>>(() => initHistory(initialDoc))
  const { patch, values, name } = history.present

  // The engine outlives any single patch; it is rewired, never replaced.
  const engine = useMemo(() => new AudioEngine(initialDoc.patch), [initialDoc])

  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [takes, setTakes] = useState<Take[]>([])
  const [playing, setPlaying] = useState<number | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)
  const [lastSettings, setLastSettings] = useState<ExportSettings | null>(null)

  const [appearance, setAppearance] = useAppearanceState()

  /**
   * Stable across renders that do not change the rack, so the drag hook and
   * the geometry pass below can both take it as a dependency.
   */
  const moduleIds = useMemo(() => patch.modules.map((m) => m.id), [patch])

  const [flipped, setFlipped] = useState(false)
  const [turning, setTurning] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [geometry, setGeometry] = useState<JackGeometry>({})
  const [hoveredCable, setHoveredCable] = useState<string | undefined>()
  /**
   * The rack stands down while a menu is open. Without it, arrowing down a
   * menu would scroll the page and a bound key would play the instrument.
   */
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * The Trigger whose key cap is waiting to be told which key, if any. One at
   * a time: the wait takes the whole keyboard, so a second cap listening at
   * the same time would be two panels racing for the same press.
   */
  const [listening, setListening] = useState<string | null>(null)
  /** True while the patch library is up, which takes the keyboard with it. */
  const [libraryOpen, setLibraryOpen] = useState(false)
  /**
   * Triggers currently latched open, by module id.
   *
   * Latch is the one fire mode that is not in the DSP. It changes what a press
   * means rather than what the gate carries, so the audio thread sees nothing
   * but an ordinary held gate that the release never arrives for. Keeping it
   * here is also what lets the button light up: a Trigger has no inputs, so
   * the key and the button are the only things that can open one, and both of
   * them are already on this side.
   */
  const [latched, setLatched] = useState<ReadonlySet<string>>(() => new Set())
  /** Matches the width at which the rack itself drops to a single column. */
  const [narrow, setNarrow] = useState(false)

  const rackRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const jackEls = useRef(new Map<string, HTMLElement>())
  const dragRef = useRef<DragState | null>(null)
  const stopPreview = useRef<(() => void) | null>(null)
  const coalesceKey = useRef<string | null>(null)
  const coalesceAt = useRef(0)

  useEffect(() => {
    dragRef.current = drag
  })

  useEffect(() => {
    const q = window.matchMedia('(max-width: 760px)')
    const sync = () => setNarrow(q.matches)
    sync()
    q.addEventListener('change', sync)
    return () => q.removeEventListener('change', sync)
  }, [])

  // --- document ------------------------------------------------------
  /**
   * `key` groups rapid edits to the same control into one undo step. Whether
   * to coalesce is decided out here rather than inside the updater, because
   * StrictMode runs updaters twice and the second pass would see its own
   * timestamp and reach a different answer.
   */
  const commitDoc = useCallback((next: (doc: Doc) => Doc, key?: string) => {
    const now = Date.now()
    const fold =
      key !== undefined && key === coalesceKey.current && now - coalesceAt.current < COALESCE_MS
    coalesceKey.current = key ?? null
    coalesceAt.current = now
    setHistory((h) => commit(h, next(h.present), fold))
  }, [])

  const editPatch = useCallback(
    (fn: (p: Patch) => Patch) => {
      commitDoc((doc) => {
        const next = fn(doc.patch)
        if (next === doc.patch) return doc
        return { ...doc, patch: next, values: reconcileValues(next, doc.values) }
      })
    },
    [commitDoc],
  )

  const onReorder = useCallback(
    (ids: string[]) => editPatch((p) => reorderModules(p, ids)),
    [editPatch],
  )

  // Dragging a unit by its spine. The rack reorders under the pointer while
  // the patch stays put, and one edit lands when the drag is let go.
  const rack = useRackDrag(moduleIds, rackRef, onReorder)

  const setParam = useCallback(
    (moduleId: string, paramId: string, value: number) => {
      const key = `${moduleId}.${paramId}`
      commitDoc((doc) => ({ ...doc, values: { ...doc.values, [key]: value } }), `param:${key}`)
    },
    [commitDoc],
  )

  const setName = useCallback(
    (next: string) => commitDoc((doc) => ({ ...doc, name: next }), 'name'),
    [commitDoc],
  )

  const stepBack = useCallback(() => {
    coalesceKey.current = null
    setHistory(undo)
  }, [])

  const stepForward = useCallback(() => {
    coalesceKey.current = null
    setHistory(redo)
  }, [])

  // --- engine sync ---------------------------------------------------
  // `values` is read from this render rather than taken as a dependency: the
  // document commits a patch and its reconciled knobs together, so the values
  // in scope here are already the right ones for this patch.
  useEffect(() => {
    engine.setPatch(patch, values)
  }, [engine, patch]) // eslint-disable-line react-hooks/exhaustive-deps

  // Every knob change lands here, whether from a drag, an undo or a load.
  useEffect(() => {
    engine.setValues(values)
  }, [engine, values])

  useEffect(() => {
    const t = setTimeout(() => saveLocal(toStored(name, patch, values)), AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [name, patch, values])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  // --- geometry ------------------------------------------------------
  const registerJack = useCallback((key: string, el: HTMLElement | null) => {
    if (el) jackEls.current.set(key, el)
    else jackEls.current.delete(key)
  }, [])

  const measure = useCallback(() => {
    const host = rackRef.current
    if (!host) return
    const base = host.getBoundingClientRect()
    const next: JackGeometry = {}
    for (const [key, el] of jackEls.current) {
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue // a face that is currently turned away
      next[key] = {
        x: r.left - base.left + r.width / 2,
        y: r.top - base.top + r.height / 2,
      }
    }
    setGeometry(next)
  }, [])

  // Jack positions are read off the DOM, so they are only meaningful once the
  // rack has finished turning and the layout has settled. `rack.order` is in
  // here so that cables follow a unit being dragged up the rack, rather than
  // staying where it used to be until the drag is let go.
  useLayoutEffect(() => {
    if (turning) return
    measure()
  }, [measure, turning, flipped, patch, rack.order])

  useEffect(() => {
    const host = rackRef.current
    if (!host) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(host)
    return () => ro.disconnect()
  }, [measure])

  // --- flip ----------------------------------------------------------
  const flip = useCallback(() => {
    setTurning(true)
    setFlipped((f) => !f)
  }, [])

  useEffect(() => {
    if (!turning) return
    const t = setTimeout(() => setTurning(false), FLIP_MS + 40)
    return () => clearTimeout(t)
  }, [turning, flipped])

  // --- rack editing --------------------------------------------------
  const onAddModule = useCallback(
    (type: string) =>
      editPatch((p) => {
        // A Trigger arrives on Space, so the first one in a rack plays without
        // a trip to its cap first. Later ones land on the same key and fire
        // together until they are told otherwise, which is the honest default:
        // a key that does nothing would look broken.
        const key = defOf(type).keyed ? 'Space' : undefined
        const module = { id: nextModuleId(p, type), type, params: {}, ...(key ? { key } : {}) }
        return addModule(p, module, 'top')
      }),
    [editPatch],
  )

  const onAssignKey = useCallback(
    (id: string, code: string | undefined) => editPatch((p) => setModuleKey(p, id, code)),
    [editPatch],
  )

  const onRemoveModule = useCallback(
    (id: string) => editPatch((p) => removeModule(p, id)),
    [editPatch],
  )

  /**
   * Copy a unit, with its knobs where they are standing rather than where the
   * patch last wrote them.
   *
   * Not `editPatch`, which is the one thing that makes this worth its own
   * function: live knob positions are held beside the patch, and `editPatch`
   * seeds anything new from its defaults. That is right for a module added
   * from the menu and exactly wrong for a copy, which would arrive at factory
   * settings and look like it had not copied anything at all.
   *
   * Cables are not copied. A duplicate is a fresh unit waiting to be wired,
   * and one that arrived already patched into the original's destinations
   * would have had to unplug them to do it -- an input holds one cable.
   */
  const onDuplicateModule = useCallback(
    (id: string) => {
      commitDoc((doc) => {
        const source = doc.patch.modules.find((m) => m.id === id)
        if (!source) return doc

        const copy: PatchModule = {
          id: nextModuleId(doc.patch, source.type),
          type: source.type,
          params: { ...source.params },
        }
        // The key comes with it. A copy is a copy, and two Triggers on one key
        // firing together is a layer -- which is a reason to duplicate one in
        // the first place. The cap on the new panel is how it gets its own.
        if (source.key) copy.key = source.key

        const patch = addModuleAfter(doc.patch, id, copy)
        const values = reconcileValues(patch, doc.values)
        for (const spec of defOf(source.type).params) {
          const held = doc.values[`${id}.${spec.id}`]
          if (held !== undefined) values[`${copy.id}.${spec.id}`] = held
        }
        return { ...doc, patch, values }
      })
    },
    [commitDoc],
  )

  const onMoveModule = useCallback(
    (id: string, delta: number) => editPatch((p) => moveModule(p, id, delta)),
    [editPatch],
  )

  /** Replace the whole rack: knobs come from the incoming patch, not kept. */
  /**
   * Put a whole different rack on the bench.
   *
   * `preset` is sparse and optional: a patch from a file carries its knobs in
   * its modules, but a template carries them separately, so anything it does
   * not mention is left wherever the module's own default puts it.
   */
  const applyPatch = useCallback(
    (next: Patch, nextName: string, preset?: Record<string, number>) => {
      coalesceKey.current = null
      const values = preset ? { ...initialValues(next), ...preset } : initialValues(next)
      commitDoc(() => ({ patch: next, values, name: nextName }))
    },
    [commitDoc],
  )

  /**
   * No confirmation step any more. It used to be a button on the bar, where a
   * stray click could land on it; reaching it now means opening a menu and
   * choosing it. And `applyPatch` commits through the history like any other
   * edit, so the way back is the way back from everything else.
   */
  const onNew = useCallback(() => {
    applyPatch(defaultPatch(), 'Untitled')
    setNotice('Started a new rack -- Ctrl+Z to undo')
  }, [applyPatch])

  /**
   * Start from a template.
   *
   * It arrives as an ordinary patch under the template's name, and from that
   * moment the library has nothing more to do with it: there is no way back
   * to the shelf and nothing is ever written to it. The one commit means the
   * way out is Ctrl+Z, the same as every other edit.
   */
  const onPickTemplate = useCallback(
    (template: Template) => {
      const { patch: next, values: preset } = template.build()
      applyPatch(next, template.name, preset)
      setLibraryOpen(false)
      setNotice(`Loaded ${template.name} -- Ctrl+Z to undo`)
    },
    [applyPatch],
  )

  const onExportPatch = useCallback(() => {
    downloadPatch(toStored(name, patch, values))
  }, [name, patch, values])

  const onImport = useCallback(
    async (file: File) => {
      const result = await readPatchFile(file)
      if ('error' in result) {
        setNotice(result.error)
        return
      }
      applyPatch(result.patch, result.name)
      setNotice(
        result.warnings.length
          ? `Loaded with ${result.warnings.length} warning(s): ${result.warnings[0]}`
          : `Loaded ${result.name}`,
      )
      for (const w of result.warnings) console.warn('[fresyn load]', w)
    },
    [applyPatch],
  )

  // --- rendering and audition ----------------------------------------
  const stop = useCallback(() => {
    stopPreview.current?.()
    stopPreview.current = null
    setPlaying(null)
  }, [])

  useEffect(() => () => stopPreview.current?.(), [])

  const onRender = useCallback(
    async (settings: ExportSettings) => {
      stop()
      setTakes([])
      setLastSettings(settings)
      setExporting('Rendering')

      try {
        const rendered: Take[] = []
        for (let i = 0; i < settings.count; i++) {
          setExporting(`Take ${i + 1} of ${settings.count}`)
          // Rendering is synchronous and fast, but a batch still has to let
          // the page paint between takes or the progress never appears.
          await nextFrame()

          const take = renderVariation(
            patch,
            values,
            {
              sampleRate: settings.sampleRate,
              duration: settings.duration,
              gateSeconds: settings.gateSeconds,
              seed: settings.seed,
            },
            i,
            settings.spread,
          )
          rendered.push({
            index: i,
            seed: take.seed,
            seconds: take.seconds,
            peak: take.peak,
            sampleRate: take.sampleRate,
            left: take.left,
            right: take.right,
            envelope: peakEnvelope(take.left, take.right, WAVE_COLUMNS),
            keep: true,
          })
        }
        setTakes(rendered)
        setNotice(`Rendered ${rendered.length} take${rendered.length === 1 ? '' : 's'}`)
      } catch (err) {
        setNotice(`Render failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setExporting(null)
      }
    },
    [patch, values, stop],
  )

  const onPlayTake = useCallback(
    async (index: number) => {
      const wasPlaying = playing === index
      stop()
      if (wasPlaying) return

      const take = takes.find((t) => t.index === index)
      if (!take) return

      setPlaying(index)
      stopPreview.current = await engine.preview(
        take.left,
        take.right,
        take.sampleRate,
        // This also fires when we stop it early, so only clear if the take
        // that ended is still the one showing as playing.
        () => setPlaying((p) => (p === index ? null : p)),
      )
    },
    [engine, takes, playing, stop],
  )

  const onDownloadTakes = useCallback(() => {
    const kept = takes.filter((t) => t.keep)
    if (kept.length === 0) return

    const bitDepth = lastSettings?.bitDepth ?? 16
    const base = slug(name)
    const files: ZipEntry[] = kept.map((take) => ({
      name:
        kept.length === 1
          ? `${base}.wav`
          : `${base}_${String(take.index + 1).padStart(2, '0')}.wav`,
      data: encodeWav([take.left, take.right], take.sampleRate, bitDepth),
    }))

    if (files.length === 1) downloadBytes(files[0].data, files[0].name, 'audio/wav')
    else downloadBytes(makeZip(files), `${base}.zip`, 'application/zip')
    setNotice(`Saved ${files.length} take${files.length === 1 ? '' : 's'}`)
  }, [takes, name, lastSettings])

  // --- cables --------------------------------------------------------
  const occupied = useMemo(() => {
    const s = new Set<string>()
    for (const c of patch.cables) {
      s.add(jackKey(c.from))
      s.add(jackKey(c.to))
    }
    return s
  }, [patch])

  const isOccupied = useCallback((ref: PortRef) => occupied.has(jackKey(ref)), [occupied])

  const isCandidate = useCallback(
    (_ref: PortRef, kind: JackKind) => drag !== null && kind !== drag.anchorKind,
    [drag],
  )

  const cursorIn = (e: { clientX: number; clientY: number }) => {
    const base = rackRef.current?.getBoundingClientRect()
    if (!base) return { x: 0, y: 0 }
    return { x: e.clientX - base.left, y: e.clientY - base.top }
  }

  const onJackDown = useCallback(
    (ref: PortRef, kind: JackKind, e: React.PointerEvent) => {
      e.preventDefault()

      // Right-click clears a jack outright; the context menu is suppressed by
      // the input layer so the button is free for this.
      if (e.button === 2) {
        editPatch((p) => disconnectAt(p, ref))
        return
      }

      const cursor = cursorIn(e)

      // Grabbing a patched input pulls that cable out and leaves you holding
      // the loose end, the way it works on a real panel.
      if (kind === 'input') {
        const existing = cableInto(patch, ref)
        if (existing) {
          editPatch((p) => disconnect(p, existing.id))
          setDrag({ anchor: existing.from, anchorKind: 'output', cursor })
          return
        }
      }
      setDrag({ anchor: ref, anchorKind: kind, cursor })
    },
    [patch, editPatch],
  )

  // Cables are hit-tested here rather than through SVG hit areas, so that a
  // jack a cable happens to cross stays usable. The jack gets first refusal.
  const onRackPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!flipped || drag || rack.id) return
      if (e.target instanceof Element && e.target.closest(PANEL_CONTROLS)) return
      const hit = nearestCable(patch, geometry, cursorIn(e))
      if (hit) editPatch((p) => disconnect(p, hit.id))
    },
    [flipped, drag, rack.id, patch, geometry, editPatch],
  )

  const onRackPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!flipped || drag || rack.id) {
        setHoveredCable(undefined)
        return
      }
      if (e.target instanceof Element && e.target.closest(PANEL_CONTROLS)) {
        setHoveredCable(undefined)
        return
      }
      setHoveredCable(nearestCable(patch, geometry, cursorIn(e))?.id)
    },
    [flipped, drag, rack.id, patch, geometry],
  )

  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return

    const move = (e: PointerEvent) => {
      const cursor = cursorIn(e)
      setDrag((d) => (d ? { ...d, cursor } : d))
    }

    const up = (e: PointerEvent) => {
      const current = dragRef.current
      setDrag(null)
      if (!current) return

      // Hit-test through the document rather than capturing the pointer:
      // capture would deliver pointerup to the jack the drag started on.
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const target = el instanceof Element ? el.closest('.jack') : null
      if (!(target instanceof HTMLElement)) return

      const kind = target.dataset.kind as JackKind | undefined
      const ref = { module: target.dataset.module ?? '', port: target.dataset.port ?? '' }
      if (!kind || kind === current.anchorKind) return

      const from = current.anchorKind === 'output' ? current.anchor : ref
      const to = current.anchorKind === 'output' ? ref : current.anchor
      editPatch((p) => connect(p, from, to))
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, editPatch])

  // --- transport -----------------------------------------------------
  /**
   * Open one module's gate. There is no rack-wide gate any more: a Trigger is
   * played by its own key or its own button, and everything else in the rack
   * hears it down a cable.
   *
   * The gate is recorded before the context is asked to open, not after. The
   * other way round it would land behind an await, and a key tapped while the
   * context was still booting would open a gate whose release had already gone
   * past -- a note stuck on from the first press of the session.
   */
  const gateOn = useCallback(
    (moduleId: string) => {
      engine.gate(true, moduleId)
      void engine.start().then(() => setRunning(true))
    },
    [engine],
  )

  const gateOff = useCallback((moduleId: string) => engine.gate(false, moduleId), [engine])

  /** A module's Mode, as the knob currently reads. */
  const modeOf = useCallback(
    (moduleId: string) => Math.round(values[`${moduleId}.mode`] ?? 0),
    [values],
  )

  /**
   * A press, wherever it came from. The key and the panel button both arrive
   * here so that a mode means the same thing however the Trigger was played.
   */
  const press = useCallback(
    (moduleId: string) => {
      if (modeOf(moduleId) !== MODE_LATCH) {
        gateOn(moduleId)
        return
      }
      const on = latched.has(moduleId)
      if (on) gateOff(moduleId)
      else gateOn(moduleId)
      setLatched((prev) => {
        const next = new Set(prev)
        if (on) next.delete(moduleId)
        else next.add(moduleId)
        return next
      })
    },
    [latched, modeOf, gateOn, gateOff],
  )

  /** The release. A latched Trigger ignores it; that is the whole of latch. */
  const release = useCallback(
    (moduleId: string) => {
      if (modeOf(moduleId) === MODE_LATCH) return
      gateOff(moduleId)
    },
    [modeOf, gateOff],
  )

  /**
   * Let go of anything latched that has no business still being open: a
   * Trigger taken out of the rack, or one whose Mode has been turned off
   * latch while it was on. Without this the gate would be held by a module
   * nobody can reach any more, and the only way out would be a reload.
   */
  useEffect(() => {
    if (latched.size === 0) return
    const stale = [...latched].filter(
      (id) => !patch.modules.some((m) => m.id === id) || modeOf(id) !== MODE_LATCH,
    )
    if (stale.length === 0) return
    for (const id of stale) gateOff(id)
    setLatched((prev) => {
      const next = new Set(prev)
      for (const id of stale) next.delete(id)
      return next
    })
  }, [latched, patch.modules, modeOf, gateOff])

  /**
   * The rack's playable keys, read off the patch.
   *
   * Grouped by key before they become bindings because the input layer holds
   * one binding per key: two Triggers on W have to arrive as a single binding
   * that opens both gates, or the second would quietly replace the first.
   */
  const triggerKeys = useMemo(() => {
    const byCode = new Map<string, string[]>()
    for (const m of patch.modules) {
      if (!defOf(m.type).keyed || !m.key) continue
      byCode.set(m.key, [...(byCode.get(m.key) ?? []), m.id])
    }
    return [...byCode].map(([code, ids]) => ({
      code,
      onDown: () => {
        for (const id of ids) press(id)
      },
      onUp: () => {
        for (const id of ids) release(id)
      },
    }))
  }, [patch.modules, press, release])

  // All browser input is captured in one place: without it a held key
  // auto-repeats past the handler and scrolls the page, and right-click opens
  // the browser menu over the rack.
  //
  // The rack's own shortcuts come last so they win a collision. A cap refuses
  // to take one of them in the first place, so this is only a backstop -- for
  // a patch file that named Tab before that rule existed, say.
  useInput({
    // A cap waiting for a key needs the keyboard to itself, or the key being
    // assigned would fire whatever it is already bound to on the way past.
    suspended: menuOpen || libraryOpen || listening !== null,
    bindings: [
      ...triggerKeys,
      { code: 'Tab', onDown: flip },
      { code: 'KeyZ', ctrl: true, onDown: stepBack },
      { code: 'KeyZ', ctrl: true, shift: true, onDown: stepForward },
      { code: 'KeyY', ctrl: true, onDown: stepForward },
    ],
  })

  /**
   * The render controls live on the recorder's panel. They go to the first
   * recorder in the rack, which is the one the compiler takes the render
   * from, so a rack with a spare recorder does not grow a second set of
   * controls that render something you cannot hear.
   */
  const recorderHost = patch.modules.find((m) => m.type === 'rec')?.id
  /** The rack renders in the drag's order, which is a list of ids. */
  const byId = new Map(patch.modules.map((m) => [m.id, m]))
  const recorder = (
    <>
      <ExportPanel onExport={(s) => void onRender(s)} busy={exporting} />
      <TakeList
        takes={takes}
        playing={playing}
        onPlay={(i) => void onPlayTake(i)}
        onToggleKeep={(i) =>
          setTakes((prev) => prev.map((t) => (t.index === i ? { ...t, keep: !t.keep } : t)))
        }
        onKeepAll={(keep) => setTakes((prev) => prev.map((t) => ({ ...t, keep })))}
        onExport={onDownloadTakes}
        onDiscard={() => {
          stop()
          setTakes([])
        }}
      />
    </>
  )

  const menus: MenuDef[] = [
    {
      label: 'Patch',
      items: [
        { kind: 'action', label: 'New', onSelect: onNew },
        { kind: 'action', label: 'Library...', onSelect: () => setLibraryOpen(true) },
        { kind: 'separator' },
        { kind: 'action', label: 'Import file...', onSelect: () => fileRef.current?.click() },
        { kind: 'action', label: 'Export file...', onSelect: onExportPatch },
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          kind: 'action', label: 'Undo', shortcut: 'Ctrl+Z',
          disabled: !canUndo(history), onSelect: stepBack,
        },
        {
          kind: 'action', label: 'Redo', shortcut: 'Ctrl+Shift+Z',
          disabled: !canRedo(history), onSelect: stepForward,
        },
      ],
    },
    {
      label: 'Modules',
      // Grouped from the catalogue itself, so a new module appears here
      // without this file knowing anything about it.
      items: MODULE_GROUPS.map((g) => ({
        kind: 'submenu' as const,
        label: g.name,
        items: modulesByGroup(g.id).map((def) => ({
          kind: 'action' as const,
          label: def.name,
          onSelect: () => onAddModule(def.type),
        })),
      })),
    },
    {
      label: 'View',
      items: [
        { kind: 'toggle', label: 'Back panel', shortcut: 'Tab', checked: flipped, onSelect: flip },
        { kind: 'separator' },
        {
          kind: 'submenu',
          label: 'Theme',
          items: THEMES.map((t) => ({
            kind: 'toggle' as const,
            label: t.name,
            checked: appearance.theme === t.id,
            onSelect: () => setAppearance({ ...appearance, theme: t.id }),
          })),
        },
        {
          kind: 'submenu',
          label: 'Appearance',
          items: (['dark', 'light'] as const).map((m) => ({
            kind: 'toggle' as const,
            label: m === 'dark' ? 'Dark' : 'Light',
            checked: appearance.mode === m,
            onSelect: () => setAppearance({ ...appearance, mode: m }),
          })),
        },
      ],
    },
  ]

  return (
    <div className="app">
      <header className="masthead">
        {/* The nameplate, with the lamp that says the engine is running. */}
        <div className="masthead-brand">
          <h1>Fresyn</h1>
          <span className={`led ${running ? 'on' : ''}`} />
        </div>

        <MenuBar menus={menus} onOpenChange={setMenuOpen} collapsed={narrow} />

        <input
          className="patch-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Patch name"
          spellCheck={false}
        />

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onImport(file)
            e.target.value = ''
          }}
        />

        {/* Kept on the bar rather than left to the View menu alone: this is
            the control the rack is actually worked with, and burying the
            most-pressed button in the app would be a poor trade for the room
            it frees. */}
        <button className="flip-button" onClick={flip} title="Turn the rack around (Tab)">
          {flipped ? 'Front' : 'Back'}
        </button>
      </header>

      {libraryOpen && (
        <LibraryDialog onPick={onPickTemplate} onClose={() => setLibraryOpen(false)} />
      )}

      {notice && <div className="notice">{notice}</div>}

      {/* Panels that show live audio, such as the scope, take the engine from
          here rather than being handed it down through every rack unit. The
          appearance rides along for the same reason: a canvas cannot read the
          stylesheet, so the scope has to be told when the palette changed. */}
      <ThemeContext.Provider value={appearance}>
        <EngineContext.Provider value={engine}>
          <div
            className={`rack${flipped ? ' rack-flipped' : ''}${
              hoveredCable ? ' grabbing-cable' : ''
            }${rack.id ? ' reordering' : ''}`}
            ref={rackRef}
            onPointerDown={onRackPointerDown}
            onPointerMove={onRackPointerMove}
            onPointerLeave={() => setHoveredCable(undefined)}
          >
            {rack.order.flatMap((id) => byId.get(id) ?? []).map((m) => (
              <RackUnit
                key={m.id}
                def={defOf(m.type)}
                moduleId={m.id}
                flipped={flipped}
                onGrab={(e) => rack.start(m.id, e)}
                onGate={(open) => (open ? gateOn(m.id) : gateOff(m.id))}
                dragging={rack.id === m.id}
                faceExtra={
                  defOf(m.type).trigger ? (
                    <TriggerButton
                      onDown={() => press(m.id)}
                      onUp={() => release(m.id)}
                      latched={latched.has(m.id)}
                      // Only a keyed module is handed the assignment props, so
                      // the cap appears on the Trigger and nowhere else.
                      {...(defOf(m.type).keyed
                        ? {
                            keyCode: m.key,
                            listening: listening === m.id,
                            onListen: (on: boolean) => setListening(on ? m.id : null),
                            onAssign: (code: string | undefined) => onAssignKey(m.id, code),
                          }
                        : {})}
                    />
                  ) : m.id === recorderHost ? (
                    recorder
                  ) : undefined
                }
                valueOf={(paramId) => values[`${m.id}.${paramId}`]}
                onChange={(paramId, v) => setParam(m.id, paramId, v)}
                isOccupied={isOccupied}
                isCandidate={isCandidate}
                register={registerJack}
                onJackDown={onJackDown}
                onMove={(delta) => onMoveModule(m.id, delta)}
                onDuplicate={() => onDuplicateModule(m.id)}
                onRemove={() => onRemoveModule(m.id)}
              />
            ))}

            {flipped && !turning && (
              <Cables patch={patch} geometry={geometry} drag={drag} hovered={hoveredCable} />
            )}
          </div>
        </EngineContext.Provider>
      </ThemeContext.Provider>

      {/* The panel in hand. It rides outside the rack because the rack sets a
          perspective, and a perspective is a containing block -- a fixed
          element inside one is positioned against it rather than the
          viewport, which is not what "follows the pointer" means. */}
      {rack.id && rack.ghost && (
        <div
          className="rack-ghost"
          ref={rack.ghostRef}
          style={{ width: rack.ghost.width, height: rack.ghost.height }}
          aria-hidden="true"
        >
          <div className="unit">
            <UnitSpine def={defOf(byId.get(rack.id)?.type ?? '')} moduleId={rack.id} />
            <div className="unit-face rack-ghost-face">
              <span className="rack-ghost-label">
                {defOf(byId.get(rack.id)?.type ?? '').name}
              </span>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
