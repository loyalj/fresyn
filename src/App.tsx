import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine } from './audio/AudioEngine'
import { Transport } from './audio/Transport'
import { renderVariation } from './audio/render'
import { normalize } from './audio/normalize'
import { renderSong, renderStems, type StemMix } from './audio/renderSong'
import { SampleLibrary } from './audio/SampleLibrary'
import { askToPersist } from './audio/sampleStore'
import { encodeWav } from './audio/wav'
import { peakEnvelope } from './audio/waveform'
import { makeZip, type ZipEntry } from './audio/zip'
import { MODE_LATCH } from './dsp/modules/Gate'
import { useInput } from './input/useInput'
import { canUseFileHandles, pickFileToOpen, pickFileToSave, writeFile } from './patch/fileAccess'
import { defOf, MODULE_GROUPS, modulesByGroup } from './patch/defs'
import { defaultPatch } from './patch/defaultPatch'
import { type Template } from './patch/library'
import {
  addModule,
  addModuleAfter,
  addModuleBefore,
  cableInto,
  connect,
  copyModules,
  disconnect,
  disconnectAt,
  initialValues,
  moveModule,
  nextModuleId,
  pasteModules,
  reconcileValues,
  removeModule,
  reorderModules,
  setCableColor,
  setModuleKey,
  setSample,
  toggleBypass,
  type ModuleClip,
  type PortRef,
} from './patch/edit'
import { canRedo, canUndo, commit, initHistory, redo, undo, type History } from './patch/history'
import { toStored } from './patch/serialize'
import { getSample, type StoredSample } from './audio/sampleStore'
import {
  downloadBytes,
  downloadProject,
  PROJECT_FILE_KINDS,
  projectFile,
  projectKindOf,
  downloadRack,
  loadDock,
  loadLocalProject,
  readPatchFile,
  readProjectFile,
  saveDock,
  saveLocalProject,
  slug,
  loadPrefs,
  savePrefs,
} from './patch/storage'
import { noteTarget, type NoteTarget } from './song/bind'
import { songEnd } from './song/schedule'
import {
  addPattern,
  addTrack,
  duplicatePattern,
  firstPlacement,
  sectionAt,
  nextPatternId,
  nextTrackId,
  patternOnly,
  removeTrack,
  setPatternNotes,
  updateTrack,
  consoleOf,
  trackMix,
} from './song/edit'
import { toStoredProject, type Rack } from './song/project'
import { BENCH_TRACK, benchSong, type Song } from './song/types'
import type { Patch, PatchModule } from './patch/types'
import { Cables, type DragState } from './ui/Cables'
import { nearestCable, type JackGeometry } from './ui/cableGeometry'
import { EngineContext } from './ui/EngineContext'
import { SampleContext } from './ui/SampleContext'
import { ExportPanel, type ExportSettings } from './ui/ExportPanel'
import { jackKey, type JackKind } from './ui/Jack'
import { LibraryDialog } from './ui/LibraryDialog'
import { ModuleSearch, type SearchPick } from './ui/ModuleSearch'
import { KnobHelpCard, KnobHelpOn } from './ui/KnobHelp'
import { saveMyPatch } from './patch/myLibrary'
import { MenuBar, type MenuDef } from './ui/Menu'
import { RackIndex } from './ui/RackIndex'
import { rackShares } from './ui/rackLayout'
import { RackUnit } from './ui/RackUnit'
import { SongDock } from './ui/SongDock'
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

/**
 * The colours a cable goes through on Alt+click, ending back at none -- the
 * rack's own colour for it. Spread round the wheel so any two next to each
 * other in a dense patch can be told apart.
 */
const CABLE_HUES = [0, 45, 90, 160, 200, 250, 290, 330]

/**
 * What Ctrl+C last took from a rack. Held for the session and not per track,
 * so a group copied from one track pastes into the next.
 */
let moduleClip: ModuleClip | null = null
const AUTOSAVE_MS = 400
/** Edits to the same control inside this window fold into one undo step. */
const COALESCE_MS = 600
const WAVE_COLUMNS = 200

