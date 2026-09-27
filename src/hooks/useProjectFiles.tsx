import { useCallback, useRef } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import type { SampleLibrary } from '../audio/SampleLibrary'
import { getSample, type StoredSample } from '../audio/sampleStore'
import { initialValues } from '../patch/edit'
import { canUseFileHandles, pickFileToOpen, pickFileToSave, writeFile } from '../patch/fileAccess'
import { toStored } from '../patch/serialize'
import {
  downloadProject,
  downloadRack,
  PROJECT_FILE_KINDS,
  projectFile,
  projectKindOf,
  readPatchFile,
  readProjectFile,
} from '../patch/storage'
import type { Patch } from '../patch/types'
import { addTrack, nextTrackId } from '../song/edit'
import { toStoredProject, type Rack } from '../song/project'
import { BENCH_TRACK, type Song } from '../song/types'
import { fillRacks, type Doc } from './useDocument'

/** `3 tracks`, `1 sample`: for notices that say what went into a file. */
function countOf(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** What a file chosen from one of the hidden inputs is for. */
type FileMode = 'patch' | 'track' | 'project'

/**
 * The hidden file inputs, one per thing a chosen file can be for.
 *
 * Separate inputs rather than one that changes its mind: they accept the
 * same extensions, and a single control that sometimes replaced one rack and
 * sometimes the whole project would be the kind of thing you only find out
 * about afterwards. They are drawn from this one list, though, so the three
 * cannot drift apart.
 */
const FILE_INPUTS: readonly { mode: FileMode; className: string }[] = [
  { mode: 'patch', className: 'patch-file' },
  { mode: 'track', className: 'track-file' },
  { mode: 'project', className: 'project-file' },
]

/** A bundle is a zip, and a rack with a Sampler in it exports as one. */
const ACCEPT = 'application/json,.json,application/zip,.zip'

interface Options {
  name: string
  song: Song
  racks: Record<string, Rack>
  patch: Patch
  values: Readonly<Record<string, number>>
  patchName: string
  engine: AudioEngine
  samples: SampleLibrary
  commitDoc: (next: (doc: Doc) => Doc) => void
  breakCoalesce: () => void
  applyPatch: (next: Patch, trackName: string, preset?: Record<string, number>) => void
  setSelected: (id: string) => void
  setPatternId: (id: string) => void
  setNotice: (text: string) => void
}

/**
 * Everything that goes to or comes from a file: projects saved and opened,
 * patches saved, and patches brought in onto a track or as a new one.
 */
export function useProjectFiles({
  name,
  song,
  racks,
  patch,
  values,
  patchName,
  engine,
  samples,
  commitDoc,
  breakCoalesce,
  applyPatch,
  setSelected,
  setPatternId,
  setNotice,
}: Options) {
  /** The file on disk this project was opened from or last saved to, where the browser allows one. */
  const projectHandle = useRef<FileSystemFileHandle | null>(null)
  const inputs = useRef(new Map<FileMode, HTMLInputElement>())

  /** A new project has not been saved anywhere, so its first Save asks where. */
  const forgetHandle = useCallback(() => {
    projectHandle.current = null
  }, [])

  /**
   * The audio a set of racks names, fetched from storage as it was dropped in
   * rather than re-encoded from what is loaded, so what lands in the zip is
   * the file that was dropped in.
   */
  const gatherSamples = useCallback(async (patches: readonly Patch[]) => {
    const ids = [
      ...new Set(patches.flatMap((p) => p.modules.map((m) => m.sample?.id)).filter(Boolean)),
    ] as string[]
    const found: StoredSample[] = []
    for (const id of ids) {
      const s = await getSample(id)
      if (s) found.push(s)
    }
    return { found, missing: ids.length - found.length }
  }, [])

  /** Export the rack: a patch on its own, or a bundle when a Sampler is in it. */
  const exportPatch = useCallback(async () => {
    const { found, missing } = await gatherSamples([patch])
    downloadRack(toStored(patchName, patch, values), found)
    // Said every time rather than only when something is wrong, because what
    // is in the file -- and what is not -- is the whole difference between
    // this and saving the project.
    setNotice(
      missing > 0
        ? `Saved patch ${patchName} without ${missing} missing sample(s)`
        : `Saved patch ${patchName}: this track's sound${found.length ? ` and ${countOf(found.length, 'sample')}` : ''}, no notes`,
    )
  }, [patchName, patch, values, gatherSamples, setNotice])

  /**
   * The whole piece: the arrangement, every rack, and all of the audio.
   *
   * Where the browser can hold on to a file, Save writes back into the one
   * this project came from or was last saved to, and only Save As -- or a
   * project that has never been to disk -- asks where. Elsewhere every save
   * is a download, as it always was.
   */
  const saveProject = useCallback(
    async (saveAs = false) => {
      const patches = song.tracks.flatMap((t) => racks[t.id]?.patch ?? [])
      const { found, missing } = await gatherSamples(patches)
      const stored = toStoredProject(name, song, racks)
      const summary =
        missing > 0
          ? `without ${missing} missing sample(s)`
          : `${countOf(song.tracks.length, 'track')}, ${countOf(song.patterns.length, 'pattern')}${found.length ? `, ${countOf(found.length, 'sample')}` : ''}`

      if (!canUseFileHandles) {
        downloadProject(stored, found)
        setNotice(`Saved project ${name}: ${summary}`)
        return
      }

      const file = projectFile(stored, found)
      let handle = saveAs ? null : projectHandle.current
      // A project that has gained or lost its audio since it was last saved
      // changes form, and zip bytes in a file called .json would be a file
      // lying about what it is. So it asks where the new one goes, offering
      // the right name.
      const changedForm = handle !== null && projectKindOf(handle.name) !== file.kind
      if (changedForm) handle = null
      if (!handle) {
        try {
          handle = await pickFileToSave(file.filename, [PROJECT_FILE_KINDS[file.kind]])
        } catch (e) {
          setNotice(`Could not save: ${(e as Error).message}`)
          return
        }
        if (!handle) return
      }

      try {
        await writeFile(handle, file.data)
      } catch (e) {
        setNotice(`Could not save ${handle.name}: ${(e as Error).message}`)
        return
      }
      projectHandle.current = handle
      setNotice(
        `Saved ${handle.name}: ${summary}${changedForm ? ` -- now a ${file.kind === 'zip' ? 'zip, to carry its audio' : 'plain JSON file'}` : ''}`,
      )
    },
    [name, song, racks, gatherSamples, setNotice],
  )

  const openProject = useCallback(
    async (file: File) => {
      const result = await readProjectFile(file)
      if ('error' in result) {
        setNotice(result.error)
        return false
      }
      // Whatever file the last project was saved to is not this one's. The
      // picker that opened this file hands its own back once this returns.
      projectHandle.current = null
      // Audio first, racks second. The other order puts every Sampler through
      // its missing state on the way to a file in the same zip.
      for (const s of result.samples ?? []) await samples.addStored(s)
      if (result.samples?.length) engine.setSamples(samples.records())

      breakCoalesce()
      const loaded = fillRacks(result.song, result.racks)
      commitDoc(() => ({ name: result.name, song: result.song, racks: loaded }))
      setSelected(result.song.tracks[0]?.id ?? BENCH_TRACK)
      setPatternId(result.song.patterns[0]?.id ?? 'main')
      setNotice(
        result.warnings.length
          ? `Opened with ${result.warnings.length} warning(s): ${result.warnings[0]}`
          : `Opened ${result.name}`,
      )
      for (const w of result.warnings) console.warn('[fresyn project]', w)
      return true
    },
    [commitDoc, breakCoalesce, engine, samples, setSelected, setPatternId, setNotice],
  )

  /**
   * Choose a project to open. Through the file picker that can hold on to
   * the file when there is one, so a later Save goes back into it; through
   * the plain file input otherwise.
   */
  const pickProject = useCallback(async () => {
    if (!canUseFileHandles) {
      inputs.current.get('project')?.click()
      return
    }
    let picked
    try {
      picked = await pickFileToOpen([
        {
          description: 'Fresyn project',
          accept: { 'application/json': ['.json'], 'application/zip': ['.zip'] },
        },
      ])
    } catch (e) {
      setNotice(`Could not open: ${(e as Error).message}`)
      return
    }
    if (!picked) return
    if (await openProject(picked.file)) projectHandle.current = picked.handle
  }, [openProject, setNotice])

  /**
   * Bring a patch in from a file: onto the selected track in place of the
   * sound it has, or onto a track of its own. Either way the arrangement is
   * left alone -- a patch has no notes in it.
   */
  const importPatch = useCallback(
    async (file: File, asTrack: boolean) => {
      const result = await readPatchFile(file)
      if ('error' in result) {
        setNotice(result.error)
        return
      }
      // Audio first, patch second. The other order puts every Sampler in the
      // rack through its missing state on the way to a file that arrived in
      // the same zip.
      for (const s of result.samples ?? []) await samples.addStored(s)
      if (result.samples?.length) engine.setSamples(samples.records())

      if (asTrack) {
        breakCoalesce()
        const id = nextTrackId(song)
        const values = initialValues(result.patch)
        commitDoc((doc) => ({
          ...doc,
          song: addTrack(doc.song, id, result.name),
          racks: { ...doc.racks, [id]: { patch: result.patch, values } },
        }))
        setSelected(id)
      } else {
        applyPatch(result.patch, result.name)
      }
      setNotice(
        result.warnings.length
          ? `Loaded with ${result.warnings.length} warning(s): ${result.warnings[0]}`
          : asTrack
            ? `Added ${result.name} as a new track -- Ctrl+Z to undo`
            : `Loaded ${result.name} onto this track -- Ctrl+Z to undo`,
      )
      for (const w of result.warnings) console.warn('[fresyn load]', w)
    },
    [applyPatch, commitDoc, breakCoalesce, song, engine, samples, setSelected, setNotice],
  )

  /** Open the chooser for a patch: onto this track, or as a new one. */
  const pickPatch = useCallback((asTrack: boolean) => {
    inputs.current.get(asTrack ? 'track' : 'patch')?.click()
  }, [])

  const fileInputs = FILE_INPUTS.map(({ mode, className }) => (
    <input
      key={mode}
      ref={(el) => {
        if (el) inputs.current.set(mode, el)
        else inputs.current.delete(mode)
      }}
      className={className}
      type="file"
      accept={ACCEPT}
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) {
          if (mode === 'project') void openProject(file)
          else void importPatch(file, mode === 'track')
        }
        e.target.value = ''
      }}
    />
  ))

  return { forgetHandle, exportPatch, saveProject, pickProject, pickPatch, fileInputs }
}
