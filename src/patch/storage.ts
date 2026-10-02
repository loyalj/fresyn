import type { AudioSettings } from '../audio/AudioEngine'
import type { StoredSample } from '../audio/sampleStore'
import {
  fromStoredProject,
  makeProjectBundle,
  readProjectBundle,
  type LoadedProject,
  type StoredProject,
} from '../song/project'
import { isZip, makeBundle, readBundle } from './bundle'
import type { FileKind } from './fileAccess'
import { fromStored, type LoadResult, type StoredPatch } from './serialize'

const PROJECT_KEY = 'fresyn.project.v1'
/**
 * Where the autosave lived when a session was one rack.
 *
 * Read as a fallback and never written, so a session open across the change
 * keeps its work: `fromStoredProject` reads a single-patch file as a project
 * of one track, which is what it always was. Not deleted, because the load
 * runs during render and StrictMode runs it twice.
 */
const KEY = 'fresyn.patch.v1'
/**
 * What the key was called before the app was renamed. Read as a fallback so
 * that a session open across the rename keeps its rack; the next autosave
 * writes the new key. It is never deleted here -- loadLocal is called during
 * render, where StrictMode runs it twice, and a removal on the first pass
 * would leave the second with nothing to find.
 */
const LEGACY_KEY = 'freeson.patch.v1'

/**
 * Autosave to the browser. Every accessor is guarded: storage throws outright
 * in a private window or with site data blocked, and losing the autosave is
 * never a reason to take the app down with it.
 *
 * It is a reason to say so, though. A quota error is the one that matters --
 * a project with a long arrangement outgrows the few megabytes a browser
 * gives a page -- and swallowed, it meant a session that looked saved and was
 * not. So this answers whether it took, and the app tells the user when it
 * did not.
 */
export function saveLocalProject(stored: StoredProject): boolean {
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify(stored))
    return true
  } catch {
    return false
  }
}

/**
 * The autosave exactly as it is stored, unread.
 *
 * For the crash screen: when the app cannot draw, the one thing worth
 * offering is the work, and the work must not have to go through the code
 * that just failed to get out. So this is the raw text rather than a parsed
 * project, and a file made from it opens like any saved project would.
 */
export function readLocalProjectText(): string | null {
  try {
    return (
      localStorage.getItem(PROJECT_KEY) ??
      localStorage.getItem(KEY) ??
      localStorage.getItem(LEGACY_KEY)
    )
  } catch {
    return null
  }
}

/** Whether the page opened on an autosave already in today's format; see below. */
let openedOnAutosave = false

/**
 * The page opened on the autosave, stored under today's key, and so has no
 * need to write it straight back.
 *
 * Every save was running once as the page opened, rewriting the very project
 * it had just read: a whole-project stringify and a synchronous write, tens
 * of milliseconds on a long arrangement, on every load. An autosave under an
 * older key, or none at all, is still written, which is what moves it to the
 * current one.
 */
export function openedOnCurrentAutosave(): boolean {
  return openedOnAutosave
}

export function loadLocalProject(): LoadedProject | null {
  let text: string | null = null
  let current = false
  try {
    text = localStorage.getItem(PROJECT_KEY)
    current = text !== null
    text ??= localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
  } catch {
    return null
  }
  if (!text) return null

  try {
    const result = fromStoredProject(JSON.parse(text))
    if ('error' in result) return null
    openedOnAutosave = current
    return result
  } catch {
    return null
  }
}

export function clearLocal() {
  try {
    localStorage.removeItem(PROJECT_KEY)
    localStorage.removeItem(KEY)
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // ignored, as above
  }
}

const DOCK_KEY = 'fresyn.dock.v1'

export interface DockState {
  open: boolean
  height: number
}

/**
 * Whether the roll is out, and how tall. Guarded like every other accessor
 * here: storage throws outright in a private window, and losing the height of
 * a drawer is never a reason to take the app down with it.
 */
export function saveDock(state: DockState) {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify(state))
  } catch {
    // Nothing to do; it opens at its default next time.
  }
}

export function loadDock(): DockState | null {
  try {
    const text = localStorage.getItem(DOCK_KEY)
    if (!text) return null
    const data = JSON.parse(text) as Record<string, unknown>
    if (typeof data.open !== 'boolean' || typeof data.height !== 'number') return null
    return { open: data.open, height: data.height }
  } catch {
    return null
  }
}

const PREFS_KEY = 'fresyn.prefs.v1'

/**
 * How the app was last left, for the things that are about working rather
 * than about the document: the roll's grid and row height, the chord it lays,
 * which view the dock shows and what the roll plays, how cables are coloured.
 * None of it is undoable and none of it travels with a project -- two people
 * opening the same file each get the roll the way they like it.
 */
