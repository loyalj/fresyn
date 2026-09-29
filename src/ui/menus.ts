import type { StemMix } from '../audio/renderSong'
import { MODULE_GROUPS, modulesByGroup } from '../patch/defs'
import type { MenuDef } from './Menu'
import { THEMES, type Appearance } from './theme'

/** Everything the menu bar reads or does, gathered by the app. */
export interface MenuContext {
  newProject: () => void
  openProject: () => void
  saveProject: (saveAs?: boolean) => void
  bounceSong: () => void
  bounceStems: (mix: StemMix) => void
  /** A bounce or a save is running, and another would compete with it. */
  busy: boolean
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
  canCopy: boolean
  canPaste: boolean
  copy: () => void
  paste: () => void
  openAudioSettings: () => void
  openLibrary: () => void
  openPatch: () => void
  addPatchAsTrack: () => void
  savePatch: () => void
  saveToLibrary: () => void
  search: () => void
  addModule: (type: string) => void
  flipped: boolean
  flip: () => void
  dockOpen: boolean
  toggleDock: () => void
  knobHelp: boolean
  showSwing: boolean
  setShowSwing: (on: boolean) => void
  setKnobHelp: (on: boolean) => void
  compact: boolean
  setCompact: (on: boolean) => void
  cableColors: 'signal' | 'module'
  setCableColors: (by: 'signal' | 'module') => void
  appearance: Appearance
  setAppearance: (next: Appearance) => void
}

/** The menu bar, built from the app's state as it stands. */
export function buildMenus(ctx: MenuContext): MenuDef[] {
  return [
    {
      // The whole piece: every track, the patch on each, the notes, the
      // arrangement, and the audio the Samplers play.
      label: 'Project',
      items: [
        { kind: 'action', label: 'New project', onSelect: ctx.newProject },
        { kind: 'action', label: 'Open project...', shortcut: 'Ctrl+O', onSelect: ctx.openProject },
        { kind: 'action', label: 'Save project', shortcut: 'Ctrl+S', disabled: ctx.busy, onSelect: () => ctx.saveProject() },
        { kind: 'action', label: 'Save project as...', shortcut: 'Ctrl+Shift+S', disabled: ctx.busy, onSelect: () => ctx.saveProject(true) },
        { kind: 'separator' },
        // The piece as audio. The project above is the piece as something you
        // can still change your mind about.
        { kind: 'action', label: 'Bounce song...', disabled: ctx.busy, onSelect: ctx.bounceSong },
        {
          kind: 'submenu',
          label: 'Bounce stems',
          // What each stem carries of its channel. Never the master bus: see
          // `StemMix`.
          items: [
            { kind: 'action', label: 'Channel only (EQ, pan, fader)...', disabled: ctx.busy, onSelect: () => ctx.bounceStems('channel') },
            { kind: 'action', label: 'Channel and sends (with reverb, delay)...', disabled: ctx.busy, onSelect: () => ctx.bounceStems('sends') },
            { kind: 'action', label: 'Raw rack output...', disabled: ctx.busy, onSelect: () => ctx.bounceStems('raw') },
          ],
        },
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          kind: 'action', label: 'Undo', shortcut: 'Ctrl+Z',
          disabled: !ctx.canUndo, onSelect: ctx.undo,
        },
        {
          kind: 'action', label: 'Redo', shortcut: 'Ctrl+Shift+Z',
          disabled: !ctx.canRedo, onSelect: ctx.redo,
        },
        { kind: 'separator' },
        {
          kind: 'action', label: 'Copy modules', shortcut: 'Ctrl+C',
          disabled: !ctx.canCopy, onSelect: ctx.copy,
        },
        {
          kind: 'action', label: 'Paste modules', shortcut: 'Ctrl+V',
          disabled: !ctx.canPaste, onSelect: ctx.paste,
        },
        { kind: 'separator' },
        // Where preferences live in most programs. It is this machine's sound
        // card, so it belongs to no project.
        { kind: 'action', label: 'Audio settings...', onSelect: ctx.openAudioSettings },
      ],
    },
    {
      // One sound: the rack on the selected track and any audio it plays.
      // What you send somebody when you mean "here is a sound" rather than
      // "here is the piece", and what carries a sound from one project into
      // the next. No notes travel with it.
      label: 'Patch',
      items: [
        { kind: 'action', label: 'Library...', onSelect: ctx.openLibrary },
        { kind: 'separator' },
        { kind: 'action', label: 'Open patch...', onSelect: ctx.openPatch },
        { kind: 'action', label: 'Add patch as track...', onSelect: ctx.addPatchAsTrack },
        { kind: 'action', label: 'Download patch...', onSelect: ctx.savePatch },
        { kind: 'action', label: 'Save to library', onSelect: ctx.saveToLibrary },
      ],
    },
    {
      label: 'Modules',
      // Grouped from the catalogue itself, so a new module appears here
      // without this file knowing anything about it.
      items: [
        { kind: 'action' as const, label: 'Search...', shortcut: 'Ctrl+K', onSelect: ctx.search },
        { kind: 'separator' as const },
        ...MODULE_GROUPS.map((g) => ({
          kind: 'submenu' as const,
          label: g.name,
          items: modulesByGroup(g.id).map((def) => ({
            kind: 'action' as const,
            label: def.name,
            onSelect: () => ctx.addModule(def.type),
          })),
        })),
      ],
    },
    {
      label: 'View',
      items: [
        { kind: 'toggle', label: 'Back panel', shortcut: 'F', checked: ctx.flipped, onSelect: ctx.flip },
        // Beside the rack's flip, because the dock is the other half of the
        // room: the button on the dock's bar does the same thing.
        { kind: 'toggle', label: 'Music', shortcut: 'Ctrl+M', checked: ctx.dockOpen, onSelect: ctx.toggleDock },
        // Off, the roll shows the grid a swung pattern was written on --
        // easier for some to edit against than a grid that lopes.
        {
          kind: 'toggle',
          label: 'Show swing in the roll',
          checked: ctx.showSwing,
          onSelect: () => ctx.setShowSwing(!ctx.showSwing),
        },
        {
          kind: 'toggle',
          label: 'Knob help',
          checked: ctx.knobHelp,
          onSelect: () => ctx.setKnobHelp(!ctx.knobHelp),
        },
        {
          kind: 'toggle',
          label: 'Compact rack',
          checked: ctx.compact,
          onSelect: () => ctx.setCompact(!ctx.compact),
        },
        {
          kind: 'submenu',
          label: 'Cable colours',
          items: (['signal', 'module'] as const).map((by) => ({
            kind: 'toggle' as const,
            label: by === 'signal' ? 'By signal' : 'By module',
            checked: ctx.cableColors === by,
            onSelect: () => ctx.setCableColors(by),
          })),
        },
        { kind: 'separator' },
        {
          kind: 'submenu',
          label: 'Theme',
          items: THEMES.map((t) => ({
            kind: 'toggle' as const,
            label: t.name,
            checked: ctx.appearance.theme === t.id,
            onSelect: () => ctx.setAppearance({ ...ctx.appearance, theme: t.id }),
          })),
        },
        {
          kind: 'submenu',
          label: 'Appearance',
          items: (['dark', 'light'] as const).map((m) => ({
            kind: 'toggle' as const,
            label: m === 'dark' ? 'Dark' : 'Light',
            checked: ctx.appearance.mode === m,
            onSelect: () => ctx.setAppearance({ ...ctx.appearance, mode: m }),
          })),
        },
      ],
    },
  ]
}
