import { useState } from 'react'
import { hasScale } from '../../song/scale'
import type { UtilityProps } from '../../utilities'
import {
  chordMidi,
  CIRCLE,
  CIRCLE_MAJOR,
  CIRCLE_MINOR,
  diatonicChords,
  keyName,
  scaleClasses,
  spelling,
} from '../../utilities/harmony'
import { useAudition } from './audition'
import { MAX_CHORDS, useHarmony } from './harmonyStore'
import { KeyPicker } from './KeyPicker'

const mod12 = (n: number) => ((n % 12) + 12) % 12

/** The white keys' pitch classes, left to right, and the black keys' with the white key each sits after. */
const WHITE = [0, 2, 4, 5, 7, 9, 11]
const BLACK: [pc: number, after: number][] = [
  [1, 0],
  [3, 1],
  [6, 3],
  [8, 4],
  [10, 5],
]
const KEY_W = 20
const KEY_H = 60
const BLACK_W = 12
const BLACK_H = 37
const OCTAVES = 2

/**
 * The Scales & chords utility: a key laid out three ways.
 *
 * Its notes on a keyboard and round the circle of fifths, and the chords
 * that belong to it -- one on each degree, as triads or sevenths, with the
 * numeral each is known by. Click a chord to hear it through the rack on the
 * bench, voiced where Progressions would write it; **+** adds it to the
 * progression there. Click a key to hear the note, a place on the circle to
 * move the key there. **Set song's key** makes it the song's, which is what
 * the roll shades and snaps to.
 */