export interface Prefs {
  dockView?: 'roll' | 'song' | 'mix'
  rollPlays?: 'pattern' | 'song'
  grid?: number
  rowZoom?: number
  /** The playlist's snap, by name, and its width of a bar in pixels. */
  playlistSnap?: 'bar' | 'beat' | 'half' | 'quarter' | 'off'
  playlistZoom?: number
  /** Whether hidden tracks are listed after all. */
  showHiddenTracks?: boolean
  chord?: { id: string; inversion: number }
  /** How the roll's Quantize is set up: what it moves, how far, and whether it quantizes a take. */
  quantize?: { what: 'start' | 'end' | 'both' | 'length'; strength: number; onInput: boolean }
  /** How the last bounce was written: format, rate, depth, lossy quality. */
  bounce?: { format: 'wav' | 'flac' | 'ogg' | 'mp3'; sampleRate: number; bitDepth: number; quality: number }
  /** Whether MIDI controllers are listened to. Off until asked for: the browser asks the person first. */
  midi?: boolean
  cableColors?: 'signal' | 'module'
  compact?: boolean
  knobHelp?: boolean
  /** Whether notes stuck to the rack are showing. */
  showNotes?: boolean
  /** Whether the roll draws a swung pattern as it sounds, or on its written grid. */
  showSwing?: boolean
  /** How the audio device is opened: this machine's, never the project's. */
  audio?: AudioSettings
  /** The utilities left open, reopened with the page. */
  utilitiesOpen?: string[]
  /** Where each utility's panel was left, by utility. */
  utilityPlaces?: Record<string, { x: number; y: number }>
  /** The Timing utility's numbers, as they were left. */
  timing?: TimingPrefs
  /** The Metronome's settings. */
  metronome?: MetronomePrefs
  /** The Notes & frequencies utility's input, reference and transposition. */
  pitch?: PitchPrefs
  /** The key, chords and progression the Scales & chords and Progressions utilities share. */
  harmony?: HarmonyPrefs
  /** The Rhythm utility's lanes and settings. */
  rhythm?: RhythmPrefs
}

/**
 * What the Scales & chords and the Progressions utilities share: one key,
 * so a chord picked in one is the chord the other writes.
 */
export interface HarmonyPrefs {
  /** 0..11, from C. */
  root: number
  /** An id from `SCALES`. */
  mode: string
  sevenths: boolean
  /** The octave the first chord's root is in: 3 is C3 to B3. */
  octave: number
  /** The progression being sketched, as degrees of the key. */
  degrees: number[]
  voicing: 'close' | 'smooth' | 'spread' | 'bass'
  rhythm: 'held' | 'beats' | 'eighths' | 'offbeats' | 'charleston' | 'arpUp' | 'arpUpDown'
  /** How long each chord lasts, in bars. */
  bars: number
  /** Whether writing takes the track's notes in the pattern away first. */
  replace: boolean
  /** Whether the progression goes round again to fill the pattern. */
  fill: boolean
}

export interface RhythmPrefs {
  /** The track written to, when it is still a drum track. */
  track?: string
  lanes: {
    /** The MIDI note of the pad, which picks the pad again in any kit laid out the General MIDI way. */
    note: number
    steps: number
    hits: number
    rotate: number
    accents: number
    probability: number
    fit?: boolean
    mute?: boolean
  }[]
  /** Grid steps to a quarter note: 4 is sixteenths, 6 sixteenth triplets. */
  perBeat: number
  seed: number
  /** Whether writing takes the lanes' rows in the pattern away first. */
  replace: boolean
}

export interface MetronomePrefs {
  bpm: number
  beats: number
  unit: number
  /** Clicks per beat. */
  subdivision: number
  accent: boolean
  sound: 'click' | 'wood' | 'beep'
  /** 0..1. */
  volume: number
}

export interface PitchPrefs {
  /** What was typed: a note, a MIDI number or a frequency. */
  input: string
  /** The reference A, in hertz. */
  a4: number
  /** Semitones to transpose by. */
  transpose: number
}

/**
 * The Timing utility's own tempo and time signature -- it starts at the
 * song's and is free to try others -- the length and sections being planned,
 * and how note lengths are shown.
 */
export interface TimingPrefs {
  tab: 'length' | 'notes' | 'tap'
  length: string
  bpm: number
  /** The time signature: beats in a bar, and the note a beat is. */
  beats: number
  unit: number
  sections: { name: string; bars: number }[]
  /** How note lengths are shown: milliseconds, hertz, or samples. */
  show: 'ms' | 'hz' | 'samples'
}

let prefsCache: Prefs | null = null

export function loadPrefs(): Prefs {
  if (prefsCache) return prefsCache
  try {
    const text = localStorage.getItem(PREFS_KEY)
    const data = text ? (JSON.parse(text) as unknown) : null
    prefsCache = typeof data === 'object' && data !== null ? (data as Prefs) : {}
  } catch {
    prefsCache = {}
  }
  return prefsCache
}

/** Merge a change into what is remembered. Never throws, like every accessor here. */
export function savePrefs(change: Partial<Prefs>) {
  prefsCache = { ...loadPrefs(), ...change }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefsCache))
  } catch {
    // Remembered for this session only.
  }
}

