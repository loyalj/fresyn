/**
 * Seven-segment digits, drawn the way the glass of a counter or a tuner is:
 * every segment is always there, the unlit ones a ghost behind the lit ones.
 *
 * What a seven-segment cell cannot spell it does not pretend to. B and D are
 * the lower-case b and d every tuner uses, and a sharp is an annunciator
 * beside the digits rather than a character in them -- see the Notes &
 * frequencies display. Anything else unknown is a blank cell.
 *
 * Colours come from the display it sits in (`--seg-on`, `--seg-off`,
 * `--seg-glow`), which is where a utility gives its glass its character: a
 * VFD glows, an LCD does not.
 */

/** Which of a..g each character lights. */
const GLYPHS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
  '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  A: 'abcefg', B: 'cdefg', b: 'cdefg', C: 'adef', c: 'deg', D: 'bcdeg', d: 'bcdeg',
  E: 'adefg', F: 'aefg', G: 'acdef', H: 'bcefg', h: 'cefg', L: 'def', n: 'ceg',
  o: 'cdeg', P: 'abefg', r: 'eg', t: 'defg', U: 'bcdef', u: 'cde', y: 'bcdfg',
  '-': 'g', '_': 'd', ' ': '',
}

/** One cell is 12 by 20, set 15 apart; the point sits in the gap. */
const W = 12
const H = 20
const ADVANCE = 15

const hSeg = (x1: number, x2: number, y: number) =>
  `${x1},${y} ${x1 + 1},${y - 1} ${x2 - 1},${y - 1} ${x2},${y} ${x2 - 1},${y + 1} ${x1 + 1},${y + 1}`
const vSeg = (x: number, y1: number, y2: number) =>
  `${x},${y1} ${x + 1},${y1 + 1} ${x + 1},${y2 - 1} ${x},${y2} ${x - 1},${y2 - 1} ${x - 1},${y1 + 1}`

const SEGMENTS: [string, string][] = [
  ['a', hSeg(1.4, 10.6, 1)],
  ['b', vSeg(11, 1.4, 9.6)],
  ['c', vSeg(11, 10.4, 18.6)],
  ['d', hSeg(1.4, 10.6, 19)],
  ['e', vSeg(1, 10.4, 18.6)],
  ['f', vSeg(1, 1.4, 9.6)],
  ['g', hSeg(1.4, 10.6, 10)],
]

interface Cell {
  char: string
  point: boolean
}

/** Text as cells: a full stop belongs to the character before it, as on the glass. */
function cells(text: string): Cell[] {
  const out: Cell[] = []
  for (const ch of text) {
    if (ch === '.' && out.length && !out[out.length - 1].point) out[out.length - 1].point = true
    else out.push({ char: ch === '.' ? ' ' : ch, point: ch === '.' })
  }
  return out
}

interface Props {
  text: string
  /** How many cells the glass has; the text is set to the right of them, as a counter's is. */
  digits?: number
  /** Height of a digit, in pixels. */
  size?: number
  /** Whether the cells carry decimal points at all; a note readout's do not. */
  points?: boolean
  className?: string
  /** False when the reading around it already says it, as a note reading does. */
  spoken?: boolean
}

export function Segments({ text, digits, size = 28, points = true, className = '', spoken = true }: Props) {
  const set = cells(text)
  const count = Math.max(digits ?? set.length, set.length)
  const padded: Cell[] = [...Array.from({ length: count - set.length }, () => ({ char: ' ', point: false })), ...set]
  const width = count * ADVANCE - (ADVANCE - W) + (points ? 2.5 : 0) + 2
  return (
    <span className={`segments ${className}`}>
      {/* The glass says it to the eye; this says it to everything else, and is
          what a copy or a test reads. */}
      {spoken && <span className="visually-hidden">{text.trim()}</span>}
      <svg
        aria-hidden="true"
        height={size}
        width={(size * width) / (H + 2)}
        viewBox={`-1 -1 ${width} ${H + 2}`}
      >
        {/* Leaned forward a little, as nearly every LED and VFD face is. */}
        <g transform="skewX(-6) translate(1.5 0)">
          {padded.map((cell, i) => {
            const lit = GLYPHS[cell.char] ?? ''
            return (
              <g key={i} transform={`translate(${i * ADVANCE} 0)`}>
                {SEGMENTS.map(([name, shape]) => (
                  <polygon key={name} points={shape} className={lit.includes(name) ? 'seg-on' : 'seg-off'} />
                ))}
                {points && <circle cx={W + 1.6} cy={19} r={1.1} className={cell.point ? 'seg-on' : 'seg-off'} />}
              </g>
            )
          })}
        </g>
      </svg>
    </span>
  )
}
