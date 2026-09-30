import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { AudioEngine, type EngineStatus } from './audio/AudioEngine'
import { Transport } from './audio/Transport'
import { SampleLibrary } from './audio/SampleLibrary'
import { askToPersist, pruneSamples } from './audio/sampleStore'
import { useBounce } from './hooks/useBounce'
import { useJob } from './hooks/useJob'
import { useCableDrag } from './hooks/useCableDrag'
import { loadInitialDoc, useDocument } from './hooks/useDocument'
import { useProjectFiles } from './hooks/useProjectFiles'
import { useStableActions } from './hooks/useStableActions'
import { useTakes } from './hooks/useTakes'
import { useTriggers } from './hooks/useTriggers'
import { useInput } from './input/useInput'
import { LiveNotes } from './input/liveNotes'
import { useMidiInput } from './input/midi'
import { defOf } from './patch/defs'
import { defaultPatch } from './patch/defaultPatch'
import { sampleIdsIn, sampleIdsInLocalStorage } from './patch/sampleRefs'
import type { Template } from './patch/library'
import {
  addModule,
  addModuleAfter,
  addModuleBefore,
  connect,
  copyModules,
  disconnect,
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
import { canRedo, canUndo, steps } from './patch/history'
import { loadDock, saveDock, saveLocalProject, loadPrefs, savePrefs } from './patch/storage'
import { engineEvents, kitRow, kitTarget, noteTarget, type NoteTarget } from './song/bind'
import { DEFAULT_KIT, kitSlots, NOT_IN_A_PAD, padPatch, setKitSlot, updateKitSlot, withPadView } from './patch/kit'
import { midiName, rowForMidi, tuningOf } from './song/tuning'
import { songEnd } from './song/schedule'
import { sectionAt } from './song/section'
import {
  addPattern,
  addTrack,
  duplicatePattern,
  firstPlacement,
  nextPatternId,
  nextTrackId,
  patternOnly,
  removePattern,
  removeTrack,
  updateTrack,
  consoleOf,
  trackMix,
} from './song/edit'
import { toStoredProject, type Rack } from './song/project'
import { BENCH_TRACK, benchSong } from './song/types'
import type { Patch, PatchModule } from './patch/types'
import { Cables, type DragState } from './ui/Cables'
import { nearestCable, type JackGeometry } from './ui/cableGeometry'
import { EngineContext, EnginePrefix } from './ui/EngineContext'
import { SampleContext } from './ui/SampleContext'
import { UnitBoundary } from './ui/ErrorBoundary'
import { jackKey } from './ui/Jack'
import { ModuleSearch, type SearchPick } from './ui/ModuleSearch'
import { asNotice, NOTICE_FADE_MS, warn, type NoticeInput } from './ui/notice'
import { KnobHelpCard, KnobHelpOn } from './ui/KnobHelp'
import { saveMyPatch } from './patch/myLibrary'
import { MenuBar } from './ui/Menu'
import { buildMenus } from './ui/menus'
import { RackIndex } from './ui/RackIndex'
import { rackShares } from './ui/rackLayout'
import { RackUnit, type RackActions } from './ui/RackUnit'
import { AudioSettingsDialog } from './ui/AudioSettingsDialog'
import { HistoryPanel } from './ui/HistoryPanel'
import { BounceDialog } from './ui/BounceDialog'
import type { StemMix } from './audio/renderSong'
import { SongDock } from './ui/SongDock'
import { ThemeContext, useAppearanceState } from './ui/ThemeContext'
import { UnitSpine } from './ui/UnitSpine'
import { dockHeightWithin, useDockMax } from './ui/useDockMax'
import { useRackDrag } from './ui/useRackDrag'

/**
 * The library, fetched when it is first opened. It carries every template
 * and instrument the app ships -- the largest thing in it, and something a
 * session that never opens the library has no use for.
 *
 * Kept in state once it arrives rather than put behind Suspense, which holds
 * a resolved boundary back for a few hundred milliseconds before it shows.
 */
type LibraryDialogType = typeof import('./ui/LibraryDialog').LibraryDialog
let libraryLoading: Promise<LibraryDialogType> | undefined
const loadLibrary = () =>
  (libraryLoading ??= import('./ui/LibraryDialog').then((m) => m.LibraryDialog))

/** Must match the flip transition in app.css. */
const FLIP_MS = 420
/**
 * The key that turns the rack round: a bare F, for Flip. Not Tab, which it
 * was for a long time -- Tab is how a keyboard gets from one control to the
 * next, and a page that takes it cannot be used without a pointer.
 */
const FLIP_KEY = 'KeyF'
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

export default function App() {
  const initialDoc = useMemo(loadInitialDoc, [])
  const {
    history,
    name,
    song,
    racks,
    trackId,
    setSelected,
    trackRack,
    patch,
    values,
    padInfo,
    enginePrefix,
    setOpenPad,
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
  } = useDocument(initialDoc)
  /** The History list is showing. A view, so not saved with anything. */
  const [historyOpen, setHistoryOpen] = useState(false)
  const toggleHistory = useCallback(() => setHistoryOpen((o) => !o), [])

  // What the benched Keyboard plays, to name the roll's rows and the panel's
  // keys by. Kept by its three numbers, so turning any other knob in the
  // rack leaves the roll and the Keyboard alone.
  // The track's own rack, not a pad open on the bench: the roll names the
  // track's rows.
  const tuningNow = tuningOf(trackRack)
  const tuningKey = tuningNow ? `${tuningNow.source}|${tuningNow.base}|${tuningNow.octave}` : ''
  const tuning = useMemo(
    () => tuningNow,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tuningKey],
  )

  // The engine outlives any single patch; it is rewired, never replaced.
  const engine = useMemo(
    () =>
      new AudioEngine(
        initialDoc.song.tracks.map((t) => ({
          id: t.id,
          patch: initialDoc.racks[t.id].patch,
          values: initialDoc.racks[t.id].values,
        })),
        loadPrefs().audio,
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

  /**
   * What the audio is actually doing, read from the engine rather than
   * guessed from whether a start was asked for: a context can be suspended
   * by the browser, or a worklet can die, long after it first came up.
   */
  const engineStatus = useSyncExternalStore(
    useCallback((fn: () => void) => engine.onStatus(fn), [engine]),
    () => engine.status,
  )
  const running = engineStatus.state === 'running'
  /** Which failure the card is showing, so dismissing one does not hide the next. */
  const [audioDismissed, setAudioDismissed] = useState<EngineStatus | null>(null)
  /**
   * The message in the card, and whether the whole of a long one is showing.
   * Set with a plain string for news, or through `warn` and `progress` for a
   * message that has to stay up (see ui/notice.ts).
   */
  const [noticeInput, setNotice] = useState<NoticeInput | null>(null)
  const notice = noticeInput === null ? null : asNotice(noticeInput)
  const [noticeOpen, setNoticeOpen] = useState(false)
  /** One bounce or save at a time; `busy` says which, for greying the menu. */
  const { busy, run: runJob } = useJob(setNotice)

  // A rebuilt worklet starts its sample clock again at 0, so a schedule
  // written against the old one would land nowhere. Stop, and let the next
  // Play begin from a clean cursor.
  useEffect(() => {
    if (engineStatus.state === 'failed') transport.stop()
  }, [engineStatus, transport])

  /**
   * A notice that stays until it is dismissed: the autosave has failed, and
   * the work on screen is not being kept. 'dismissed' until the next save
   * succeeds, so the same failure is said once rather than every 400 ms,
   * and a later one after a recovery is said again.
   */
  const [autosave, setAutosave] = useState<'ok' | 'failed' | 'dismissed'>('ok')

  const [appearance, setAppearance] = useAppearanceState()

  /**
   * Stable across renders that do not change the rack, so the drag hook and
   * the geometry pass below can both take it as a dependency.
   */
  const moduleIds = useMemo(() => patch.modules.map((m) => m.id), [patch])

  const [flipped, setFlipped] = useState(false)
  const [turning, setTurning] = useState(false)
  const [geometry, setGeometry] = useState<JackGeometry>({})
  const [hoveredCable, setHoveredCable] = useState<string | undefined>()
  /**
   * The rack stands down while a menu is open. Without it, arrowing down a
   * menu would scroll the page and a bound key would play the instrument.
   */
  const [menuOpen, setMenuOpen] = useState(false)
  const [audioOpen, setAudioOpen] = useState(false)
  /** True while the patch library is up, which takes the keyboard with it. */
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [LibraryDialog, setLibraryDialog] = useState<LibraryDialogType | null>(null)
  const openLibrary = useCallback(() => {
    setLibraryOpen(true)
    loadLibrary().then(
      (dialog) => setLibraryDialog(() => dialog),
      () => {
        setLibraryOpen(false)
        setNotice(warn('Could not load the library -- check the connection and try again'))
      },
    )
  }, [])
  /**
   * The module search, when it is up: for adding a module, or, carrying the
   * loose end of a cable let go of over empty rack, for finishing that cable.
   */
  const [search, setSearch] = useState<{ cable?: DragState } | null>(null)
  /** Units picked by a click on their ear, for Ctrl+C. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  // What is picked belongs to the rack it was picked in.
  useEffect(() => setPicked(new Set()), [trackId, enginePrefix])
  /** Whether a paste has anything to paste, for the Edit menu. */
  const [hasClip, setHasClip] = useState(moduleClip !== null)
  /**
   * Whether resting the pointer on a knob explains it. On to begin with, for
   * everyone learning the rack; off for anyone who knows it and would rather
   * the cards stayed out of the way. Remembered either way.
   */
  const [knobHelp, setKnobHelp] = useState(() => loadPrefs().knobHelp ?? true)
  const [showSwing, setShowSwing] = useState(() => loadPrefs().showSwing ?? true)
  /** Smaller units, to see more of a long rack at once. */
  const [compact, setCompact] = useState(() => loadPrefs().compact ?? false)
  /** How cables without a colour of their own are coloured. */
  const [cableColors, setCableColors] = useState<'signal' | 'module'>(
    () => loadPrefs().cableColors ?? 'signal',
  )
  /** Matches the width at which the rack itself drops to a single column. */
  const [narrow, setNarrow] = useState(false)
  const [dock, setDock] = useState(() => loadDock() ?? { open: false, height: 300 })
  /** The dock as drawn: its saved height, within what this window allows. */
  const dockMax = useDockMax()
  const dockHeight = dockHeightWithin(dock.height, dockMax)
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
  const jackEls = useRef(new Map<string, HTMLElement>())

  useEffect(() => {
    const q = window.matchMedia('(max-width: 760px)')
    const sync = () => setNarrow(q.matches)
    sync()
    q.addEventListener('change', sync)
    return () => q.removeEventListener('change', sync)
  }, [])

  /**
   * Fetch the audio the patch names, and hand it to the rack.
   *
   * Keyed on the ids rather than on the patch, so moving a cable does not go
   * back to storage. Anything not found is remembered as missing by the
   * library, which is what a panel shows when a patch arrives from somebody
   * else.
   */
  // Inside a Drum Kit's pads as well as on the rack's own modules.
  const wanted = [...sampleIdsIn(trackRack.patch.modules)].sort().join(',')

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

  /**
   * Let go of audio nothing refers to any more, once, as the page opens.
   *
   * What counts as referred to is everything the browser keeps -- the
   * autosave, the shelf, the presets -- plus the racks this session opened
   * with. If any of that cannot be read the answer is null and nothing is
   * removed: a sample kept by mistake costs some disk, one removed by mistake
   * is gone. The store also spares anything added in the last hour, so a
   * sample dropped in another tab a moment ago is not swept up here.
   */
  useEffect(() => {
    const keep = sampleIdsInLocalStorage()
    if (!keep) return
    sampleIdsIn(initialDoc.racks, keep)
    void pruneSamples(keep).catch(() => {})
  }, [initialDoc])

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
        setNotice(warn(`${file.name} is not audio this browser can read`))
      }
    },
    [editPatch, engine, samples],
  )

  // --- Drum Kit pads ------------------------------------------------------

  /**
   * A pad loaded with a copy of a library instrument, or emptied. The library
   * is fetched on the way, since the page starts without it. A pad keeps the
   * note it was on; an empty one takes the note the standard kit has there.
   */
  const onKitLoad = useCallback(
    async (id: string, slot: number, instrument: string | null) => {
      if (instrument === null) {
        editPatch((p) => setKitSlot(p, id, slot, null))
        return
      }
      const { INSTRUMENTS } = await import('./patch/instruments')
      const inst = INSTRUMENTS.find((x) => x.id === instrument)
      if (!inst) return
      const built = inst.make()
      editPatch((p) => {
        const kit = p.modules.find((m) => m.id === id)
        const note = (kit && kitSlots(kit)[slot]?.note) ?? DEFAULT_KIT[slot]?.note ?? 36 + slot
        return setKitSlot(p, id, slot, { name: inst.name, note, patch: padPatch(built.patch, built.values) })
      })
    },
    [editPatch],
  )

  /**
   * Every pad loaded with the standard kit, and the hats put in a choke
   * group, as one step of undo: the pads are the patch and the groups are
   * knobs, so both go in the one edit of the rack.
   */
  const onKitStandard = useCallback(
    async (id: string) => {
      const { INSTRUMENTS } = await import('./patch/instruments')
      editRack((r) => {
        let patch = r.patch
        const values = { ...r.values }
        DEFAULT_KIT.forEach((pad, i) => {
          const inst = INSTRUMENTS.find((x) => x.id === pad.instrument)
          if (!inst) return
          const built = inst.make()
          patch = setKitSlot(patch, id, i, { name: inst.name, note: pad.note, patch: padPatch(built.patch, built.values) })
          values[`${id}.choke${i + 1}`] = pad.choke ?? 0
        })
        return patch === r.patch ? r : { patch, values }
      })
    },
    [editRack],
  )

  /** A pad sounded on the bench while it is held, through the same routing a note from the roll takes. */
  const onKitAudition = useCallback(
    (id: string, slot: number, on: boolean) => {
      const kit = patch.modules.find((m) => m.id === id)
      const pad = kit ? kitSlots(kit)[slot] : null
      if (!kit || !pad) return
      const events = engineEvents(
        [{ frame: 0, track: trackId, kind: on ? 'on' : 'off', pitch: kitRow(pad.note), velocity: on ? 0.9 : 0 }],
        kitTarget(kit),
      ).map((e) => ({ ...e, track: trackId }))
      void engine.start().then(() => engine.schedule(events))
    },
    [engine, patch, trackId],
  )

  const onReorder = useCallback(
    (ids: string[]) => editPatch((p) => reorderModules(p, ids)),
    [editPatch],
  )

  // Dragging a unit by its spine. The rack reorders under the pointer while
  // the patch stays put, and one edit lands when the drag is let go.
  const rack = useRackDrag(moduleIds, rackRef, onReorder)

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
  }, [commitDoc, song, setSelected])

  /**
   * Take a track out, rack and all. No confirm: it undoes like any other
   * edit, and the notice says so -- which is what makes a single click on
   * an × safe to offer.
   */
  const onRemoveTrack = useCallback(
    (id: string) => {
      const gone = song.tracks.find((t) => t.id === id)
      if (!gone || song.tracks.length <= 1) return
      commitDoc((doc) => {
        const song = removeTrack(doc.song, id)
        if (song === doc.song) return doc
        const racks = { ...doc.racks }
        delete racks[id]
        return { ...doc, song, racks }
      })
      setNotice(`Removed ${gone.name || 'the track'} -- Ctrl+Z to undo`)
    },
    [commitDoc, song.tracks],
  )

  /** A pattern and every placement of it, likewise undoable and said so. */
  const onRemovePattern = useCallback(
    (id: string) => {
      const gone = song.patterns.find((p) => p.id === id)
      if (!gone || song.patterns.length <= 1) return
      editSong((s) => removePattern(s, id))
      setNotice(`Removed ${gone.name || 'the pattern'} -- Ctrl+Z to undo`)
    },
    [editSong, song.patterns],
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
    [editSong, song, setPatternId],
  )

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
   * The section the playlist is looping, by its marker's tick, or null for
   * the whole song. Chosen by clicking a marker; only the playlist plays it.
   */
  const [section, setSection] = useState<number | null>(null)
  const sectionSpan = useMemo(
    () => (dockView !== 'roll' && section !== null ? sectionAt(song, section) : null),
    [dockView, section, song],
  )
  /**
   * What the transport plays.
   *
   * The roll loops the pattern being written, on its own; the playlist plays
   * the arrangement. Derived as a song either way, so there is one code path
   * rather than a mode inside the transport.
   */
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
   * Worked out whenever a rack changes, because adding a Keyboard to one that
   * had none is exactly the moment the roll should start working -- but only
   * a new answer makes a new map. A knob turn replaces the racks too, and a
   * map rebuilt for it would redraw the whole dock for nothing.
   */
  const targetList = song.tracks.flatMap((track) => {
    const rack = racks[track.id]
    const target = rack && noteTarget(rack.patch)
    return target ? [[track.id, target] as const] : []
  })
  // A kit's pads are part of what it says: a pad loaded, emptied or moved to
  // another note changes where the roll's notes go.
  const targetKey = targetList
    .map(([id, t]) => `${id}:${t.kind}:${t.module}${t.pads ? `:${[...t.pads].map(([row, hits]) => `${row}=${hits.map((h) => h.module).join('+')}`).join(',')}` : ''}`)
    .join('|')
  const targets = useMemo(
    () => new Map<string, NoteTarget>(targetList),
    // `targetList` is rebuilt every render; `targetKey` is what it says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetKey],
  )

  useEffect(() => {
    transport.setTargets(targets)
  }, [transport, targets])

  /**
   * The autosave waiting to be written, if one is. Held so that leaving the
   * page can write it at once: debounced alone, the last 400 ms of work before
   * a tab was closed never reached storage.
   */
  const pendingSave = useRef<(() => void) | null>(null)

  useEffect(() => {
    const save = () => {
      pendingSave.current = null
      const ok = saveLocalProject(toStoredProject(name, song, racks))
      setAutosave((was) => (ok ? 'ok' : was === 'ok' ? 'failed' : was))
    }
    pendingSave.current = save
    const t = setTimeout(save, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [name, song, racks])

  // `pagehide` is the one a browser reliably fires on the way out, including
  // into the back-forward cache; a tab going to the background is the other
  // moment a page may never come back from, on a phone especially.
  useEffect(() => {
    const flush = () => pendingSave.current?.()
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => saveDock(dock), AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [dock])

  // Only news fades. A failure stays until it is dismissed, and a job's
  // progress until the job says something else.
  useEffect(() => {
    setNoticeOpen(false)
    if (!noticeInput || asNotice(noticeInput).kind !== 'info') return
    const t = setTimeout(() => setNotice(null), NOTICE_FADE_MS)
    return () => clearTimeout(t)
  }, [noticeInput])

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

  /**
   * Put a whole different rack on the bench.
   *
   * `preset` is sparse and optional: a patch from a file carries its knobs in
   * its modules, but a template carries them separately, so anything it does
   * not mention is left wherever the module's own default puts it.
   */
  const applyPatch = useCallback(
    (next: Patch, trackName: string, preset?: Record<string, number>) => {
      breakCoalesce()
      const values = preset ? { ...initialValues(next), ...preset } : initialValues(next)
      // With a pad open, the patch goes into the pad, which takes its name;
      // the track, its name and the rest of its kit stay as they are.
      if (padInfo) {
        const at = padInfo
        commitDoc((doc) => {
          const rack = doc.racks[trackId]
          if (!rack) return doc
          return { ...doc, racks: { ...doc.racks, [trackId]: withPadView(rack, at.kit, at.slot, { patch: next, values }, trackName) } }
        }, undefined, `Load ${trackName} · pad ${at.slot + 1}`)
        return
      }
      commitDoc((doc) => ({
        ...doc,
        // The rack changes; the arrangement does not. A track's name is the
        // name of the sound on it, so loading one onto a track renames that
        // track and leaves every note where it was.
        song: updateTrack(doc.song, trackId, { name: trackName }),
        racks: { ...doc.racks, [trackId]: { patch: next, values } },
      }), undefined, `Load ${trackName}`)
    },
    [commitDoc, breakCoalesce, trackId, padInfo],
  )

  const files = useProjectFiles({
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
    runJob,
  })
  const bounce = useBounce({ song, racks, name, samples, transport, setNotice, runJob })
  /** The bounce sheet, open on the whole mix or a kind of stems. */
  const [bounceOpen, setBounceOpen] = useState<'song' | StemMix | null>(null)
  const { recorder } = useTakes({ engine, samples, trackId, patchName, patch, values, setNotice })
  /**
   * Notes played by hand, as they are played, for the roll to record. The
   * Keyboard panel, a Trigger and a MIDI controller all report here.
   */
  const liveNotes = useMemo(() => new LiveNotes(), [])
  /** The key a Keyboard press is about to open the gate for; see `gate`. */
  const pressedKey = useRef<number | null>(null)
  /** What the panel is holding, to say which note let go. */
  const heldPanel = useRef<{ track: string; pitch: number } | null>(null)
  const triggers = useTriggers(engine, trackId, patch, values, (moduleId, open) => {
    // Only the module the track's notes are played on is a note: the rest of
    // a rack's Triggers fire things inside the patch -- and so does every
    // Trigger in a pad open on the bench.
    const target = targets.get(trackId)
    if (enginePrefix || !target || target.module !== moduleId) return
    if (open) {
      const pitch = target.kind === 'note' ? (pressedKey.current ?? Math.round(values[`${moduleId}.note`] ?? 0)) : 0
      pressedKey.current = null
      heldPanel.current = { track: trackId, pitch }
      liveNotes.emit({ kind: 'on', track: trackId, pitch, velocity: 1, source: 'panel' })
    } else if (heldPanel.current) {
      liveNotes.emit({ kind: 'off', ...heldPanel.current, velocity: 0, source: 'panel' })
      heldPanel.current = null
    }
  }, enginePrefix)

  /**
   * MIDI controllers, when switched on from the Edit menu. A key plays the
   * row named for the note it is, on the track on the bench -- so C4 on the
   * controller is the C4 you hear whatever the patch is tuned to.
   */
  const [midiOn, setMidiOn] = useState(() => loadPrefs().midi === true)
  const midiHeld = useRef(new Map<number, { track: string; pitch: number }>())
  const midi = useMidiInput(midiOn, (m) => {
    if (m.kind === 'on') {
      const pitch = rowForMidi(m.note, tuning)
      midiHeld.current.set(m.note, { track: trackId, pitch })
      transport.preview(trackId, pitch, m.velocity)
      liveNotes.emit({ kind: 'on', track: trackId, pitch, velocity: Math.round(m.velocity * 100) / 100, source: 'midi' })
      return
    }
    const held = midiHeld.current.get(m.note)
    if (!held) return
    midiHeld.current.delete(m.note)
    transport.release(held.track, held.pitch)
    liveNotes.emit({ kind: 'off', ...held, velocity: 0, source: 'midi' })
  })
  // Said once, when it changes: which controllers were found, or why not.
  useEffect(() => {
    if (midi.state === 'ready') {
      setNotice(
        midi.devices.length
          ? `MIDI: listening to ${midi.devices.join(', ')}`
          : 'MIDI is on, but no controller is connected -- plug one in and it is picked up',
      )
    } else if (midi.state === 'unsupported') {
      setNotice(warn('This browser has no MIDI: try Chrome or Edge'))
    } else if (midi.state === 'denied') {
      setNotice(warn(`MIDI was not allowed: ${midi.error}`))
    }
  }, [midi])

  /**
   * No confirmation step any more. It used to be a button on the bar, where a
   * stray click could land on it; reaching it now means opening a menu and
   * choosing it. And `applyPatch` commits through the history like any other
   * edit, so the way back is the way back from everything else.
   */
  const onNew = useCallback(() => {
    breakCoalesce()
    files.forgetHandle()
    const patch = defaultPatch()
    const song = benchSong()
    commitDoc(() => ({
      name: 'Untitled',
      song,
      racks: { [BENCH_TRACK]: { patch, values: initialValues(patch) } },
    }), undefined, 'New project')
    setSelected(BENCH_TRACK)
    setPatternId(song.patterns[0].id)
    setNotice('Started a new project -- Ctrl+Z to undo')
  }, [commitDoc, breakCoalesce, files, setSelected, setPatternId])

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
      setNotice(warn('Could not save to the library: this browser is not letting the page store anything'))
      return null
    }
    setNotice(saved.updated ? `Updated ${name} in My patches` : `Saved ${name} to My patches`)
    return name
  }, [song.tracks, trackId, patch, values])

  /** Show or hide the music dock, from the View menu or Ctrl+M. */
  const toggleDock = useCallback(() => setDock((d) => ({ ...d, open: !d.open })), [])
  const setDockOpen = useCallback((open: boolean) => setDock((d) => ({ ...d, open })), [])
  const setDockHeight = useCallback((height: number) => setDock((d) => ({ ...d, height })), [])

  // --- cables --------------------------------------------------------
  const cables = useCableDrag({
    rackRef,
    patch,
    geometry,
    editPatch,
    onDropLoose: (cable) => setSearch({ cable }),
  })

  const occupied = useMemo(() => {
    const s = new Set<string>()
    for (const c of patch.cables) {
      s.add(jackKey(c.from))
      s.add(jackKey(c.to))
    }
    return s
  }, [patch])

  const isOccupied = useCallback((ref: PortRef) => occupied.has(jackKey(ref)), [occupied])

  // Cables are hit-tested here rather than through SVG hit areas, so that a
  // jack a cable happens to cross stays usable. The jack gets first refusal.
  const onRackPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!flipped || cables.dragRef.current || rack.id) return
      if (e.target instanceof Element && e.target.closest(PANEL_CONTROLS)) return
      const hit = nearestCable(patch, geometry, cables.cursorIn(e))
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
    [flipped, cables, rack.id, patch, geometry, editPatch],
  )

  const onRackPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!flipped || cables.dragRef.current || rack.id) {
        setHoveredCable(undefined)
        return
      }
      if (e.target instanceof Element && e.target.closest(PANEL_CONTROLS)) {
        setHoveredCable(undefined)
        return
      }
      setHoveredCable(nearestCable(patch, geometry, cables.cursorIn(e))?.id)
    },
    [flipped, cables, rack.id, patch, geometry],
  )

  // --- input ---------------------------------------------------------
  // All browser input is captured in one place: without it a held key
  // auto-repeats past the handler and scrolls the page, and right-click opens
  // the browser menu over the rack.
  //
  // The rack's own shortcuts come last so they win a collision. A cap refuses
  // to take one of them in the first place, so this is only a backstop -- for
  // a patch file that named Tab before that rule existed, say.
  //
  // Except the flip, which comes first and so loses one. It is a bare F, and
  // F is a perfectly good key to play a Trigger from; a rack whose Trigger
  // is on F plays it, and turns round from the button or the View menu. The
  // flip used to be Tab, which is the browser's key for moving between
  // controls and is nobody's to take.
  useInput({
    // A cap waiting for a key needs the keyboard to itself, or the key being
    // assigned would fire whatever it is already bound to on the way past.
    suspended:
      menuOpen || libraryOpen || audioOpen || bounceOpen !== null || search !== null || triggers.listening !== null,
    bindings: [
      { code: FLIP_KEY, onDown: flip },
      ...triggers.triggerKeys,
      { code: 'KeyK', ctrl: true, onDown: () => setSearch({}) },
      { code: 'KeyM', ctrl: true, onDown: toggleDock },
      // Taken from the browser, whose own Save would write out the page.
      { code: 'KeyS', ctrl: true, onDown: () => void files.saveProject() },
      { code: 'KeyS', ctrl: true, shift: true, onDown: () => void files.saveProject(true) },
      { code: 'KeyO', ctrl: true, onDown: () => void files.pickProject() },
      // The rack's copy and paste stand aside while the roll or the playlist
      // has the keyboard: there, the same keys copy notes, or bars.
      { code: 'KeyC', ctrl: true, onDown: () => rackHasKeys() && copyPicked() },
      { code: 'KeyV', ctrl: true, onDown: () => rackHasKeys() && pasteClip() },
      {
        code: 'Escape',
        onDown: () => {
          // A cable picked up from the keyboard is put down before anything
          // else Escape might mean.
          if (cables.putDownKeyboard()) return
          if (rackHasKeys()) setPicked(new Set())
        },
      },
      { code: 'KeyZ', ctrl: true, onDown: stepBack },
      { code: 'KeyZ', ctrl: true, shift: true, onDown: stepForward },
      { code: 'KeyY', ctrl: true, onDown: stepForward },
      // Taken from the browser, whose own Ctrl+H opens its page history.
      { code: 'KeyH', ctrl: true, onDown: toggleHistory },
    ],
  })

  // --- the units -----------------------------------------------------
  /**
   * What the units ask of the rack, as one object that never changes. Each
   * handler runs the newest version of itself, so the units can be memoized
   * without any of them acting on a patch that has since moved on.
   */
  const rackActions = useStableActions<RackActions>({
    grab: (id, e) => {
      // Shift+click on an ear adds the unit to what is picked or takes it
      // out, and moves nothing. A plain press picks it alone and is also the
      // start of a drag, as it always was.
      if (e.shiftKey) {
        e.preventDefault()
        setPicked((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        return
      }
      // Taking hold of one of several picked units takes hold of them all,
      // and they move as one block. Any other unit is picked alone and moves
      // alone.
      if (picked.has(id) && picked.size > 1) {
        rack.start(id, e, [...picked])
        return
      }
      if (e.button === 0) setPicked(new Set([id]))
      rack.start(id, e)
    },
    gate: (id, open, ahead) => {
      // The key goes to the recorder with the gate, through `useTriggers`.
      if (open && typeof ahead?.note === 'number') pressedKey.current = ahead.note
      // Sent now rather than with the next render's sync, so they arrive
      // before the gate does: the audio thread takes messages in order. The
      // sync afterwards finds them already sent and sends nothing.
      if (ahead) {
        const values: Record<string, number> = {}
        for (const [param, value] of Object.entries(ahead)) values[`${enginePrefix}${id}.${param}`] = value
        engine.setValues(trackId, values)
      }
      if (open) triggers.gateOn(id)
      else triggers.gateOff(id)
    },
    press: (id) => triggers.press(id),
    release: (id) => triggers.release(id),
    listen: (id, on) => triggers.setListening(on ? id : null),
    assignKey: (id, code) => editPatch((p) => setModuleKey(p, id, code)),
    bypass: (id) => editPatch((p) => toggleBypass(p, id)),
    applyPreset: (id, params) => {
      const m = patch.modules.find((x) => x.id === id)
      if (!m) return
      // One edit, so a preset loaded by mistake is one Ctrl+Z.
      editRack((r) => {
        const next = { ...r.values }
        for (const spec of defOf(m.type).params) {
          const v = params[spec.id]
          if (typeof v === 'number' && Number.isFinite(v)) next[`${id}.${spec.id}`] = v
        }
        return { ...r, values: next }
      })
    },
    setParam: (id, paramId, v) => setParam(id, paramId, v),
    setParams: (id, changes) => setParams(id, changes),
    sample: (id, file) => void onSample(id, file),
    kitLoad: (id, slot, instrument) => void onKitLoad(id, slot, instrument),
    kitPad: (id, slot, change) => editPatch((p) => updateKitSlot(p, id, slot, change)),
    kitStandard: (id) => void onKitStandard(id),
    kitAudition: onKitAudition,
    kitEdit: (id, slot) => {
      setOpenPad({ track: trackId, kit: id, slot })
      // To the top, where the pad's rack starts.
      window.scrollTo({ top: 0 })
    },
    register: registerJack,
    jackDown: (ref, kind, e) => cables.onJackDown(ref, kind, e),
    jackKey: (ref, kind, action) => cables.onJackKey(ref, kind, action),
    move: (id, delta) => editPatch((p) => moveModule(p, id, delta)),
    duplicate: onDuplicateModule,
    remove: (id) => editPatch((p) => removeModule(p, id)),
  })

  /**
   * The render controls live on the recorder's panel. They go to the first
   * recorder in the rack, which is the one the compiler takes the render
   * from, so a rack with a spare recorder does not grow a second set of
   * controls that render something you cannot hear.
   */
  const recorderHost = patch.modules.find((m) => m.type === 'rec')?.id
  /** The rack renders in the drag's order, which is a list of ids. */
  const byId = useMemo(() => new Map(patch.modules.map((m) => [m.id, m])), [patch])
  /** How the half-width units split their rows, in the order they are shown. */
  const shares = useMemo(
    () =>
      rackShares(rack.order, (id) => {
        const m = byId.get(id)
        return m && defOf(m.type)
      }),
    [rack.order, byId],
  )
  const indexEntries = useMemo(
    () =>
      rack.order.flatMap((id) => {
        const m = byId.get(id)
        return m ? [{ id, name: defOf(m.type).name, bypassed: !!m.bypass }] : []
      }),
    [rack.order, byId],
  )

  const menus = buildMenus({
    newProject: onNew,
    openProject: () => void files.pickProject(),
    saveProject: (saveAs) => void files.saveProject(saveAs),
    bounceSong: () => setBounceOpen('song'),
    bounceStems: (mix) => setBounceOpen(mix),
    exportMidi: bounce.exportMidi,
    busy: busy !== null,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undo: stepBack,
    redo: stepForward,
    historyOpen,
    toggleHistory,
    midiOn,
    toggleMidi: () => {
      setMidiOn(!midiOn)
      savePrefs({ midi: !midiOn })
    },
    canCopy: picked.size > 0,
    canPaste: hasClip,
    copy: copyPicked,
    paste: pasteClip,
    openAudioSettings: () => setAudioOpen(true),
    openLibrary,
    openPatch: () => files.pickPatch(false),
    addPatchAsTrack: () => files.pickPatch(true),
    savePatch: () => void files.exportPatch(),
    saveToLibrary: () => void onSaveToLibrary(),
    search: () => setSearch({}),
    addModule: onAddModule,
    hiddenModules: padInfo ? NOT_IN_A_PAD : undefined,
    flipped,
    flip,
    dockOpen: dock.open,
    toggleDock,
    showSwing,
    setShowSwing: (on) => {
      setShowSwing(on)
      savePrefs({ showSwing: on })
    },
    knobHelp,
    setKnobHelp: (on) => {
      setKnobHelp(on)
      savePrefs({ knobHelp: on })
    },
    compact,
    setCompact: (on) => {
      setCompact(on)
      savePrefs({ compact: on })
    },
    cableColors,
    setCableColors: (by) => {
      setCableColors(by)
      savePrefs({ cableColors: by })
    },
    appearance,
    setAppearance,
  })

  /**
   * Scroll a unit into view and pick it, so it is lit when it arrives.
   *
   * With `focus`, the focus goes to the unit as well -- for the Jump menu,
   * which used to blur itself and leave the focus on nothing, so the next
   * Tab started again from the top of the page. On the unit, the next Tab is
   * its first control.
   */
  const jumpTo = useCallback((id: string, focus = false) => {
    const el = document.querySelector<HTMLElement>(`.unit-flip[data-module="${CSS.escape(id)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (focus) el?.focus({ preventScroll: true })
    setPicked(new Set([id]))
  }, [])

  /**
   * Out of the pad and back to the track's rack, at the kit it belongs to:
   * that is where you went in, and where the next pad is picked.
   */
  const backToKit = useRef<string | null>(null)
  const closePad = useCallback(() => {
    backToKit.current = padInfo?.kit ?? null
    setOpenPad(null)
  }, [padInfo, setOpenPad])
  useEffect(() => {
    const kit = backToKit.current
    if (enginePrefix || !kit) return
    backToKit.current = null
    jumpTo(kit)
  }, [enginePrefix, jumpTo])

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

          {files.fileInputs}

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
              if (id) jumpTo(id, true)
            }}
          >
            <option value="">Jump to…</option>
            {indexEntries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id} · {entry.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* The dock is fixed to the bottom of the window, so the rack needs room
          underneath it or the last unit in a long patch cannot be scrolled to. */}
      <div
        className="app"
        style={{ '--dock-h': `${dock.open ? dockHeight + 76 : 44}px` } as React.CSSProperties}
      >

        {/* A card in the bottom corner, just above the dock, not a line in
            the page: it used to sit above the rack and shove every unit down
            by its own height each time it came and went. Lifted clear of the
            dock by its measured height (see noticesRef). The region is always
            there, so a screen reader hears each message arrive. */}
        <div className="notices" ref={noticesRef} role="status" aria-live="polite">
          {/* Stays until dismissed, unlike the notices below it that fade:
              it is the one message that means work is being lost. */}
          {autosave === 'failed' && (
            <div className="notice notice-warn">
              <span className="notice-text">
                Autosave failed — storage is full; save the project to a file
              </span>
              <button
                className="notice-close"
                onClick={() => setAutosave('dismissed')}
                aria-label="Dismiss"
                title="Dismiss"
                type="button"
              >
                ×
              </button>
            </div>
          )}
          {/* Also kept up until dismissed: with the audio stopped, nothing
              on the rack makes a sound and nothing else says why. The button
              is the user gesture a browser wants before it lets audio out. */}
          {(engineStatus.state === 'failed' || engineStatus.state === 'suspended') &&
            audioDismissed !== engineStatus && (
              <div className="notice notice-warn">
                <span className="notice-text">
                  {engineStatus.state === 'failed'
                    ? `Audio stopped${engineStatus.error ? `: ${engineStatus.error}` : ''}`
                    : 'Audio is paused by the browser'}
                </span>
                <button className="notice-action" onClick={() => void engine.start()} type="button">
                  {engineStatus.state === 'failed' ? 'Retry' : 'Resume'}
                </button>
                <button
                  className="notice-close"
                  onClick={() => setAudioDismissed(engineStatus)}
                  aria-label="Dismiss"
                  title="Dismiss"
                  type="button"
                >
                  ×
                </button>
              </div>
            )}
          {notice && (
            <div className={`notice${notice.kind === 'warn' ? ' notice-warn' : ''}`}>
              <span className="notice-text">
                {notice.text}
                {notice.details && (
                  <>
                    {' '}
                    <button
                      className="notice-more"
                      type="button"
                      aria-expanded={noticeOpen}
                      onClick={() => setNoticeOpen((o) => !o)}
                    >
                      {noticeOpen ? 'less' : `+${notice.details.length} more`}
                    </button>
                    {noticeOpen && (
                      <ul className="notice-details">
                        {notice.details.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </span>
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

        {libraryOpen && LibraryDialog && (
          <LibraryDialog onPick={onPickTemplate} onClose={() => setLibraryOpen(false)} onSave={onSaveToLibrary} />
        )}

        {audioOpen && (
          <AudioSettingsDialog
            engine={engine}
            transport={transport}
            status={engineStatus}
            onClose={() => setAudioOpen(false)}
          />
        )}

        {bounceOpen && (
          <BounceDialog
            what={bounceOpen}
            onClose={() => setBounceOpen(null)}
            onBounce={(settings) => {
              const what = bounceOpen
              setBounceOpen(null)
              if (what === 'song') void bounce.bounceSong(settings)
              else void bounce.bounceStems(what, settings)
            }}
          />
        )}

        {historyOpen && (
          <HistoryPanel {...steps(history)} onJump={goToStep} onClose={() => setHistoryOpen(false)} />
        )}

        {search && (
          <ModuleSearch
            exclude={padInfo ? NOT_IN_A_PAD : undefined}
            cable={search.cable?.anchorKind}
            onPick={onSearchPick}
            onClose={() => setSearch(null)}
          />
        )}

        <RackIndex
          tracks={song.tracks}
          trackId={trackId}
          onSelectTrack={setSelected}
          entries={indexEntries}
          picked={picked}
          onJump={jumpTo}
          flipped={flipped}
          onFlip={flip}
          pad={padInfo}
          onClosePad={closePad}
        />

        {/* Panels that show live audio, such as the scope, take the engine from
            here rather than being handed it down through every rack unit. The
            appearance rides along for the same reason: a canvas cannot read the
            stylesheet, so the scope has to be told when the palette changed. */}
        {/* Over the rack while a pad is open: whose rack this is, and the way
            back. The index card says the same where the window has room for
            it; this is always there. */}
        {padInfo && (
          <nav className="pad-crumb" aria-label="Editing a pad">
            <button className="pad-crumb-link" onClick={closePad} type="button" title="Back to the track's rack">
              {patchName || 'Untitled'}
            </button>
            <span className="pad-crumb-sep" aria-hidden="true">›</span>
            <span className="pad-crumb-kit">
              Drum Kit <code>{padInfo.kit}</code>
            </span>
            <span className="pad-crumb-sep" aria-hidden="true">›</span>
            <span className="pad-crumb-pad">
              Pad {padInfo.slot + 1} · {padInfo.name}
            </span>
            <span className="pad-crumb-note">
              a sub-patch, played on {midiName(padInfo.note)} with the rest of the kit
            </span>
            <button className="pad-crumb-back" onClick={closePad} type="button">
              ← Back to kit
            </button>
          </nav>
        )}

        <KnobHelpCard />
        <KnobHelpOn.Provider value={knobHelp}>
        <ThemeContext.Provider value={appearance}>
          <EngineContext.Provider value={engine}>
          <EnginePrefix.Provider value={enginePrefix}>
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
                <UnitBoundary key={m.id} moduleId={m.id} onRemove={() => rackActions.remove(m.id)}>
                  <RackUnit
                    def={defOf(m.type)}
                    module={m}
                    values={values}
                    flipped={flipped}
                    share={shares.get(m.id)}
                    dragging={rack.group.includes(m.id)}
                    selected={picked.has(m.id)}
                    latched={triggers.latched.has(m.id)}
                    listening={triggers.listening === m.id}
                    recorder={m.id === recorderHost ? recorder : undefined}
                    isOccupied={isOccupied}
                    isCandidate={cables.isCandidate}
                    actions={rackActions}
                    tuning={defOf(m.type).playable ? tuning?.base : undefined}
                  />
                </UnitBoundary>
              ))}

              {flipped && !turning && (
                <Cables
                  patch={patch}
                  geometry={geometry}
                  drag={search?.cable ?? cables.drag}
                  cursor={cables.cursor}
                  hovered={hoveredCable}
                  colorBy={cableColors}
                />
              )}
            </div>
          </SampleContext.Provider>
          </EnginePrefix.Provider>
          </EngineContext.Provider>
        </ThemeContext.Provider>
        </KnobHelpOn.Provider>

        {/* The roll. Outside the rack for the same reason the ghost below is:
            the rack sets a perspective, and a perspective is a containing block,
            so a fixed element inside one is positioned against the rack rather
            than against the window. */}
        <ThemeContext.Provider value={appearance}>
          <SongDock
            transport={transport}
            live={liveNotes}
            projectName={name}
            onProjectName={setProjectName}
            song={song}
            onNotes={setNotes}
            trackId={trackId}
            onSelectTrack={setSelected}
            onAddTrack={onAddTrack}
            onRemoveTrack={onRemoveTrack}
            onTrack={onTrack}
            patternId={activePattern}
            onSelectPattern={setPatternId}
            onAddPattern={onAddPattern}
            onRemovePattern={onRemovePattern}
            targets={targets}
            tuning={tuning}
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
            onOpenChange={setDockOpen}
            height={dockHeight}
            onHeight={setDockHeight}
            showSwing={showSwing}
          />
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
 * Whether a rack shortcut should act, rather than the dock's: the roll takes
 * the same keys for notes while it has the keyboard, and the playlist takes
 * copy and paste for bars.
 */
function rackHasKeys() {
  const active = document.activeElement
  return !(active instanceof Element && active.closest('.roll, .playlist'))
}
