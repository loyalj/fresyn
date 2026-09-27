import { initialValues } from './edit'
import { fromStored, toStored, type StoredPatch } from './serialize'
import type { Patch } from './types'

/**
 * The library's own shelves: racks you saved into it, the ones you starred,
 * and the ones you last opened.
 *
 * Kept in this browser, like the autosave, and nowhere else: the library is
 * where you start from, and a saved patch file is still how a rack travels.
 * Every accessor is guarded the way the rest of storage is -- storage throws
 * outright in a private window, and losing a shelf is never a reason to take
 * the app down.
 */

const MINE_KEY = 'fresyn.library.mine.v1'
const FAVOURITES_KEY = 'fresyn.library.favourites.v1'
const RECENT_KEY = 'fresyn.library.recent.v1'
/** How many recently opened racks the Recent shelf keeps. */
const RECENT_MAX = 8

export interface MyPatch {
  /** Stable: what favourites and recents refer to it by. */
  id: string
  name: string
  /** When it was last saved, as milliseconds since 1970. */
  savedAt: number
  stored: StoredPatch
}

function read<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key)
    return text ? (JSON.parse(text) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function loadMyPatches(): MyPatch[] {
  const list = read<unknown>(MINE_KEY, [])
  if (!Array.isArray(list)) return []
  return list.filter(
    (p): p is MyPatch =>
      typeof p === 'object' && p !== null && typeof p.id === 'string' && typeof p.name === 'string' && !!p.stored,
  )
}

/**
 * Put the rack on the shelf under a name. One of that name already there is
 * replaced -- saving again is updating it, which is what saving usually
 * means -- and keeps its id, so a star on it stays put.
 *
 * Returns whether it was an update, or null when storage refused it (full, or
 * a private window).
 */
export function saveMyPatch(
  name: string,
  patch: Patch,
  values: Record<string, number>,
): { updated: boolean } | null {
  const list = loadMyPatches()
  const stored = toStored(name, patch, values)
  const at = list.findIndex((p) => p.name.toLowerCase() === name.toLowerCase())
  const entry: MyPatch = {
    id: at >= 0 ? list[at].id : `mine-${Date.now().toString(36)}`,
    name,
    savedAt: Date.now(),
    stored,
  }
  const next = at >= 0 ? list.map((p, i) => (i === at ? entry : p)) : [entry, ...list]
  return write(MINE_KEY, next) ? { updated: at >= 0 } : null
}

export function deleteMyPatch(id: string) {
  write(MINE_KEY, loadMyPatches().filter((p) => p.id !== id))
  write(FAVOURITES_KEY, loadFavourites().filter((f) => f !== id))
  write(RECENT_KEY, loadRecent().filter((r) => r !== id))
}

/** The rack a saved entry holds, read back through the patch reader. */
export function buildMyPatch(p: MyPatch): { patch: Patch; values: Record<string, number> } {
  const read = fromStored(p.stored)
  if ('error' in read) return { patch: { modules: [], cables: [] }, values: {} }
  return { patch: read.patch, values: initialValues(read.patch) }
}

export function loadFavourites(): string[] {
  const list = read<unknown>(FAVOURITES_KEY, [])
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

/** Star it, or take the star off. Returns the new list. */
export function toggleFavourite(id: string): string[] {
  const list = loadFavourites()
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  write(FAVOURITES_KEY, next)
  return next
}

export function loadRecent(): string[] {
  const list = read<unknown>(RECENT_KEY, [])
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

/** Note that a rack was opened: newest first, each once. */
export function noteRecent(id: string) {
  write(RECENT_KEY, [id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX))
}

const PRESETS_KEY = 'fresyn.presets.v1'

/** One module's knobs, saved under a name, for that kind of module only. */
export interface ModulePreset {
  name: string
  params: Record<string, number>
}

function allPresets(): Record<string, ModulePreset[]> {
  const data = read<unknown>(PRESETS_KEY, {})
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, ModulePreset[]>)
    : {}
}

/** The presets saved for a type of module, in the order they were saved. */
export function loadPresets(type: string): ModulePreset[] {
  const list = allPresets()[type]
  return Array.isArray(list)
    ? list.filter((p) => typeof p?.name === 'string' && typeof p?.params === 'object' && p.params !== null)
    : []
}

/**
 * Save a module's knobs as a preset for its type. A preset of that name is
 * replaced, as saving again usually means. Returns false when storage refused.
 */
export function savePreset(type: string, name: string, params: Record<string, number>): boolean {
  const all = allPresets()
  const list = loadPresets(type).filter((p) => p.name.toLowerCase() !== name.toLowerCase())
  all[type] = [...list, { name, params: { ...params } }]
  return write(PRESETS_KEY, all)
}

export function deletePreset(type: string, name: string) {
  const all = allPresets()
  all[type] = loadPresets(type).filter((p) => p.name !== name)
  write(PRESETS_KEY, all)
}