/** Everything undo and save are concerned with. */
interface Doc {
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

/** `3 tracks`, `1 sample`: for notices that say what went into a file. */
function countOf(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * A rack for every track, whatever the file said.
 *
 * A project whose rack for some track could not be read still opens, with an
 * empty rack on that track -- losing one sound is survivable, and losing the
 * whole arrangement because one module was renamed is not.
 */
function fillRacks(song: Song, racks: Record<string, Rack>): Record<string, Rack> {
  const out = { ...racks }
  for (const t of song.tracks) {
    if (out[t.id]) continue
    const patch = defaultPatch()
    out[t.id] = { patch, values: initialValues(patch) }
  }
  return out
}

export default function App() {
  // Restore the last session, or start from the stock rack.
  const initialDoc = useMemo<Doc>(() => {
    const loaded = loadLocalProject()
    const song = loaded?.song ?? benchSong()
    return {
      name: loaded?.name ?? 'Untitled',
      song,
      racks: fillRacks(song, loaded?.racks ?? {}),
    }
  }, [])

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

  // The engine outlives any single patch; it is rewired, never replaced.
  const engine = useMemo(
    () =>
      new AudioEngine(
        initialDoc.song.tracks.map((t) => ({
          id: t.id,
          patch: initialDoc.racks[t.id].patch,
          values: initialDoc.racks[t.id].values,
        })),
      ),
    [initialDoc],
  )
  /**
   * The rack's audio. One of these for the life of the page: samples are
   * shared by hash, so two modules pointed at the same file hold one copy of
   * it between them.
   */
  const samples = useMemo(() => new SampleLibrary(), [])
  /**
   * Plays the song through that engine. One for the life of the page, like
   * the engine: it holds the lookahead cursor, and rebuilding it mid-loop
   * would drop whatever was queued.
   */
  const transport = useMemo(() => new Transport(engine, initialDoc.song), [engine, initialDoc])

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
   * The module search, when it is up: for adding a module, or, carrying the
   * loose end of a cable let go of over empty rack, for finishing that cable.
   */
  const [search, setSearch] = useState<{ cable?: DragState } | null>(null)
  /** Units picked by a click on their ear, for Ctrl+C. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  // What is picked belongs to the rack it was picked in.
  useEffect(() => setPicked(new Set()), [trackId])
  /** Whether a paste has anything to paste, for the Edit menu. */
  const [hasClip, setHasClip] = useState(moduleClip !== null)
  /**
   * Whether resting the pointer on a knob explains it. On to begin with, for
   * everyone learning the rack; off for anyone who knows it and would rather
   * the cards stayed out of the way. Remembered either way.
   */
  const [knobHelp, setKnobHelp] = useState(() => loadPrefs().knobHelp ?? true)
  /** Smaller units, to see more of a long rack at once. */
  const [compact, setCompact] = useState(() => loadPrefs().compact ?? false)
  /** How cables without a colour of their own are coloured. */
  const [cableColors, setCableColors] = useState<'signal' | 'module'>(
    () => loadPrefs().cableColors ?? 'signal',
  )
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
  const [dock, setDock] = useState(() => loadDock() ?? { open: false, height: 300 })
  /**
   * Whether the dock is showing the roll or the playlist.
   *
   * Up here rather than inside the dock because it decides what the transport
   * plays: the playlist plays the arrangement, and the roll plays whatever
   * `rollPlays` says.
   */
  const [dockView, setDockView] = useState<'roll' | 'song' | 'mix'>(() => loadPrefs().dockView ?? 'roll')
  /**
   * What the roll plays: the pattern being written, on its own and round and
   * round, or the song over the bars where that pattern sits -- so a melody
   * is written against the drums it will actually play over, heard as well as
   * seen.
   */
  const [rollPlays, setRollPlays] = useState<'pattern' | 'song'>(() => loadPrefs().rollPlays ?? 'pattern')
  // Remembered, like the dock's height: which view it shows and what the roll
  // plays are how you left the room, not part of the song.
  useEffect(() => savePrefs({ dockView, rollPlays }), [dockView, rollPlays])
  const [looping, setLooping] = useState(true)

  const rackRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const projectRef = useRef<HTMLInputElement>(null)
  /** The file on disk this project was opened from or last saved to, where the browser allows one. */
  const projectHandle = useRef<FileSystemFileHandle | null>(null)
  const trackFileRef = useRef<HTMLInputElement>(null)
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

  /**
   * Fetch the audio the patch names, and hand it to the rack.
   *
   * Keyed on the ids rather than on the patch, so moving a cable does not go
   * back to storage. Anything not found is remembered as missing by the
   * library, which is what a panel shows when a patch arrives from somebody
   * else.
   */
  const wanted = patch.modules
    .map((m) => m.sample?.id)
    .filter((id): id is string => !!id)
    .sort()
    .join(',')

  useEffect(() => {
    let live = true
    const ids = wanted ? wanted.split(',') : []
    void samples.hydrate(ids).then(() => {
      if (live) engine.setSamples(samples.records())
    })
    return () => {
      live = false
    }
  }, [wanted, samples, engine])

  /** Asked once, and never waited on: see `sampleStore`. */
  useEffect(() => askToPersist(), [])

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

  /**
   * Point a Sampler at a file, or at nothing.
   *
   * The audio is stored and decoded first and the patch edited second, so the
   * module never names something the library has not got -- which would put
   * the panel through its missing state on the way to a file that is right
   * there.
   */
  const onSample = useCallback(
    async (id: string, file: File | null) => {
      if (!file) {
        editPatch((p) => setSample(p, id, null))
        return
      }
      try {
        const loaded = await samples.add(file)
        engine.setSamples(samples.records())
        editPatch((p) => setSample(p, id, { id: loaded.id, name: loaded.name }))
      } catch {
        setNotice(`${file.name} is not audio this browser can read`)
      }
    },
    [editPatch, engine, samples],
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

  /**
   * An edit from the dock.
   *
   * Coalesced under one key, the way a knob drag is: dragging the tempo
   * spinner or stepping the bar count produces a value per press, and a
   * history full of one-bar increments is not something anybody wants to walk
   * back through. A note gesture already arrives as a single change.
   */
  const setSong = useCallback(
    (next: Song) => commitDoc((doc) => ({ ...doc, song: next }), 'song'),
    [commitDoc],
  )

  const setNotes = useCallback(
    (notes: Parameters<typeof setPatternNotes>[2]) =>
      editSong((s) => setPatternNotes(s, activePattern, notes)),
    [editSong, activePattern],
  )

  // --- tracks and patterns -------------------------------------------
  const onAddTrack = useCallback(() => {
    const id = nextTrackId(song)
    const patch = defaultPatch()
    commitDoc((doc) => ({
      ...doc,
      song: addTrack(doc.song, id, `Track ${doc.song.tracks.length + 1}`),
      racks: { ...doc.racks, [id]: { patch, values: initialValues(patch) } },
    }))
    // Selected straight away: adding a track is asking to work on it.
    setSelected(id)
  }, [commitDoc, song])

  const onRemoveTrack = useCallback(
    (id: string) => {
      commitDoc((doc) => {
        const song = removeTrack(doc.song, id)
        if (song === doc.song) return doc
        const racks = { ...doc.racks }
        delete racks[id]
        return { ...doc, song, racks }
      })
    },
    [commitDoc],
  )

  const onTrack = useCallback(
    (id: string, change: Parameters<typeof updateTrack>[2], key?: string) =>
      editSong((s) => updateTrack(s, id, change), key),
    [editSong],
  )

  /**
   * The project's name, from the field on the dock bar.
   *
   * Nothing else writes it. It used to follow the track while there was only
   * one, back when a project and a patch were the same thing; now that they
   * are not, a name that changed under you would leave it unclear which of
   * the two a file was about to be called after.
   */
  const setProjectName = useCallback(
    (next: string) => commitDoc((doc) => ({ ...doc, name: next }), 'project-name'),
    [commitDoc],
  )

  const onAddPattern = useCallback(
    (from?: string) => {
      const id = nextPatternId(song)
      const name = `Pattern ${song.patterns.length + 1}`
      editSong((s) => (from ? duplicatePattern(s, from, id, name) : addPattern(s, id, name)))
      setPatternId(id)
    },
    [editSong, song],
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
  /**
   * The racks as the audio thread last saw them.
   *
   * Diffed rather than pushed wholesale, because a track whose patch has not
   * changed must not be rebuilt: a rebuild is the one thing that would reset
   * its filters and cut its envelopes, and editing one rack would then click
   * on every other.
   */
  const shipped = useRef<Record<string, Rack>>(initialDoc.racks)

  useEffect(() => {
    const before = shipped.current
    for (const track of song.tracks) {
      const rack = racks[track.id]
      if (!rack) continue
      const was = before[track.id]
      // A new track, or a rewired one, goes over as a patch; a knob moved on
      // an existing one goes over as a handful of numbers.
      if (!was || was.patch !== rack.patch) engine.setTrackPatch(track.id, rack.patch, rack.values)
      else if (was.values !== rack.values) engine.setValues(track.id, rack.values)
    }
    for (const id of Object.keys(before)) {
      if (!racks[id]) engine.removeTrack(id)
    }
    shipped.current = racks
  }, [engine, racks, song.tracks])

  /**
   * Every track's channel -- fader, pan, EQ, sends -- with solo and mute
   * resolved into one answer per track, as a desk gives it; and the desk.
   */
  useEffect(() => {
    engine.setMix(trackMix(song))
  }, [engine, song])
  const desk = consoleOf(song)
  useEffect(() => {
    engine.setConsole(desk)
  }, [engine, desk])

  // Only the rack on the bench reports its scopes and meters; the others are
  // not on screen, and posting their frames would be work nobody can see.
  useEffect(() => {
    engine.watch(trackId)
  }, [engine, trackId])

  /**
   * What the transport plays.
   *
   * The roll loops the pattern being written, on its own; the playlist plays
   * the arrangement. Derived as a song either way, so there is one code path
   * rather than a mode inside the transport.
   */
  /**
   * The section the playlist is looping, by its marker's tick, or null for
   * the whole song. Chosen by clicking a marker; only the playlist plays it.
   */
  const [section, setSection] = useState<number | null>(null)
  const sectionSpan = useMemo(
    () => (dockView !== 'roll' && section !== null ? sectionAt(song, section) : null),
    [dockView, section, song],
  )
  const inContext = dockView === 'roll' && rollPlays === 'song'
  const playSong = useMemo(
    () => (dockView === 'roll' && !inContext ? patternOnly(song, activePattern) : song),
    [dockView, inContext, song, activePattern],
  )
  /**
   * The bars the roll loops when it plays the pattern in the song: its first
   * placement. Null when it is not in the song, which plays the arrangement
   * from the top without it.
   */
  const contextSpan = useMemo(() => {
    if (!inContext) return null
    const at = firstPlacement(song, activePattern)
    const pattern = song.patterns.find((p) => p.id === activePattern)
    return at === null || !pattern ? null : { from: at, to: at + pattern.length }
  }, [inContext, song, activePattern])

  // The transport reads the song on every fill, so an edit is heard within
  // the lookahead without anything being torn down. Only a tempo change makes
  // it drop what it has queued, which it works out for itself.
  useEffect(() => {
    transport.setSong(playSong)
  }, [transport, playSong])

  useEffect(() => {
    if (contextSpan) {
      transport.setLoop(looping ? contextSpan : null)
      return
    }
    if (sectionSpan) {
      transport.setLoop(looping ? sectionSpan : null)
      return
    }
    const end = songEnd(playSong)
    transport.setLoop(looping && end > 0 ? { from: 0, to: end } : null)
  }, [transport, playSong, looping, contextSpan, sectionSpan])

  // Choosing a section while the song plays jumps there, as clicking a marker
  // on any arrangement does, and loops it from then on.
  const playedSection = useRef(section)
  useEffect(() => {
    if (playedSection.current === section) return
    playedSection.current = section
    if (!transport.state.playing) return
    transport.stop()
    void transport.play(sectionSpan?.from ?? 0)
  }, [transport, section, sectionSpan])

  // Flipping the roll between its pattern and the song while it plays starts
  // it again from the top of whichever it now plays. Carried on from where it
  // was, the playhead would be a position in the pattern read as a position
  // in the song. After the two effects above, so the song and the loop it
  // restarts into are already the new ones.
  const playedInContext = useRef(inContext)
  useEffect(() => {
    if (playedInContext.current === inContext) return
    playedInContext.current = inContext
    if (!transport.state.playing) return
    transport.stop()
    void transport.play(contextSpan?.from ?? 0)
  }, [transport, inContext, contextSpan])

  /**
   * Which module in each track's rack that track's notes are played on.
   *
   * Recomputed whenever a rack changes, because adding a Keyboard to one that
   * had none is exactly the moment the roll should start working.
   */
  const targets = useMemo(() => {
    const map = new Map<string, NoteTarget>()
    for (const track of song.tracks) {
      const rack = racks[track.id]
      const target = rack && noteTarget(rack.patch)
      if (target) map.set(track.id, target)
    }
    return map
  }, [song.tracks, racks])

  useEffect(() => {
    transport.setTargets(targets)
  }, [transport, targets])

  useEffect(() => {
    const t = setTimeout(() => saveLocalProject(toStoredProject(name, song, racks)), AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [name, song, racks])

  useEffect(() => {
    const t = setTimeout(() => saveDock(dock), AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [dock])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  /**
   * Keep the message card just above the dock, whatever height it is.
   *
   * `--dock-h` is the rack's allowance for the dock and is only near enough
   * for padding: folded, the transport is taller than it says, and the card
   * sat on top of the play button. So the card is lifted by the dock's real
   * height, measured as it changes -- a fold, a drag of the roll's edge, the
   * transport wrapping on a narrow window. Written to the style directly, as
   * a drag of the dock's edge would otherwise re-render the app every frame.
   */
  const noticesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const dockEl = document.querySelector<HTMLElement>('.dock')
    const el = noticesRef.current
    if (!dockEl || !el) return
    const sync = () => {
      el.style.bottom = `${Math.round(dockEl.getBoundingClientRect().height) + 12}px`
    }
    sync()
    const watch = new ResizeObserver(sync)
    watch.observe(dockEl)
    return () => watch.disconnect()
  }, [])

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
  }, [measure, turning, flipped, patch, rack.order, compact])

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
  /**
   * A new unit from the menu. In front of the first picked unit, in rack
   * order, when something is picked -- that is where you are working -- and
   * at the top of the rack when nothing is. The pick stays where it was, so a
   * second unit added lands after the first rather than in front of it.
   */
  const onAddModule = useCallback(
    (type: string) =>
      editPatch((p) => {
        const module = freshModule(p, type)
        const first = p.modules.find((m) => picked.has(m.id))
        return first ? addModuleBefore(p, first.id, module) : addModule(p, module, 'top')
      }),
    [editPatch, picked],
  )

  /**
   * What the module search chose. On its own, a module placed as one from
   * the menu is. Finishing a cable, the module goes in next to the one
   * the cable came from -- which is where you were looking -- and the cable
   * goes into the jack that was picked.
   */
  const onSearchPick = useCallback(
    (pick: SearchPick) => {
      const cable = search?.cable
      setSearch(null)
      if (!cable || !pick.port) {
        onAddModule(pick.type)
        return
      }
      editPatch((p) => {
        const module = freshModule(p, pick.type)
        const placed = addModuleAfter(p, cable.anchor.module, module)
        const other = { module: module.id, port: pick.port! }
        return cable.anchorKind === 'output'
          ? connect(placed, cable.anchor, other)
          : connect(placed, other, cable.anchor)
      })
    },
    [search, editPatch, onAddModule],
  )

  /** Ctrl+C on the rack: the picked units, their knobs and the cables between them. */
  const copyPicked = useCallback(() => {
    const ids = [...picked].filter((id) => patch.modules.some((m) => m.id === id))
    if (ids.length === 0) return
    moduleClip = copyModules(patch, values, ids)
    setHasClip(true)
    setNotice(`Copied ${ids.length === 1 ? ids[0] : `${ids.length} modules`}`)
  }, [picked, patch, values])

  /** Ctrl+V on the rack: into whichever track is on the bench, picked afterwards. */
  const pasteClip = useCallback(() => {
    const clip = moduleClip
    if (!clip || clip.modules.length === 0) return
    let pasted: string[] = []
    editRack((rack) => {
      const out = pasteModules(rack.patch, rack.values, clip)
      pasted = out.ids
      return { patch: out.patch, values: out.values }
    })
    setPicked(new Set(pasted))
  }, [editRack])

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
      editRack((rack) => {
        const source = rack.patch.modules.find((m) => m.id === id)
        if (!source) return rack

        const copy: PatchModule = {
          id: nextModuleId(rack.patch, source.type),
          type: source.type,
          params: { ...source.params },
        }
        // The key comes with it. A copy is a copy, and two Triggers on one key
        // firing together is a layer -- which is a reason to duplicate one in
        // the first place. The cap on the new panel is how it gets its own.
        if (source.key) copy.key = source.key

        const patch = addModuleAfter(rack.patch, id, copy)
        const values = reconcileValues(patch, rack.values)
        for (const spec of defOf(source.type).params) {
          const held = rack.values[`${id}.${spec.id}`]
          if (held !== undefined) values[`${copy.id}.${spec.id}`] = held
        }
        return { patch, values }
      })
    },
    [editRack],
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
    (next: Patch, trackName: string, preset?: Record<string, number>) => {
      coalesceKey.current = null
      const values = preset ? { ...initialValues(next), ...preset } : initialValues(next)
      commitDoc((doc) => ({
        ...doc,
        // The rack changes; the arrangement does not. A track's name is the
        // name of the sound on it, so loading one onto a track renames that
        // track and leaves every note where it was.
        song: updateTrack(doc.song, trackId, { name: trackName }),
        racks: { ...doc.racks, [trackId]: { patch: next, values } },
      }))
    },
    [commitDoc, trackId],
  )

  /**
   * No confirmation step any more. It used to be a button on the bar, where a
   * stray click could land on it; reaching it now means opening a menu and
   * choosing it. And `applyPatch` commits through the history like any other
   * edit, so the way back is the way back from everything else.
   */
  const onNew = useCallback(() => {
    coalesceKey.current = null
    // A new project has not been saved anywhere, so its first Save asks where.
    projectHandle.current = null
    const patch = defaultPatch()
    const song = benchSong()
    commitDoc(() => ({
      name: 'Untitled',
      song,
      racks: { [BENCH_TRACK]: { patch, values: initialValues(patch) } },
    }))
    setSelected(BENCH_TRACK)
    setPatternId(song.patterns[0].id)
    setNotice('Started a new project -- Ctrl+Z to undo')
  }, [commitDoc])

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

  /**
   * Keep the rack on the bench on the library's My patches shelf, under the
   * track's name -- which is the name of the sound on it. Saving under a name
   * already there updates that one.
   */
  const onSaveToLibrary = useCallback((): string | null => {
    const name = song.tracks.find((t) => t.id === trackId)?.name || 'Untitled'
    const saved = saveMyPatch(name, patch, values)
    if (!saved) {
      setNotice('Could not save to the library: this browser is not letting the page store anything')
      return null
    }
    setNotice(saved.updated ? `Updated ${name} in My patches` : `Saved ${name} to My patches`)
    return name
  }, [song.tracks, trackId, patch, values])

  /** Show or hide the music dock, from the View menu or Ctrl+M. */
  const toggleDock = useCallback(() => setDock((d) => ({ ...d, open: !d.open })), [])

  /**
   * Export the rack: a patch on its own, or a bundle when a Sampler is in it.
   *
   * The audio is fetched from storage rather than re-encoded from what is
   * loaded, so what lands in the zip is the file that was dropped in.
   */
  /** The audio a set of racks names, fetched from storage as it was dropped in. */
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

  const onExportPatch = useCallback(async () => {
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
  }, [patchName, patch, values, gatherSamples])

  /**
   * The whole piece: the arrangement, every rack, and all of the audio.
   *
   * Where the browser can hold on to a file, Save writes back into the one
   * this project came from or was last saved to, and only Save As -- or a
   * project that has never been to disk -- asks where. Elsewhere every save
   * is a download, as it always was.
   */
  const onSaveProject = useCallback(
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
    [name, song, racks, gatherSamples],
  )

  /**
   * Bounce the arrangement to a file.
   *
   * The transport is stopped first. The bounce runs its own player and would
   * be correct either way, but the two would be competing for the same thread
   * and the loop you were listening to would stutter for as long as it took.
   */
  const onBounceSong = useCallback(async () => {
    if (songEnd(song) <= 0) {
      setNotice('Nothing on the playlist to bounce -- put a pattern in a bar first')
      return
    }
    transport.stop()
    setNotice('Bouncing...')
    try {
      const audio = await renderSong(song, racks, {
        sampleRate: engine.sampleRate,
        samples: samples.bank(),
        onProgress: async (done) => {
          setNotice(`Bouncing ${Math.round(done * 100)}%`)
          await nextFrame()
        },
      })
      // 24-bit: a mix is more likely than a one-shot to be mastered or
      // re-encoded afterwards, and the headroom costs a third of a file that
      // is already small.
      downloadBytes(
        encodeWav([audio.left, audio.right], audio.sampleRate, 24) as BlobPart,
        `${slug(name)}.wav`,
        'audio/wav',
      )
      setNotice(
        audio.peak > 1
          ? `Bounced ${audio.seconds.toFixed(1)}s -- it clips at ${audio.peak.toFixed(2)}, so bring the levels down`
          : `Bounced ${audio.seconds.toFixed(1)}s, peak ${audio.peak.toFixed(2)}`,
      )
    } catch (err) {
      setNotice(`Bounce failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [song, racks, name, engine, samples, transport])

  /** One file per track, so the mix can be rebuilt or re-balanced elsewhere. */
  /**
   * Stems, carrying as much of each track's channel as was asked for: the rack
   * alone, through its strip, or with its reverb and echo as well.
   */
  const onBounceStems = useCallback(async (stemMix: StemMix) => {
    if (songEnd(song) <= 0) {
      setNotice('Nothing on the playlist to bounce -- put a pattern in a bar first')
      return
    }
    transport.stop()
    setNotice('Bouncing stems...')
    try {
      const stems = await renderStems(song, racks, {
        stemMix,
        sampleRate: engine.sampleRate,
        samples: samples.bank(),
        onProgress: async (done) => {
          setNotice(`Bouncing stems ${Math.round(done * 100)}%`)
          await nextFrame()
        },
      })
      if (stems.length === 0) {
        setNotice('Every track is muted, so there are no stems to write')
        return
      }
      // Numbered, so they sort into the order the tracks are in rather than
      // alphabetically -- which is the order anybody will want to line them up.
      const entries: ZipEntry[] = stems.map((stem, i) => ({
        name: `${String(i + 1).padStart(2, '0')} ${slug(stem.name)}.wav`,
        data: encodeWav([stem.audio.left, stem.audio.right], stem.audio.sampleRate, 24),
      }))
      downloadBytes(makeZip(entries) as BlobPart, `${slug(name)}-stems.zip`, 'application/zip')
      setNotice(`Bounced ${stems.length} stem${stems.length === 1 ? '' : 's'}`)
    } catch (err) {
      setNotice(`Bounce failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [song, racks, name, engine, samples, transport])

  const onOpenProject = useCallback(
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

      coalesceKey.current = null
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
    [commitDoc, engine, samples],
  )

  /**
   * Choose a project to open. Through the file picker that can hold on to
   * the file when there is one, so a later Save goes back into it; through
   * the plain file input otherwise.
   */
  const onPickProject = useCallback(async () => {
    if (!canUseFileHandles) {
      projectRef.current?.click()
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
    if (await onOpenProject(picked.file)) projectHandle.current = picked.handle
  }, [onOpenProject])

  /**
   * Bring a patch in from a file: onto the selected track in place of the
   * sound it has, or onto a track of its own. Either way the arrangement is
   * left alone -- a patch has no notes in it.
   */
  const onImport = useCallback(
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
        coalesceKey.current = null
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
    [applyPatch, commitDoc, song],
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
        let limited = 0
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
              // A take has to contain whatever a Sampler is playing, so the
              // offline pass gets the same audio the live rack has.
              samples: samples.bank(),
            },
            i,
            settings.spread,
          )
          // Levelled here, before anything is drawn or heard, so the take
          // you audition is the take that gets saved.
          const level = normalize(take.left, take.right, take.sampleRate, settings.normalize)
          if (level.limited) limited++
          rendered.push({
            index: i,
            seed: take.seed,
            seconds: take.seconds,
            peak: level.peak,
            sampleRate: take.sampleRate,
            left: level.left,
            right: level.right,
            envelope: peakEnvelope(level.left, level.right, WAVE_COLUMNS),
            keep: true,
          })
        }
        setTakes(rendered)
        setNotice(
          `Rendered ${rendered.length} take${rendered.length === 1 ? '' : 's'}` +
            // Said, because the file is quieter than the target it was set to.
            (limited > 0
              ? ` -- ${limited} held at -1 dB peak, short of the loudness target`
              : ''),
        )
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
    const base = slug(patchName)
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
  }, [takes, patchName, lastSettings])

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
          setDrag({ anchor: existing.from, anchorKind: 'output', cursor, pulled: true })
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
      if (!hit) return
      // Alt+click gives a cable a colour of its own, and the next one each
      // time, round to none; a plain click still pulls it out.
      if (e.altKey) {
        const at = hit.color === undefined ? -1 : CABLE_HUES.indexOf(hit.color)
        const next = at + 1 < CABLE_HUES.length ? CABLE_HUES[at + 1] : undefined
        editPatch((p) => setCableColor(p, hit.id, next))
        return
      }
      editPatch((p) => disconnect(p, hit.id))
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
      // A new cable let go of over nothing: offer the modules that could take
      // it, the way the fastest racks work -- the cable stays in hand until a
      // module is chosen for it, and Escape drops it. One pulled out of a jack
      // and let go of is unplugged, which is what that gesture has always been.
      if (!(target instanceof HTMLElement)) {
        if (!current.pulled) setSearch({ cable: current })
        return
      }

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
      engine.gate(true, trackId, moduleId)
      void engine.start().then(() => setRunning(true))
    },
    [engine, trackId],
  )

