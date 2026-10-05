import { useEffect, useRef, useState } from 'react'
import type { Transport } from '../audio/Transport'
import { barsOf, secondsAt, tempoMap } from '../song/timeline'
import { PPQ, type Song } from '../song/types'

interface Props {
  transport: Transport
  /** The song whose bars and tempos the position is counted in. */
  song: Song
  /** Where Play starts from when nothing else says, or null for its own start. */
  cursor: number | null
  /** A position typed in: the next Play starts there, and playing jumps there now. */
  onPosition: (tick: number) => void
}

/** Bar, beat and sixteenth, counted from one: 3.2.1. */
export function barBeat(song: Song, tick: number): string {
  const bar = barsOf(song).at(Math.max(0, tick))
  const into = Math.max(0, tick - bar.tick)
  const beat = Math.floor(into / bar.beat)
  const sixteenth = Math.floor((into - beat * bar.beat) / (PPQ / 4))
  return `${bar.index + 1}.${beat + 1}.${sixteenth + 1}`
}

/** Minutes, seconds and tenths: 1:04.5. */
export function clockTime(song: Song, tick: number): string {
  const s = Math.max(0, secondsAt(song, Math.max(0, tick)))
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

/**
 * A position typed in: a bar ("5"), a bar and beat ("5.3"), a bar, beat and
 * sixteenth ("5.3.2"), or a time ("1:04", "0:12.5"). Null for anything else.
 */
export function parsePosition(song: Song, text: string): number | null {
  const t = text.trim()
  const time = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t)
  if (time) {
    const seconds = Number(time[1]) * 60 + Number(time[2])
    return Math.round(tempoMap(song, 1).advance(0, seconds))
  }
  const parts = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(t)
  if (!parts) return null
  const [b, beat = 1, sixteenth = 1] = [Number(parts[1]), Number(parts[2] ?? 1), Number(parts[3] ?? 1)]
  if (b < 1 || beat < 1 || sixteenth < 1) return null
  const bar = barsOf(song).bar(b - 1)
  return Math.round(bar.tick + (beat - 1) * bar.beat + (sixteenth - 1) * (PPQ / 4))
}

/**
 * Where the song is, beside Play: the bar and beat, and the time.
 *
 * While it plays it follows what is heard, written straight to the page a
 * frame at a time rather than through React -- the dock would otherwise
 * re-render sixty times a second. Stopped, it shows where Play will start.
 * Click it to type a position.
 */
export function PositionCounter({ transport, song, cursor, onPosition }: Props) {
  const bars = useRef<HTMLSpanElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const [entry, setEntry] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const latest = useRef({ song, cursor })
  latest.current = { song, cursor }

  // A frame at a time only while the song plays; stopped, it is drawn when
  // what it shows changes, and costs nothing in between.
  const draw = useRef(() => {})
  draw.current = () => {
    const { song, cursor } = latest.current
    const tick = transport.state.playing ? (transport.heardTick() ?? transport.state.tick) : (cursor ?? 0)
    if (bars.current) bars.current.textContent = barBeat(song, tick)
    if (time.current) time.current.textContent = clockTime(song, tick)
  }
  useEffect(() => {
    let raf = 0
    const run = () => {
      draw.current()
      raf = transport.state.playing ? requestAnimationFrame(run) : 0
    }
    run()
    const stop = transport.subscribe((state) => {
      if (state.playing && !raf) raf = requestAnimationFrame(run)
      if (!state.playing) draw.current()
    })
    return () => {
      stop()
      cancelAnimationFrame(raf)
    }
  }, [transport])
  useEffect(() => {
    if (!transport.state.playing) draw.current()
  })

  const commit = (text: string) => {
    const tick = parsePosition(song, text)
    if (tick === null) {
      setBad(true)
      return
    }
    setEntry(null)
    setBad(false)
    onPosition(tick)
  }

  if (entry !== null) {
    return (
      <input
        className={`dock-position dock-position-entry${bad ? ' bad' : ''}`}
        value={entry}
        autoFocus
        aria-label="Go to a position: a bar, bar.beat, or a time like 1:04"
        aria-invalid={bad}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setEntry(e.target.value)
          setBad(false)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit(e.currentTarget.value)
          else if (e.key === 'Escape') setEntry(null)
        }}
        onBlur={() => setEntry(null)}
      />
    )
  }
  return (
    <button
      type="button"
      className="dock-position"
      title="Where the song is: bar.beat.sixteenth and the time. Click to type a position to play from"
      onClick={() => setEntry(barBeat(song, cursor ?? (transport.state.playing ? transport.state.tick : 0)))}
    >
      <span className="dock-position-bars" ref={bars}>1.1.1</span>
      <span className="dock-position-time" ref={time}>0:00.0</span>
    </button>
  )
}
