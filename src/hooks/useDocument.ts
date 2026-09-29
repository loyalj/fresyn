import { useCallback, useRef, useState } from 'react'
import { defaultPatch } from '../patch/defaultPatch'
import { initialValues, reconcileValues } from '../patch/edit'
import { commit, initHistory, jumpTo, redo, undo, type History } from '../patch/history'
import { loadLocalProject } from '../patch/storage'
import type { Patch } from '../patch/types'
import { setPatternNotes } from '../song/edit'
import type { Rack } from '../song/project'
import { BENCH_TRACK, benchSong, type Song } from '../song/types'
import { describeEdit } from './describeEdit'

/** Edits to the same control inside this window fold into one undo step. */
const COALESCE_MS = 600

/** Everything undo and save are concerned with. */
export interface Doc {
  name: string
  /**
   * The arrangement: tracks, patterns and where they are placed.
   *
   * In the document rather than beside it so that drawing a note is an
   * ordinary edit: it undoes, it redoes, and it autosaves through exactly the
   * machinery every other edit already goes through.
   */
  song: Song
  /** One rack per track id. Every track in the song has one. */
  racks: Record<string, Rack>
}

/**
 * A rack for every track, whatever the file said.
 *
 * A project whose rack for some track could not be read still opens, with an
 * empty rack on that track -- losing one sound is survivable, and losing the
 * whole arrangement because one module was renamed is not.
 */
export function fillRacks(song: Song, racks: Record<string, Rack>): Record<string, Rack> {
  const out = { ...racks }
  for (const t of song.tracks) {
    if (out[t.id]) continue
    const patch = defaultPatch()
    out[t.id] = { patch, values: initialValues(patch) }
  }
  return out
}

/** Restore the last session, or start from the stock rack. */
export function loadInitialDoc(): Doc {
  const loaded = loadLocalProject()
  const song = loaded?.song ?? benchSong()
  return {
    name: loaded?.name ?? 'Untitled',
    song,
    racks: fillRacks(song, loaded?.racks ?? {}),
  }
}

/**
 * The document, its history, and where in it you are working: which track is
 * on the bench and which pattern the roll writes into. Every edit in the app
 * goes through the helpers this hands back.
 */
