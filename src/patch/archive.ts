import { idFor, type StoredSample } from '../audio/sampleStore'
import { makeZip, readZip, type ZipEntry } from '../audio/zip'

/**
 * The zip a patch or a project travels in when it has audio in it.
 *
 * One layout for both, one level apart:
 *
 *   patch.json   or   project.json
 *   samples/<hash>/kick.wav
 *
 * `bundle.ts` and `project.ts` each used to carry their own copy of this, and
 * the two had already begun to drift; the document inside is theirs, and the
 * archive around it is here.
 */

const SAMPLE_DIR = 'samples'

/** A document and its audio, as bytes ready to be written out. */
export function makeArchive(
  docName: string,
  doc: unknown,
  samples: readonly StoredSample[],
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const entries: ZipEntry[] = [
    { name: docName, data: encoder.encode(JSON.stringify(doc, null, 2)) as Uint8Array<ArrayBuffer> },
    ...samples.map((s) => ({
      name: `${SAMPLE_DIR}/${s.id}/${safeName(s.name)}`,
      data: new Uint8Array(s.bytes),
    })),
  ]
  return makeZip(entries)
}

export interface Archive {
  /** Every entry, for a caller looking for its own document. */
  entries: ZipEntry[]
  /** The audio, each under the id its bytes actually hash to. */
  samples: StoredSample[]
  /**
   * Ids the archive filed a sample under that are not the hash of its bytes,
   * old to new. Empty for any archive this app wrote.
   */
  renamed: Map<string, string>
  warnings: string[]
}

/**
 * Unpack an archive, re-hashing every sample on the way.
 *
 * The directory a sample sits in names its id, and the id is supposed to be
 * the hash of the bytes -- that is what lets two patches share one copy. But
 * a directory name is only a claim: an archive repacked by hand, or built by
 * something else, can file one sample's bytes under another's id, and trusting
 * it would store the audio under a name that belongs to different audio,
 * where every patch naming that id would then quietly play the wrong file.
 * So the id is worked out again from the bytes, and where it disagrees the
 * sample goes in under its real id and the document is re-pointed at it.
 */
export async function readArchive(bytes: ArrayBuffer): Promise<Archive> {
  const entries = await readZip(new Uint8Array(bytes))
  const samples: StoredSample[] = []
  const renamed = new Map<string, string>()
  const warnings: string[] = []
  const have = new Set<string>()

  for (const entry of entries) {
    const parts = entry.name.split('/')
    if (parts.length !== 3 || parts[0] !== SAMPLE_DIR || !parts[1]) continue
    // A copy that owns its memory, since a zip entry is a view into the archive.
    const data = entry.data.slice().buffer as ArrayBuffer
    const claimed = parts[1]
    const id = idFor(data)
    if (id !== claimed) {
      renamed.set(claimed, id)
      warnings.push(`sample "${parts[2]}" was filed as ${claimed} but its contents are ${id}; re-pointed`)
    }
    if (have.has(id)) continue
    have.add(id)
    samples.push({
      id,
      name: parts[2],
      // Guessed from the name rather than carried: the type is only ever used
      // to write the file back out, and the browser decodes by content.
      type: typeFor(parts[2]),
      bytes: data,
    })
  }

  return { entries, samples, renamed, warnings }
}

/** Parse the JSON document an archive holds under `name`, or undefined for none. */
export function archiveDoc(archive: Archive, name: string): unknown {
  const entry = archive.entries.find((e) => e.name === name)
  return entry ? JSON.parse(new TextDecoder().decode(entry.data)) : undefined
}

/**
 * Point every sample reference in a stored patch or project at its re-hashed
 * id. Works on the file as read, before the patch reader has seen it, so the
 * reader gets a document that already names the right audio: a patch's
 * modules, a project's racks, and the single rack of a project from before
 * there were tracks.
 */
export function repointSamples(stored: unknown, renamed: ReadonlyMap<string, string>): unknown {
  if (renamed.size === 0 || typeof stored !== 'object' || stored === null) return stored
  const data = stored as Record<string, unknown>
  const fixPatch = (file: unknown) => {
    if (typeof file !== 'object' || file === null) return
    const patch = (file as Record<string, unknown>).patch
    if (typeof patch !== 'object' || patch === null) return
    const modules = (patch as Record<string, unknown>).modules
    if (!Array.isArray(modules)) return
    for (const m of modules) {
      if (typeof m !== 'object' || m === null) continue
      // A Drum Kit's pads are racks of their own, and may name samples too.
      const slots = (m as Record<string, unknown>).slots
      if (Array.isArray(slots)) for (const slot of slots) fixPatch(slot)
      const sample = (m as Record<string, unknown>).sample
      if (typeof sample !== 'object' || sample === null) continue
      const s = sample as Record<string, unknown>
      if (typeof s.id === 'string' && renamed.has(s.id)) s.id = renamed.get(s.id)
    }
  }
  fixPatch(data)
  if (typeof data.racks === 'object' && data.racks !== null) {
    for (const rack of Object.values(data.racks as Record<string, unknown>)) fixPatch(rack)
  }
  return stored
}

/** No separators and nothing exotic: this becomes a path inside the archive. */
export function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '_').trim()
  return cleaned || 'audio'
}

/** A MIME type from a filename, for audio that arrived without one. */
export function typeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg'
  if (ext === 'flac') return 'audio/flac'
  if (ext === 'm4a' || ext === 'aac') return 'audio/mp4'
  return 'audio/wav'
}
