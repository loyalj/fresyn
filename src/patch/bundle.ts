import type { StoredSample } from '../audio/sampleStore'
import { archiveDoc, makeArchive, readArchive, repointSamples } from './archive'
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

export interface Bundle {
  stored: unknown
  samples: StoredSample[]
  /** The zip was a saved project, which has no patch.json of its own. */
  project?: true
  /** Anything repaired while unpacking, for the load's own list of warnings. */
  warnings: string[]
}

/** Zip archives begin with this, which is how an import tells the two apart. */
export function isZip(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false
  const head = new Uint8Array(bytes, 0, 4)
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
}

export function makeBundle(stored: StoredPatch, samples: readonly StoredSample[]): Uint8Array {
  return makeArchive(PATCH_ENTRY, stored, samples)
}

/**
 * Unpack a patch bundle. `warnings` says what had to be repaired on the way
 * -- a sample filed under an id its bytes do not hash to -- and belongs with
 * the warnings the patch reader gives for the document itself.
 */
export async function readBundle(bytes: ArrayBuffer): Promise<Bundle> {
  const archive = await readArchive(bytes)
  if (!archive.entries.some((e) => e.name === PATCH_ENTRY)) {
    if (archive.entries.some((e) => e.name === 'project.json')) {
      return { stored: null, samples: [], project: true, warnings: [] }
    }
    throw new Error('that zip has no patch in it')
  }
  const stored = repointSamples(archiveDoc(archive, PATCH_ENTRY), archive.renamed)
  return { stored, samples: archive.samples, warnings: archive.warnings }
}
