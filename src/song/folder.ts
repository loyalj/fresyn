import type { Folder, Song, Track } from './types'

/**
 * Folders of tracks, and who is heard once they are counted.
 *
 * A folder is a group as well as a tidy: its mute and solo reach every track
 * filed in it, and its level scales theirs. That makes "is this track heard"
 * and "how loud is it" questions about the folder too, so they are answered
 * here, once, for the scheduler and the desk alike -- the two used to work
 * out solo each for themselves, and two copies of a rule are two chances for
 * the bounce to disagree with what was heard.
 */

export function folderOf(song: Song, track: Track): Folder | undefined {
  return track.folder === undefined ? undefined : song.folders?.find((f) => f.id === track.folder)
}

/**
 * The tracks that reach the mix, with solo and mute resolved.
 *
 * Solo is a desk's: anything soloed -- a track, or a folder, which solos
 * every track in it -- silences everything that is not. Mute is only
 * consulted when nothing is soloed, so soloing a muted track still sounds it,
 * and a track is muted by its own button or by its folder's.
 */
export function heardTracks(song: Song): Set<string> {
  const soloed = song.tracks.filter((t) => t.solo || folderOf(song, t)?.solo)
  const live = soloed.length > 0 ? soloed : song.tracks.filter((t) => !t.mute && !folderOf(song, t)?.mute)
  return new Set(live.map((t) => t.id))
}

/** A track's level after its folder's: the two faders, one after the other. */
export function trackGain(song: Song, track: Track): number {
  return track.gain * (folderOf(song, track)?.gain ?? 1)
}

/** A new folder, holding these tracks -- or none, to drag them into later. */
export function addFolder(song: Song, id: string, name: string, trackIds: readonly string[] = []): Song {
  if (song.folders?.some((f) => f.id === id)) return song
  const members = new Set(trackIds)
  return {
    ...song,
    folders: [...(song.folders ?? []), { id, name, gain: 1 }],
    tracks: song.tracks.map((t) => (members.has(t.id) ? { ...t, folder: id } : t)),
  }
}

/**
 * Change a folder, a field at a time. A colour of null takes it away; a
 * blank name is refused. The same song back when nothing changes.
 */
export function updateFolder(
  song: Song,
  id: string,
  change: Partial<Omit<Folder, 'id' | 'color'>> & { color?: number | null },
): Song {
  const folder = song.folders?.find((f) => f.id === id)
  if (!folder) return song
  const next: Folder = { ...folder }
  if (change.name !== undefined) {
    if (!change.name.trim()) return song
    next.name = change.name
  }
  if (change.gain !== undefined && Number.isFinite(change.gain)) next.gain = Math.max(0, Math.min(1, change.gain))
  if (change.color === null) delete next.color
  else if (change.color !== undefined) next.color = change.color
  // Flags are kept only when set, so a folder muted and unmuted again is the
  // folder it was, in memory and in a file.
  for (const flag of ['mute', 'collapsed'] as const) {
    if (!(flag in change)) continue
    if (change[flag]) next[flag] = true
    else delete next[flag]
  }
  const same = (Object.keys({ ...folder, ...next }) as (keyof Folder)[]).every((k) => folder[k] === next[k])
  if (same) return song
  return { ...song, folders: song.folders!.map((f) => (f.id === id ? next : f)) }
}

/**
 * Take a folder away. Its tracks stay, out of any folder, exactly as they
 * were -- a folder is only ever a way of filing them.
 */
export function removeFolder(song: Song, id: string): Song {
  if (!song.folders?.some((f) => f.id === id)) return song
  const folders = song.folders.filter((f) => f.id !== id)
  const { folders: _, ...rest } = song
  return {
    ...rest,
    ...(folders.length ? { folders } : {}),
    tracks: song.tracks.map((t) => {
      if (t.folder !== id) return t
      const { folder: _f, ...track } = t
      return track
    }),
  }
}

/**
 * Solo a folder, as a track's solo works: exclusive, so everything else's
 * solo is cleared, and pressed again it lets everything back in.
 */
export function soloFolder(song: Song, id: string): Song {
  const folder = song.folders?.find((f) => f.id === id)
  if (!folder) return song
  const already = !!folder.solo
  return {
    ...song,
    tracks: song.tracks.map((t) => (t.solo ? { ...t, solo: undefined } : t)),
    folders: song.folders!.map((f) => {
      const { solo: _, ...rest } = f
      return !already && f.id === id ? { ...rest, solo: true } : rest
    }),
  }
}

/** File tracks in a folder, or take them out of any with null. */
export function moveToFolder(song: Song, trackIds: readonly string[], folder: string | null): Song {
  if (folder !== null && !song.folders?.some((f) => f.id === folder)) return song
  const moving = new Set(trackIds)
  let changed = false
  const tracks = song.tracks.map((t) => {
    if (!moving.has(t.id) || (t.folder ?? null) === folder) return t
    changed = true
    if (folder !== null) return { ...t, folder }
    const { folder: _, ...rest } = t
    return rest
  })
  return changed ? { ...song, tracks } : song
}

/**
 * The tracks a search for `text` finds: every track whose name has it in,
 * and every track in a folder whose name has it in. Any case. Everything,
 * for an empty search.
 */
export function tracksMatching(song: Song, text: string): Set<string> {
  const q = text.trim().toLowerCase()
  if (!q) return new Set(song.tracks.map((t) => t.id))
  return new Set(
    song.tracks
      .filter((t) => t.name.toLowerCase().includes(q) || !!folderOf(song, t)?.name.toLowerCase().includes(q))
      .map((t) => t.id),
  )
}