export function ScalesUtility(props: UtilityProps) {
  const { song, editSong } = props
  const [h, set] = useHarmony(song)
  const { play, track, pitched } = useAudition(props)
  const [picked, setPicked] = useState<number | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const name = spelling(h.root, h.mode)
  const inKey = new Set(scaleClasses(h.root, h.mode))
  const chords = diatonicChords(h.root, h.mode, h.sevenths)
  const chord = picked === null ? null : chords[picked]
  const inChord = new Set(chord ? chord.intervals.map((s) => mod12(chord.root + s)) : [])

  const songKey = hasScale(song.scale) ? song.scale : null
  const isSongKey = !!songKey && songKey.root === h.root && songKey.mode === h.mode
  const thisKey = keyName(h.root, h.mode)

  const pickChord = (i: number) => {
    setPicked(i)
    void play(chordMidi(chords[i], h.octave))
  }

  const playNote = (midi: number) => void play([midi], 0.7)

  const keyClass = (pc: number, black: boolean) =>
    [
      'scales-key',
      black ? 'black' : 'white',
      inKey.has(pc) ? 'in' : '',
      pc === mod12(h.root) ? 'root' : '',
      inChord.has(pc) ? 'chord' : '',
    ]
      .filter(Boolean)
      .join(' ')

  const base = 12 * (h.octave + 1)
  const width = WHITE.length * OCTAVES * KEY_W + KEY_W

  return (
    <div className="scales">
      <div className="timing-row">
        <KeyPicker
          root={h.root}
          mode={h.mode}
          onChange={(change) => {
            set(change)
            setPicked(null)
          }}
        />
        <div className="scales-song">
          {songKey && !isSongKey && (
            <button
              type="button"
              className="timing-song"
              title={`Look at the song's key, ${keyName(songKey.root, songKey.mode)}`}
              onClick={() => (set({ root: songKey.root, mode: songKey.mode }), setPicked(null))}
            >
              Use song's
            </button>
          )}
          <button
            type="button"
            className="timing-song"
            disabled={isSongKey}
            title={isSongKey ? `The song is in ${thisKey}` : `Put the song in ${thisKey}: the roll shades it, and snaps to it when asked`}
            onClick={() => {
              editSong(
                (s) => ({ ...s, scale: { root: h.root, mode: h.mode, ...(s.scale?.snap ? { snap: true } : {}) } }),
                undefined,
                `Key ${thisKey}`,
              )
              setStatus(`The song is in ${thisKey} now`)
            }}
          >
            {isSongKey ? "Song's key" : "Set song's key"}
          </button>
        </div>
      </div>

      <svg className="scales-keyboard" viewBox={`0 0 ${width} ${KEY_H}`} role="group" aria-label={`The notes of ${thisKey}`}>
        {Array.from({ length: WHITE.length * OCTAVES + 1 }, (_, i) => {
          const pc = WHITE[i % 7]
          const midi = base + 12 * Math.floor(i / 7) + pc
          return (
            <g key={`w${i}`} className={keyClass(pc, false)} onClick={() => playNote(midi)}>
              <title>{`${name(pc)}${inKey.has(pc) ? '' : ' (not in the key)'}`}</title>
              <rect x={i * KEY_W + 0.5} y={0.5} width={KEY_W - 1} height={KEY_H - 1} rx={2} />
              {inKey.has(pc) && (
                <text x={i * KEY_W + KEY_W / 2} y={KEY_H - 7}>
                  {name(pc)}
                </text>
              )}
              {inChord.has(pc) && <circle cx={i * KEY_W + KEY_W / 2} cy={KEY_H - 18} r={3.5} />}
            </g>
          )
        })}
        {Array.from({ length: OCTAVES }, (_, o) =>
          BLACK.map(([pc, after]) => {
            const x = (o * 7 + after + 1) * KEY_W - BLACK_W / 2
            const midi = base + 12 * o + pc
            return (
              <g key={`b${o}-${pc}`} className={keyClass(pc, true)} onClick={() => playNote(midi)}>
                <title>{`${name(pc)}${inKey.has(pc) ? '' : ' (not in the key)'}`}</title>
                <rect x={x} y={0.5} width={BLACK_W} height={BLACK_H} rx={1.5} />
                {inChord.has(pc) && <circle cx={x + BLACK_W / 2} cy={BLACK_H - 8} r={3} />}
              </g>
            )
          }),
        )}
      </svg>

      <div className="scales-middle">
        <CircleOfFifths
          root={h.root}
          inKey={inKey}
          inChord={inChord}
          onPick={(pc) => (set({ root: pc }), setPicked(null))}
        />
        <dl className="scales-facts">
          <dt>Notes</dt>
          <dd>{scaleClasses(h.root, h.mode).map(name).join(' ')}</dd>
          {chord && (
            <>
              <dt>Chord</dt>
              <dd>
                <strong>{chord.name}</strong> <span className="timing-dim">{chord.numeral}</span>
                <br />
                {chord.notes.join(' ')}
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className="pitch-section">
        <div className="timing-sections-head">
          <h3>Chords in the key</h3>
          <div className="timing-units" role="group" aria-label="Chord size">
            <button type="button" className={h.sevenths ? '' : 'on'} aria-pressed={!h.sevenths} onClick={() => set({ sevenths: false })}>
              Triads
            </button>
            <button type="button" className={h.sevenths ? 'on' : ''} aria-pressed={h.sevenths} onClick={() => set({ sevenths: true })}>
              Sevenths
            </button>
          </div>
        </div>
        <div className="scales-chords">
          {chords.map((c, i) => (
            <div key={i} className={`scales-chord${picked === i ? ' on' : ''}${c.outside ? ' outside' : ''}`}>
              <button
                type="button"
                className="scales-chord-play"
                title={`${c.name}: ${c.notes.join(' ')}${c.outside ? ' -- reaches outside the scale' : ''}. Click to hear it.`}
                onClick={() => pickChord(i)}
              >
                <span className="scales-numeral">{c.numeral}</span>
                <span className="scales-name">{c.name}</span>
              </button>
              <button
                type="button"
                className="scales-add"
                aria-label={`Add ${c.name} to the progression`}
                title="Add it to the progression in Progressions"
                disabled={h.degrees.length >= MAX_CHORDS}
                onClick={() => {
                  set({ degrees: [...h.degrees, i] })
                  setStatus(`Added ${c.name} -- the progression is ${h.degrees.length + 1} chord${h.degrees.length ? 's' : ''} long`)
                }}
              >
                +
              </button>
            </div>
          ))}
        </div>
      </div>

      <p className="timing-dim timing-status" aria-live="polite">
        {status ??
          (pitched
            ? `Chords play through ${track!.name || 'the rack'}, on the bench.`
            : 'The rack on the bench has no Keyboard, so chords play as a plain tone.')}
      </p>
    </div>
  )
}

/**
 * The twelve keys round the circle of fifths, the key's own notes lit and its
 * root ringed; the minor key that shares each one's notes is inside it.
 */
function CircleOfFifths({
  root,
  inKey,
  inChord,
  onPick,
}: {
  root: number
  inKey: ReadonlySet<number>
  inChord: ReadonlySet<number>
  onPick: (pc: number) => void
}) {
  const size = 196
  const c = size / 2
  const at = (i: number, r: number) => {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2
    return { x: c + r * Math.cos(a), y: c + r * Math.sin(a) }
  }
  return (
    <svg className="scales-circle" viewBox={`0 0 ${size} ${size}`} role="group" aria-label="Circle of fifths">
      <circle className="scales-circle-ring" cx={c} cy={c} r={78} />
      {CIRCLE.map((pc, i) => {
        const p = at(i, 78)
        const q = at(i, 49)
        const cls = ['scales-node', inKey.has(pc) ? 'in' : '', pc === mod12(root) ? 'root' : '', inChord.has(pc) ? 'chord' : '']
          .filter(Boolean)
          .join(' ')
        return (
          <g key={pc} className={cls} onClick={() => onPick(pc)}>
            <title>{`Move the key to ${CIRCLE_MAJOR[i]}`}</title>
            <circle cx={p.x} cy={p.y} r={14} />
            <text x={p.x} y={p.y}>
              {CIRCLE_MAJOR[i]}
            </text>
            <text className="scales-minor" x={q.x} y={q.y}>
              {CIRCLE_MINOR[i]}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
