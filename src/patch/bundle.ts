import { makeZip, readZip } from '../audio/zip'
import type { StoredSample } from '../audio/sampleStore'
import type { StoredPatch } from './serialize'

/**
 * A patch and the audio it plays, in one file.
 *
 * A patch on its own is a few kilobytes of JSON and travels anywhere; the
 * moment a Sampler is in it, that file names audio the other machine has
 * never had. So a rack with samples in it exports as a zip holding the patch
 * and the files exactly as they arrived -- not re-encoded, not resampled,
 * under their own names -- and importing one puts them back before the patch
 * is opened.
 *
 * Laid out so that somebody who unzips it can see what they have got:
 *
 *   patch.json
 *   samples/<hash>/kick.wav
 *
 * The hash is the directory rather than the filename so the file keeps the
 * name it had, and the id survives a reader that knows nothing about either.
 */
const PATCH_ENTRY = 'patch.json'
const SAMPLE_DIR = 'samples'

export interface Bundle {
  stored: unknown
  samples: StoredSample[]
  /** The zip was a saved project, which has no patch.json of its own. */
  project?: true
}

/** Zip archives begin with this, which is how an import tells the two apart. */
export function isZip(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false
  const head = new Uint8Array(bytes, 0, 4)
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
}

export function makeBundle(stored: StoredPatch, samples: readonly StoredSample[]): Uint8Array {
  const encoder = new TextEncoder()
  const entries = [
    { name: PATCH_ENTRY, data: encoder.encode(JSON.stringify(stored, null, 2)) },
    ...samples.map((s) => ({
      name: `${SAMPLE_DIR}/${s.id}/${safeName(s.name)}`,
      data: new Uint8Array(s.bytes),
    })),
  ]
  return makeZip(entries as { name: string; data: Uint8Array<ArrayBuffer> }[])
}

export async function readBundle(bytes: ArrayBuffer): Promise<Bundle> {
  const entries = await readZip(new Uint8Array(bytes))
  const patch = entries.find((e) => e.name === PATCH_ENTRY)
  if (!patch) {
    if (entries.some((e) => e.name === 'project.json')) {
      return { stored: null, samples: [], project: true }
    }
    throw new Error('that zip has no patch in it')
  }

  const samples: StoredSample[] = []
  for (const entry of entries) {
    const parts = entry.name.split('/')
    if (parts.length !== 3 || parts[0] !== SAMPLE_DIR || !parts[1]) continue
    samples.push({
      id: parts[1],
      name: parts[2],
      // Guessed from the name rather than carried: the type is only ever used
      // to write the file back out, and the browser decodes by content.
      type: typeFor(parts[2]),
      bytes: toBuffer(entry.data),
    })
  }

  return { stored: JSON.parse(new TextDecoder().decode(patch.data)), samples }
}

/** A copy that owns its memory, since a zip entry is a view into the archive. */
function toBuffer(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer as ArrayBuffer
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
