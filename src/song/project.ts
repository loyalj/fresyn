import { makeZip, readZip } from '../audio/zip'
import type { StoredSample } from '../audio/sampleStore'
import { initialValues } from '../patch/edit'
import { fromStored, toStored, type StoredPatch } from '../patch/serialize'
import type { Patch } from '../patch/types'
import { parseSong } from './serialize'
import { BENCH_TRACK, benchSong, type Song } from './types'

/**
 * A project: the arrangement, and one rack per track.
 *
 * The unit of work once there is more than one rack. A patch is still a patch
 * -- one rack, a small readable file, the thing you send somebody when you
 * mean "here is a sound" -- and this is the thing you send when you mean
 * "here is the piece". It is also what a game loads: everything needed to
 * play the music is inside it, and nothing in it needs a browser.
 */

export const PROJECT_FORMAT = 1

/** One rack, as it is held while being edited. */
export interface Rack {
  patch: Patch
  /** Knob positions, keyed `moduleId.paramId`. */
  values: Record<string, number>
}

export interface StoredProject {
  version: number
  name: string
  song: Song
  /**
   * A rack per track id, each in exactly the shape a patch file has -- so a
   * track can be lifted out of a project and opened as a patch, and the
   * reader below is the patch reader with a loop around it.
   */
  racks: Record<string, StoredPatch>
}

export interface LoadedProject {
  name: string
  song: Song
  racks: Record<string, Rack>
  warnings: string[]
}

export function toStoredProject(
  name: string,
  song: Song,
  racks: Readonly<Record<string, Rack>>,
): StoredProject {
  const out: Record<string, StoredPatch> = {}
  for (const track of song.tracks) {
    const rack = racks[track.id]
    if (!rack) continue
    out[track.id] = toStored(track.name, rack.patch, rack.values)
  }
  return { version: PROJECT_FORMAT, name, song, racks: out }
}

/**
 * Read a project, or anything that used to be one.
 *
 * Defensive throughout, like the patch reader: a track whose rack is missing
 * or unreadable comes back with an empty one and a warning rather than taking
 * the whole project down. Losing one rack is survivable; losing the
 * arrangement because one module was renamed is not.
 */
export function fromStoredProject(input: unknown): LoadedProject | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'not a project file' }
  const data = input as Record<string, unknown>

  // A file from before there were tracks: one patch, and at most the pattern
  // that was written on it. Read as a project of a single track, so nothing
  // saved by an earlier build is stranded.
  if (!data.racks && data.patch) return fromSingleRack(data)

  if (typeof data.version !== 'number') return { error: 'missing format version' }
  if (data.version > PROJECT_FORMAT) {
    return { error: `project format ${data.version} is newer than this build understands` }
  }

  const song = parseSong(data.song)
  if (!song) return { error: 'no arrangement in file' }

  const warnings: string[] = []
  const racks: Record<string, Rack> = {}
  const stored = (typeof data.racks === 'object' && data.racks !== null ? data.racks : {}) as Record<
    string,
    unknown
  >

  for (const track of song.tracks) {
    const raw = stored[track.id]
    if (raw === undefined) {
      warnings.push(`track "${track.name}" has no rack in this file`)
      continue
    }
    const loaded = fromStored(raw)
    if ('error' in loaded) {
      warnings.push(`track "${track.name}": ${loaded.error}`)
      continue
    }
    warnings.push(...loaded.warnings.map((w) => `${track.name}: ${w}`))
    racks[track.id] = { patch: loaded.patch, values: initialValues(loaded.patch) }
  }

  return {
    name: typeof data.name === 'string' && data.name ? data.name : 'Untitled',
    song,
    racks,
    warnings,
  }
}

/** A single-patch file, read as a project of one track. */
function fromSingleRack(data: Record<string, unknown>): LoadedProject | { error: string } {
  const loaded = fromStored(data)
  if ('error' in loaded) return loaded

  // The pattern such a file carried was written for that one rack, so it
  // becomes the bench track's pattern and the track keeps the id it had.
  const song = loaded.song ?? benchSong()
  return {
    name: loaded.name,
    song,
    racks: { [song.tracks[0]?.id ?? BENCH_TRACK]: {
      patch: loaded.patch,
      values: initialValues(loaded.patch),
    } },
    warnings: loaded.warnings,
  }
}

// --- the file -----------------------------------------------------------

const PROJECT_ENTRY = 'project.json'
const SAMPLE_DIR = 'samples'

/**
 * A project and the audio it plays, in one file.
 *
 * The same arrangement `bundle.ts` makes for a single rack, one level up:
 *
 *   project.json
 *   samples/<hash>/kick.wav
 *
 * A project with no samples in it stays plain JSON, for the same reason a
 * patch does -- it is a file you can read, diff and paste into a message.
 */
export function makeProjectBundle(
  stored: StoredProject,
  samples: readonly StoredSample[],
): Uint8Array {
  const encoder = new TextEncoder()
  const entries = [
    { name: PROJECT_ENTRY, data: encoder.encode(JSON.stringify(stored, null, 2)) },
    ...samples.map((s) => ({
      name: `${SAMPLE_DIR}/${s.id}/${safeName(s.name)}`,
      data: new Uint8Array(s.bytes),
    })),
  ]
  return makeZip(entries as { name: string; data: Uint8Array<ArrayBuffer> }[])
}

export async function readProjectBundle(
  bytes: ArrayBuffer,
): Promise<{ stored: unknown; samples: StoredSample[] }> {
  const entries = await readZip(new Uint8Array(bytes))
  // A project zip, or a patch bundle from before there were projects: both
  // are read here, and the reader above tells them apart by their contents.
  const doc = entries.find((e) => e.name === PROJECT_ENTRY || e.name === 'patch.json')
  if (!doc) throw new Error('that zip has no project in it')

  const samples: StoredSample[] = []
  for (const entry of entries) {
    const parts = entry.name.split('/')
    if (parts.length !== 3 || parts[0] !== SAMPLE_DIR || !parts[1]) continue
    samples.push({
      id: parts[1],
      name: parts[2],
      type: typeFor(parts[2]),
      bytes: entry.data.slice().buffer as ArrayBuffer,
    })
  }

  return { stored: JSON.parse(new TextDecoder().decode(doc.data)), samples }
}

/** No separators and nothing exotic: this becomes a path inside the archive. */
function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '_').trim()
  return cleaned || 'audio'
}

function typeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg'
  if (ext === 'flac') return 'audio/flac'
  if (ext === 'm4a' || ext === 'aac') return 'audio/mp4'
  return 'audio/wav'
}