export function useDocument(initialDoc: Doc) {
  const [history, setHistory] = useState<History<Doc>>(() => initHistory(initialDoc))
  const { name, song, racks } = history.present

  /**
   * Which track is on the bench.
   *
   * Outside the history on purpose: looking at a different rack is not an
   * edit, and a Ctrl+Z that moved you to another track before undoing the
   * thing you were looking at would be worse than useless.
   */
  const [selected, setSelected] = useState(() => initialDoc.song.tracks[0]?.id ?? BENCH_TRACK)
  /** Undo can take a track away underneath the selection, so this is checked. */
  const trackId = song.tracks.some((t) => t.id === selected)
    ? selected
    : (song.tracks[0]?.id ?? BENCH_TRACK)
  const { patch, values } = racks[trackId] ?? initialDoc.racks[BENCH_TRACK]
  /** A patch is named on its track: the one name is both. */
  const patchName = song.tracks.find((t) => t.id === trackId)?.name ?? 'Untitled'

  /** Which pattern the roll is writing into. Also a view, also not an edit. */
  const [patternId, setPatternId] = useState(() => initialDoc.song.patterns[0]?.id ?? 'main')
  const activePattern = song.patterns.some((p) => p.id === patternId)
    ? patternId
    : (song.patterns[0]?.id ?? 'main')

  const coalesceKey = useRef<string | null>(null)
  const coalesceAt = useRef(0)

  /**
   * `key` groups rapid edits to the same control into one undo step. Whether
   * to coalesce is decided out here rather than inside the updater, because
   * StrictMode runs updaters twice and the second pass would see its own
   * timestamp and reach a different answer.
   *
   * `label` names the step in the History list; without one it is worked
   * out from what changed (see `describeEdit`).
   */
  const commitDoc = useCallback((next: (doc: Doc) => Doc, key?: string, label?: string) => {
    const now = Date.now()
    // A recorded take folds however long the gaps between its notes: a take
    // is one step of undo, and its key is new for every take.
    const fold =
      key !== undefined &&
      key === coalesceKey.current &&
      (key.startsWith('take:') || now - coalesceAt.current < COALESCE_MS)
    coalesceKey.current = key ?? null
    coalesceAt.current = now
    setHistory((h) => {
      const doc = next(h.present)
      if (doc === h.present) return h
      // A folded step is named from where the gesture began, so a drag
      // that moved five notes is not called after its last pixel.
      const from = fold && h.past.length ? h.past[h.past.length - 1] : h.present
      return commit(h, doc, fold, label ?? describeEdit(from, doc))
    })
  }, [])

  /**
   * The next edit starts a step of its own, whatever it is keyed on: for
   * anything that replaces the rack or the project wholesale, which must
   * never fold into the knob turn before it.
   */
  const breakCoalesce = useCallback(() => {
    coalesceKey.current = null
  }, [])

  /** Change the rack on the bench, whichever track that is. */
  const editRack = useCallback(
    (fn: (rack: Rack) => Rack, key?: string) => {
      commitDoc((doc) => {
        const current = doc.racks[trackId]
        if (!current) return doc
        const next = fn(current)
        if (next === current) return doc
        return { ...doc, racks: { ...doc.racks, [trackId]: next } }
      }, key)
    },
    [commitDoc, trackId],
  )

  const editPatch = useCallback(
    (fn: (p: Patch) => Patch) => {
      editRack((rack) => {
        const next = fn(rack.patch)
        if (next === rack.patch) return rack
        return { patch: next, values: reconcileValues(next, rack.values) }
      })
    },
    [editRack],
  )

  const editSong = useCallback(
    (fn: (s: Song) => Song, key?: string) => {
      commitDoc((doc) => {
        const next = fn(doc.song)
        return next === doc.song ? doc : { ...doc, song: next }
      }, key)
    },
    [commitDoc],
  )

  const setParam = useCallback(
    (moduleId: string, paramId: string, value: number) => {
      const key = `${moduleId}.${paramId}`
      // Keyed by track as well, so dragging the same knob on two racks does
      // not fold into one step of undo.
      editRack(
        (rack) => ({ ...rack, values: { ...rack.values, [key]: value } }),
        `param:${trackId}.${key}`,
      )
    },
    [editRack, trackId],
  )

  /**
   * Several knobs on one module in a single edit, for a control that moves
   * more than one at once -- a Macro handle is a window edge and a value.
   * Keyed by which knobs they are, so a drag folds into one step of undo the
   * way a knob drag does, where setting them one at a time would alternate
   * keys and leave a step for every pixel.
   */
  const setParams = useCallback(
    (moduleId: string, changes: Record<string, number>) => {
      const ids = Object.keys(changes).sort()
      editRack(
        (rack) => {
          const values = { ...rack.values }
          for (const id of ids) values[`${moduleId}.${id}`] = changes[id]
          return { ...rack, values }
        },
        `params:${trackId}.${moduleId}.${ids.join(',')}`,
      )
    },
    [editRack, trackId],
  )

  const setNotes = useCallback(
    (notes: Parameters<typeof setPatternNotes>[2]) =>
      editSong((s) => setPatternNotes(s, activePattern, notes)),
    [editSong, activePattern],
  )

  const stepBack = useCallback(() => {
    coalesceKey.current = null
    setHistory(undo)
  }, [])

  const stepForward = useCallback(() => {
    coalesceKey.current = null
    setHistory(redo)
  }, [])

  /** Straight to a step in the History list, however far back or on. */
  const goToStep = useCallback((index: number) => {
    coalesceKey.current = null
    setHistory((h) => jumpTo(h, index))
  }, [])

  return {
    history,
    name,
    song,
    racks,
    trackId,
    setSelected,
    patch,
    values,
    patchName,
    activePattern,
    setPatternId,
    commitDoc,
    breakCoalesce,
    editRack,
    editPatch,
    editSong,
    setParam,
    setParams,
    setNotes,
    stepBack,
    stepForward,
    goToStep,
  }
}