/** Hand a file to the browser as a download. */
export function downloadBytes(data: BlobPart, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick so the click has taken the URL first.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadPatch(stored: StoredPatch) {
  downloadBytes(
    JSON.stringify(stored, null, 2),
    `${slug(stored.name)}.fpatch.json`,
    'application/json',
  )
}

/**
 * Open a file the user chose: a patch, or a bundle with its audio.
 *
 * Told apart by what is in the file rather than by its extension, because an
 * extension is a suggestion -- a bundle renamed on the way through a chat app
 * should still open.
 *
 * The samples come back beside the patch rather than being stored here: the
 * caller has to put them where the rack will look before it opens the patch,
 * or every Sampler in it flashes through its missing state on the way in.
 */
export async function readPatchFile(
  file: File,
): Promise<(LoadResult & { samples?: StoredSample[] }) | { error: string }> {
  const bytes = await file.arrayBuffer()

  if (isZip(bytes)) {
    try {
      const bundle = await readBundle(bytes)
      if (bundle.project) return { error: projectNotPatch(file.name) }
      const loaded = fromStored(bundle.stored)
      if ('error' in loaded) return loaded
      // What the archive found wrong with its audio comes first: a sample
      // stored under the wrong name is about the file, not the patch in it.
      return {
        ...loaded,
        warnings: [...bundle.warnings, ...loaded.warnings],
        samples: bundle.samples,
      }
    } catch (e) {
      return { error: `${file.name} could not be unpacked: ${(e as Error).message}` }
    }
  }

  let data: unknown
  try {
    data = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return { error: `${file.name} is not valid JSON` }
  }
  if (typeof data === 'object' && data !== null && 'racks' in data) {
    return { error: projectNotPatch(file.name) }
  }
  return fromStored(data)
}

/**
 * Said plainly, because the two files are easy to mix up and "no patch in
 * file" would leave you wondering what is wrong with it.
 */
function projectNotPatch(name: string) {
  return `${name} is a whole project, not a patch -- open it with Project > Open project`
}

/**
 * Write the patch out, with its audio when it has any.
 *
 * A rack with no samples in it stays a small readable JSON file, which is
 * what makes a patch something you can paste into a message. Only a rack that
 * would arrive silent becomes a zip.
 */
export function downloadRack(stored: StoredPatch, samples: readonly StoredSample[]) {
  if (samples.length === 0) {
    downloadPatch(stored)
    return
  }
  downloadBytes(
    makeBundle(stored, samples) as BlobPart,
    `${slug(stored.name)}.fpatch.zip`,
    'application/zip',
  )
}

/** What a project is written as: the bytes, and the name and type they go by. */
export interface ProjectFile {
  data: BlobPart
  filename: string
  mime: string
  /** JSON when the project has no audio in it, a zip when it has. */
  kind: 'json' | 'zip'
}

/**
 * The project as a file, with its audio when it has any.
 *
 * The same rule a patch follows one level down: a project with no samples in
 * it stays a readable JSON file, and only one that would arrive silent
 * becomes a zip.
 */
export function projectFile(stored: StoredProject, samples: readonly StoredSample[]): ProjectFile {
  if (samples.length === 0) {
    return {
      data: JSON.stringify(stored, null, 2),
      filename: `${slug(stored.name)}.fproject.json`,
      mime: 'application/json',
      kind: 'json',
    }
  }
  return {
    data: makeProjectBundle(stored, samples) as BlobPart,
    filename: `${slug(stored.name)}.fproject.zip`,
    mime: 'application/zip',
    kind: 'zip',
  }
}

/** For the pickers: what a project file looks like, in each of its forms. */
export const PROJECT_FILE_KINDS: Record<ProjectFile['kind'], FileKind> = {
  json: { description: 'Fresyn project', accept: { 'application/json': ['.json'] } },
  zip: { description: 'Fresyn project with audio', accept: { 'application/zip': ['.zip'] } },
}

/** The form a file on disk is in, going by its name. */
export function projectKindOf(filename: string): ProjectFile['kind'] {
  return filename.toLowerCase().endsWith('.zip') ? 'zip' : 'json'
}

/** Write the project out as a browser download. */
export function downloadProject(stored: StoredProject, samples: readonly StoredSample[]) {
  const file = projectFile(stored, samples)
  downloadBytes(file.data, file.filename, file.mime)
}

/**
 * Open a project the user chose: plain, zipped, or a single patch from before
 * there were projects.
 *
 * Told apart by what is in the file rather than by its extension, for the
 * same reason a patch is: an extension is a suggestion, and a file renamed on
 * the way through a chat app should still open.
 */
export async function readProjectFile(
  file: File,
): Promise<(LoadedProject & { samples?: StoredSample[] }) | { error: string }> {
  const bytes = await file.arrayBuffer()

  if (isZip(bytes)) {
    try {
      const bundle = await readProjectBundle(bytes)
      const loaded = fromStoredProject(bundle.stored)
      if ('error' in loaded) return loaded
      return {
        ...loaded,
        warnings: [...bundle.warnings, ...loaded.warnings],
        samples: bundle.samples,
      }
    } catch (e) {
      return { error: `${file.name} could not be unpacked: ${(e as Error).message}` }
    }
  }

  try {
    return fromStoredProject(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return { error: `${file.name} is not valid JSON` }
  }
}

export function slug(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'patch'
}
