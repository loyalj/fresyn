import { songEnd, songEventTicks } from './schedule'
import { sectionsOf } from './section'
import { barTicks, PPQ, type Meter, type Song } from './types'

/**
 * The arrangement as a Standard MIDI File: what plays, when, on which track,
 * for taking the song into another DAW or a game's own sequencer.
 *
 * Type 1, a track per song track after a conductor track holding the tempo
 * and time signature -- and every change of either -- and a marker for each
 * section. Counted in the song's
 * own ticks -- 960 to the quarter note -- so nothing is rounded on the way.
 * The notes are what plays, not what is written: clips repeat, trim and cut
 * notes off, swing is applied, and muted tracks are left out, exactly as a
 * bounce hears them.
 *
 * A note is written as the note you hear, not the row it is on: `noteOf`
 * turns a track's row into a MIDI note number (see `rowZero`), so C4 in the
 * roll is 60 in the file whatever each patch is tuned to.
 */
export interface MidiOptions {
  /** The song's name, for the conductor track. */
  name?: string
  /** The MIDI note a track's row plays. Rounded, and held to 0..127. */
  noteOf: (track: string, row: number) => number
}

export function songToMidi(song: Song, { name, noteOf }: MidiOptions): Uint8Array {
  const end = songEnd(song)
  const events = songEventTicks(song, 0, end + 1)
  const out: number[][] = []

  // The conductor: name, every tempo and meter, and the sections as markers,
  // in the order they happen -- a track's events go in time order, and at one
  // tick the tempo and meter come before the marker that names the bar.
  const head = new TrackWriter()
  if (name) head.meta(0, 0x03, text(name))
  const conductor: { tick: number; type: number; body: number[] }[] = []
  const tempo = (tick: number, bpm: number) => {
    const us = Math.round(60_000_000 / bpm)
    conductor.push({ tick, type: 0x51, body: [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] })
  }
  // Clocks per click: a MIDI clock is 1/24 of a quarter; one click per beat.
  const meter = (tick: number, m: Meter) =>
    conductor.push({ tick, type: 0x58, body: [m.beats, Math.log2(m.unit), (24 * 4) / m.unit, 8] })
  tempo(0, song.tempo)
  for (const c of song.tempos ?? []) tempo(c.tick, c.bpm)
  meter(0, song.meter ?? { beats: 4, unit: 4 })
  for (const c of song.meters ?? []) meter(c.tick, c.meter)
  for (const s of sectionsOf(song)) conductor.push({ tick: s.tick, type: 0x06, body: text(s.name) })
  // Stable, so each kind keeps its order within a tick.
  conductor.sort((a, b) => a.tick - b.tick)
  for (const e of conductor) head.meta(e.tick, e.type, e.body)
  head.meta(Math.max(end, barTicks(song), head.at), 0x2f, [])
  out.push(head.bytes())

  // A channel per track, in order, stepping over 10 -- General MIDI's drums
  // -- so no track is played as a drum kit by whatever opens the file.
  let channel = 0
  for (const track of song.tracks) {
    const mine = events.filter((e) => e.track === track.id)
    if (!mine.some((e) => e.kind === 'on')) continue
    const ch = channel
    channel = channel + 1 === 9 ? 10 : (channel + 1) % 16
    const w = new TrackWriter()
    w.meta(0, 0x03, text(track.name || track.id))
    // A release before a press on the same tick, so a note repeated
    // back-to-back is two notes and not one cut short.
    const sorted = mine
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.tick - b.e.tick || (a.e.kind === b.e.kind ? a.i - b.i : a.e.kind === 'off' ? -1 : 1))
    /** Held notes, so a release for every note (a seam) knows what to let go. */
    const held = new Map<number, number>()
    for (const { e } of sorted) {
      if (e.kind === 'on') {
        const note = clampNote(noteOf(track.id, e.pitch))
        // A second press of a note still held: let the first go.
        if (held.get(note)) w.event(e.tick, [0x80 | ch, note, 0])
        held.set(note, 1)
        w.event(e.tick, [0x90 | ch, note, Math.max(1, Math.min(127, Math.round(e.velocity * 127)))])
      } else {
        const note = clampNote(noteOf(track.id, e.pitch))
        if (!held.get(note)) continue
        held.delete(note)
        w.event(e.tick, [0x80 | ch, note, 0])
      }
    }
    for (const note of held.keys()) w.event(end, [0x80 | ch, note, 0])
    w.meta(Math.max(end, w.at), 0x2f, [])
    out.push(w.bytes())
  }

  const header = [
    ...ascii('MThd'),
    ...u32(6),
    0, 1, // format 1
    ...u16(out.length),
    ...u16(PPQ),
  ]
  const total = header.length + out.reduce((n, t) => n + t.length, 0)
  const file = new Uint8Array(total)
  file.set(header, 0)
  let at = header.length
  for (const t of out) {
    file.set(t, at)
    at += t.length
  }
  return file
}

/** One MTrk chunk, written in order with each event's delta from the last. */
class TrackWriter {
  private data: number[] = []
  at = 0

  event(tick: number, body: number[]) {
    const t = Math.max(this.at, Math.round(tick))
    this.data.push(...varLen(t - this.at), ...body)
    this.at = t
  }

  meta(tick: number, type: number, body: number[]) {
    this.event(tick, [0xff, type, ...varLen(body.length), ...body])
  }

  bytes(): number[] {
    return [...ascii('MTrk'), ...u32(this.data.length), ...this.data]
  }
}

const clampNote = (n: number) => Math.max(0, Math.min(127, Math.round(n)))

/** A MIDI variable-length quantity: seven bits a byte, high bit set on all but the last. */
export function varLen(n: number): number[] {
  let v = Math.max(0, Math.floor(n))
  const out = [v & 0x7f]
  while ((v >>= 7) > 0) out.unshift((v & 0x7f) | 0x80)
  return out
}

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
/** Text for a meta event, as UTF-8. */
const text = (s: string) => [...new TextEncoder().encode(s)]