  const gateOff = useCallback(
    (moduleId: string) => engine.gate(false, trackId, moduleId),
    [engine, trackId],
  )

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
    suspended: menuOpen || libraryOpen || search !== null || listening !== null,
    bindings: [
      ...triggerKeys,
      { code: 'Tab', onDown: flip },
      { code: 'KeyK', ctrl: true, onDown: () => setSearch({}) },
      { code: 'KeyM', ctrl: true, onDown: toggleDock },
      // Taken from the browser, whose own Save would write out the page.
      { code: 'KeyS', ctrl: true, onDown: () => void onSaveProject() },
      { code: 'KeyS', ctrl: true, shift: true, onDown: () => void onSaveProject(true) },
      { code: 'KeyO', ctrl: true, onDown: () => void onPickProject() },
      // The rack's copy and paste stand aside while the roll has the keyboard:
      // there, the same keys copy notes.
      { code: 'KeyC', ctrl: true, onDown: () => rackHasKeys() && copyPicked() },
      { code: 'KeyV', ctrl: true, onDown: () => rackHasKeys() && pasteClip() },
      { code: 'Escape', onDown: () => rackHasKeys() && setPicked(new Set()) },
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
  /** How the half-width units split their rows, in the order they are shown. */
  const shares = rackShares(rack.order, (id) => {
    const m = byId.get(id)
    return m && defOf(m.type)
  })
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
      // The whole piece: every track, the patch on each, the notes, the
      // arrangement, and the audio the Samplers play.
      label: 'Project',
      items: [
        { kind: 'action', label: 'New project', onSelect: onNew },
        { kind: 'action', label: 'Open project...', shortcut: 'Ctrl+O', onSelect: () => void onPickProject() },
        { kind: 'action', label: 'Save project', shortcut: 'Ctrl+S', onSelect: () => void onSaveProject() },
        { kind: 'action', label: 'Save project as...', shortcut: 'Ctrl+Shift+S', onSelect: () => void onSaveProject(true) },
        { kind: 'separator' },
        // The piece as audio. The project above is the piece as something you
        // can still change your mind about.
        { kind: 'action', label: 'Bounce song...', onSelect: () => void onBounceSong() },
        {
          kind: 'submenu',
          label: 'Bounce stems',
          // What each stem carries of its channel. Never the master bus: see
          // `StemMix`.
          items: [
            { kind: 'action', label: 'Channel only (EQ, pan, fader)...', onSelect: () => void onBounceStems('channel') },
            { kind: 'action', label: 'Channel and sends (with reverb, delay)...', onSelect: () => void onBounceStems('sends') },
            { kind: 'action', label: 'Raw rack output...', onSelect: () => void onBounceStems('raw') },
          ],
        },
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
        { kind: 'separator' },
        {
          kind: 'action', label: 'Copy modules', shortcut: 'Ctrl+C',
          disabled: picked.size === 0, onSelect: copyPicked,
        },
        {
          kind: 'action', label: 'Paste modules', shortcut: 'Ctrl+V',
          disabled: !hasClip, onSelect: pasteClip,
        },
      ],
    },
    {
      // One sound: the rack on the selected track and any audio it plays.
      // What you send somebody when you mean "here is a sound" rather than
      // "here is the piece", and what carries a sound from one project into
      // the next. No notes travel with it.
      label: 'Patch',
      items: [
        { kind: 'action', label: 'Library...', onSelect: () => setLibraryOpen(true) },
        { kind: 'separator' },
        { kind: 'action', label: 'Open patch...', onSelect: () => fileRef.current?.click() },
        {
          kind: 'action',
          label: 'Add patch as track...',
          onSelect: () => trackFileRef.current?.click(),
        },
        { kind: 'action', label: 'Save patch...', onSelect: () => void onExportPatch() },
        { kind: 'action', label: 'Save to library', onSelect: () => void onSaveToLibrary() },
      ],
    },
    {
      label: 'Modules',
      // Grouped from the catalogue itself, so a new module appears here
      // without this file knowing anything about it.
      items: [
        { kind: 'action' as const, label: 'Search...', shortcut: 'Ctrl+K', onSelect: () => setSearch({}) },
        { kind: 'separator' as const },
        ...MODULE_GROUPS.map((g) => ({
          kind: 'submenu' as const,
          label: g.name,
          items: modulesByGroup(g.id).map((def) => ({
            kind: 'action' as const,
            label: def.name,
            onSelect: () => onAddModule(def.type),
          })),
        })),
      ],
    },
    {
      label: 'View',
      items: [
        { kind: 'toggle', label: 'Back panel', shortcut: 'Tab', checked: flipped, onSelect: flip },
        // Beside the rack's flip, because the dock is the other half of the
        // room: the button on the dock's bar does the same thing.
        { kind: 'toggle', label: 'Music', shortcut: 'Ctrl+M', checked: dock.open, onSelect: toggleDock },
        {
          kind: 'toggle',
          label: 'Knob help',
          checked: knobHelp,
          onSelect: () => {
            setKnobHelp(!knobHelp)
            savePrefs({ knobHelp: !knobHelp })
          },
        },
        {
          kind: 'toggle',
          label: 'Compact rack',
          checked: compact,
          onSelect: () => {
            setCompact(!compact)
            savePrefs({ compact: !compact })
          },
        },
        {
          kind: 'submenu',
          label: 'Cable colours',
          items: (['signal', 'module'] as const).map((by) => ({
            kind: 'toggle' as const,
            label: by === 'signal' ? 'By signal' : 'By module',
            checked: cableColors === by,
            onSelect: () => {
              setCableColors(by)
              savePrefs({ cableColors: by })
            },
          })),
        },
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

  /** Scroll a unit into view and pick it, so it is lit when it arrives. */
  const jumpTo = (id: string) => {
    document
      .querySelector(`.unit-flip[data-module="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setPicked(new Set([id]))
  }

  return (
    <>
      {/* Outside the rack's column so the bar can run the width of the
          window; its contents are held to the column inside it. */}
      <header className="masthead">
        <div className="masthead-inner">
          {/* The nameplate, with the lamp that says the engine is running. */}
          <div className="masthead-brand">
            <h1>Fresyn</h1>
            <span className={`led ${running ? 'on' : ''}`} />
          </div>

          <MenuBar menus={menus} onOpenChange={setMenuOpen} collapsed={narrow} />

          <input
            ref={fileRef}
            className="patch-file"
            type="file"
            // A bundle is a zip, and a rack with a Sampler in it exports as one.
            accept="application/json,.json,application/zip,.zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onImport(file, false)
              e.target.value = ''
            }}
          />

          <input
            ref={trackFileRef}
            className="track-file"
            type="file"
            accept="application/json,.json,application/zip,.zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onImport(file, true)
              e.target.value = ''
            }}
          />

          {/* Its own input rather than a mode on the one above: the two accept
              the same extensions, and a single control that sometimes replaced
              one rack and sometimes the whole project would be the kind of
              thing you only find out about afterwards. */}
          <input
            ref={projectRef}
            className="project-file"
            type="file"
            accept="application/json,.json,application/zip,.zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onOpenProject(file)
              e.target.value = ''
            }}
          />

          {/* Every unit in the rack by name, for getting to one without
              scrolling a long rack to look for it. Choosing one scrolls it into
              view and picks it, so it is lit when it arrives. */}
          <select
            className="rack-index"
            value=""
            aria-label="Jump to a module"
            title="Jump to a module in this rack"
            onChange={(e) => {
              const id = e.target.value
              e.target.blur()
              if (id) jumpTo(id)
            }}
          >
            <option value="">Jump to…</option>
            {rack.order.flatMap((id) => {
              const m = byId.get(id)
              return m ? [
                <option key={id} value={id}>
                  {id} · {defOf(m.type).name}
                </option>,
              ] : []
            })}
          </select>
        </div>
      </header>

      {/* The dock is fixed to the bottom of the window, so the rack needs room
          underneath it or the last unit in a long patch cannot be scrolled to. */}
      <div
        className="app"
        style={{ '--dock-h': `${dock.open ? dock.height + 76 : 44}px` } as React.CSSProperties}
      >

        {/* A card in the bottom corner, just above the dock, not a line in
            the page: it used to sit above the rack and shove every unit down
            by its own height each time it came and went. Lifted clear of the
            dock by its measured height (see noticesRef). The region is always
            there, so a screen reader hears each message arrive. */}
        <div className="notices" ref={noticesRef} role="status" aria-live="polite">
          {notice && (
            <div className="notice">
              <span className="notice-text">{notice}</span>
              <button
                className="notice-close"
                onClick={() => setNotice(null)}
                aria-label="Dismiss"
                title="Dismiss"
                type="button"
              >
                ×
              </button>
            </div>
          )}
        </div>

        {libraryOpen && (
          <LibraryDialog onPick={onPickTemplate} onClose={() => setLibraryOpen(false)} onSave={onSaveToLibrary} />
        )}

        {search && (
          <ModuleSearch
            cable={search.cable?.anchorKind}
            onPick={onSearchPick}
            onClose={() => setSearch(null)}
          />
        )}

        <RackIndex
          tracks={song.tracks}
          trackId={trackId}
          onSelectTrack={setSelected}
          entries={rack.order.flatMap((id) => {
            const m = byId.get(id)
            return m ? [{ id, name: defOf(m.type).name, bypassed: !!m.bypass }] : []
          })}
          picked={picked}
          onJump={jumpTo}
          flipped={flipped}
          onFlip={flip}
        />

        {/* Panels that show live audio, such as the scope, take the engine from
            here rather than being handed it down through every rack unit. The
            appearance rides along for the same reason: a canvas cannot read the
            stylesheet, so the scope has to be told when the palette changed. */}
        <KnobHelpCard />
        <KnobHelpOn.Provider value={knobHelp}>
        <ThemeContext.Provider value={appearance}>
          <EngineContext.Provider value={engine}>
          <SampleContext.Provider value={samples}>
            <div
              className={`rack${flipped ? ' rack-flipped' : ''}${compact ? ' compact' : ''}${
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
                  share={shares.get(m.id)}
                  onGrab={(e) => {
                    // Shift+click on an ear adds the unit to what is picked or
                    // takes it out, and moves nothing. A plain press picks it
                    // alone and is also the start of a drag, as it always was.
                    if (e.shiftKey) {
                      e.preventDefault()
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (next.has(m.id)) next.delete(m.id)
                        else next.add(m.id)
                        return next
                      })
                      return
                    }
                    // Taking hold of one of several picked units takes hold of
                    // them all, and they move as one block. Any other unit is
                    // picked alone and moves alone.
                    if (picked.has(m.id) && picked.size > 1) {
                      rack.start(m.id, e, [...picked])
                      return
                    }
                    if (e.button === 0) setPicked(new Set([m.id]))
                    rack.start(m.id, e)
                  }}
                  onGate={(open) => (open ? gateOn(m.id) : gateOff(m.id))}
                  dragging={rack.group.includes(m.id)}
                  selected={picked.has(m.id)}
                  bypassed={!!m.bypass}
                  onBypass={defOf(m.type).bypass ? () => editPatch((p) => toggleBypass(p, m.id)) : undefined}
                  presets={{
                    current: () =>
                      Object.fromEntries(
                        defOf(m.type).params.map((spec) => [spec.id, values[`${m.id}.${spec.id}`] ?? spec.default]),
                      ),
                    // One edit, so a preset loaded by mistake is one Ctrl+Z.
                    onApply: (params) =>
                      editRack((r) => {
                        const next = { ...r.values }
                        for (const spec of defOf(m.type).params) {
                          const v = params[spec.id]
                          if (typeof v === 'number' && Number.isFinite(v)) next[`${m.id}.${spec.id}`] = v
                        }
                        return { ...r, values: next }
                      }),
                  }}
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
                  onChanges={(changes) => setParams(m.id, changes)}
                  sample={m.sample}
                  onSample={(file) => void onSample(m.id, file)}
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
                <Cables
                  patch={patch}
                  geometry={geometry}
                  drag={search?.cable ?? drag}
                  hovered={hoveredCable}
                  colorBy={cableColors}
                />
              )}
            </div>
          </SampleContext.Provider>
          </EngineContext.Provider>
        </ThemeContext.Provider>
        </KnobHelpOn.Provider>

        {/* The panel in hand. It rides outside the rack because the rack sets a
            perspective, and a perspective is a containing block -- a fixed
            element inside one is positioned against it rather than the
            viewport, which is not what "follows the pointer" means. */}
        {/* The roll. Outside the rack for the same reason the ghost below is:
            the rack sets a perspective, and a perspective is a containing block,
            so a fixed element inside one is positioned against the rack rather
            than against the window. */}
        <ThemeContext.Provider value={appearance}>
          <SongDock
            transport={transport}
            projectName={name}
            onProjectName={setProjectName}
            song={song}
            onSong={setSong}
            onNotes={setNotes}
            trackId={trackId}
            onSelectTrack={setSelected}
            onAddTrack={onAddTrack}
            onRemoveTrack={onRemoveTrack}
            onTrack={onTrack}
            patternId={activePattern}
            onSelectPattern={setPatternId}
            onAddPattern={onAddPattern}
            targets={targets}
            view={dockView}
            onView={setDockView}
            onEdit={editSong}
            engine={engine}
            rollPlays={rollPlays}
            onRollPlays={setRollPlays}
            section={sectionSpan ? section : null}
            onSection={setSection}
            looping={looping}
            onLooping={setLooping}
            open={dock.open}
            onOpenChange={(open) => setDock((d) => ({ ...d, open }))}
            height={dock.height}
            onHeight={(height) => setDock((d) => ({ ...d, height }))}
          />
        </ThemeContext.Provider>

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
                  {rack.group.length > 1 && ` and ${rack.group.length - 1} more`}
                </span>
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  )
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/**
 * A new module of this type for a rack. A Trigger arrives on Space, so the
 * first one in a rack plays without a trip to its cap first. Later ones land
 * on the same key and fire together until they are told otherwise, which is
 * the honest default: a key that does nothing would look broken.
 */
function freshModule(patch: Patch, type: string): PatchModule {
  const key = defOf(type).keyed ? 'Space' : undefined
  return { id: nextModuleId(patch, type), type, params: {}, ...(key ? { key } : {}) }
}

/**
 * Whether a rack shortcut should act, rather than the roll's: the roll takes
 * the same keys for notes while it has the keyboard.
 */
function rackHasKeys() {
  const active = document.activeElement
  return !(active instanceof Element && active.closest('.roll'))
}
