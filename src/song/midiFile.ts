/**
 * Reading a Standard MIDI File: the other direction from `midi.ts`.
 *
 * Only reading -- what the bytes say, in the file's own ticks, with nothing
 * decided yet about tracks, patterns or sounds; `midiImport.ts` does that.
 * Format 0 and 1 are read (2, a set of separate songs, is rare enough to
 * refuse). Running status, any number of ticks to the quarter note, and the
 * meta events a song is built from -- tempo, time signature, markers, track
 * names -- are understood; system exclusive and everything else is stepped
 * over. A file a sequencer wrote sloppily, with a chunk length that runs
 * past the end, is read as far as it goes rather than refused.
 */

export type MidiFileEvent =
  | { tick: number; kind: 'note'; channel: number; note: number; velocity: number; on: boolean }
  | { tick: number; kind: 'cc'; channel: number; number: number; value: number }
  | { tick: number; kind: 'program'; channel: number; program: number }
  | { tick: number; kind: 'tempo'; bpm: number }
  | { tick: number; kind: 'meter'; beats: number; unit: number }
  | { tick: number; kind: 'marker'; text: string }
  | { tick: number; kind: 'name'; text: string }

export interface MidiFileTrack {
  /** In order of tick, in the file's own ticks. */
  events: MidiFileEvent[]
}

export interface MidiFile {
  format: number
  /** Ticks to a quarter note. */
  division: number
  tracks: MidiFileTrack[]
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

export function parseMidiFile(bytes: Uint8Array): MidiFile | { error: string } {
  if (bytes.length < 14 || ascii(bytes, 0, 4) !== 'MThd') return { error: 'not a MIDI file' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headLen = view.getUint32(4)
  const format = view.getUint16(8)
  const count = view.getUint16(10)
  const division = view.getUint16(12)
  if (format > 1) return { error: 'a format 2 MIDI file, which holds separate songs, is not supported' }
  if (division & 0x8000) return { error: 'a MIDI file timed in SMPTE frames rather than beats is not supported' }
  if (!(division > 0)) return { error: 'a MIDI file with no ticks to the beat' }

  const tracks: MidiFileTrack[] = []
  let at = 8 + headLen
  while (at + 8 <= bytes.length && tracks.length < count) {
    const id = ascii(bytes, at, 4)
    const len = view.getUint32(at + 4)
    const start = at + 8
    const end = Math.min(bytes.length, start + len)
    at = start + len
    if (id !== 'MTrk') continue
    tracks.push({ events: readTrack(bytes, start, end) })
  }
  if (!tracks.length) return { error: 'a MIDI file with no tracks in it' }
  return { format, division, tracks }
}

function readTrack(b: Uint8Array, from: number, to: number): MidiFileEvent[] {
  const out: MidiFileEvent[] = []
  let at = from
  let tick = 0
  let running = 0
  const varLen = () => {
    let v = 0
    for (let i = 0; i < 4 && at < to; i++) {
      const c = b[at++]
      v = (v << 7) | (c & 0x7f)
      if (!(c & 0x80)) break
    }
    return v
  }
  const text = (n: number) => new TextDecoder().decode(b.subarray(at, Math.min(to, at + n)))

  while (at < to) {
    tick += varLen()
    if (at >= to) break
    let status = b[at]
    if (status & 0x80) at++
    else if (running) status = running
    else {
      // A data byte with no status to run on: nothing can be made of it.
      at++
      continue
    }

    if (status === 0xff) {
      const type = b[at++]
      const n = varLen()
      if (type === 0x51 && n >= 3) {
        const us = (b[at] << 16) | (b[at + 1] << 8) | b[at + 2]
        if (us > 0) out.push({ tick, kind: 'tempo', bpm: 60_000_000 / us })
      } else if (type === 0x58 && n >= 2) {
        out.push({ tick, kind: 'meter', beats: b[at], unit: 2 ** b[at + 1] })
      } else if (type === 0x06) {
        out.push({ tick, kind: 'marker', text: text(n) })
      } else if (type === 0x03) {
        out.push({ tick, kind: 'name', text: text(n) })
      } else if (type === 0x2f) {
        break
      }
      at += n
      continue
    }
    if (status === 0xf0 || status === 0xf7) {
      at += varLen()
      continue
    }
    if (status >= 0xf0) continue

    running = status
    const type = status & 0xf0
    const channel = (status & 0x0f) + 1
    const d1 = b[at++] & 0x7f
    // Program change and channel pressure carry one data byte; the rest two.
    if (type === 0xc0) {
      out.push({ tick, kind: 'program', channel, program: d1 })
      continue
    }
    if (type === 0xd0) continue
    const d2 = b[at++] & 0x7f
    if (type === 0x90 || type === 0x80) {
      const on = type === 0x90 && d2 > 0
      out.push({ tick, kind: 'note', channel, note: d1, velocity: on ? d2 : 0, on })
    } else if (type === 0xb0) {
      out.push({ tick, kind: 'cc', channel, number: d1, value: d2 })
    }
    // Aftertouch and pitch bend: read past, and nothing to bring in yet.
  }
  return out
}
