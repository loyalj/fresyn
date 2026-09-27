import { createContext, useCallback, useContext, useEffect, useRef } from 'react'

/**
 * Whether the face a meter is on can be seen. False on the front of a rack
 * that has been turned round, where the bars are behind the jacks and
 * drawing them would be work nobody sees.
 */
export const FaceShown = createContext(true)

/**
 * Every level bar and lamp in the app, driven by one animation frame loop.
 *
 * Each meter used to run a loop of its own for as long as it was mounted --
 * one per oscillator, one per mixer, one per sequencer and the desk's --
 * whether or not anything was moving and whether or not the face was even
 * turned towards you. Here a meter is on the loop only while it has
 * something left to draw: a report wakes it, and it leaves once every bar has
 * fallen to the floor. A quiet rack costs no frames at all.
 */
type Tick = () => boolean
const ticking = new Set<Tick>()
let frame = 0

function loop() {
  frame = 0
  for (const tick of ticking) {
    if (!tick()) ticking.delete(tick)
  }
  if (ticking.size > 0) frame = requestAnimationFrame(loop)
}

function wake(tick: Tick) {
  ticking.add(tick)
  if (!frame) frame = requestAnimationFrame(loop)
}

function sleep(tick: Tick) {
  ticking.delete(tick)
}

/**
 * A set of bars that jump up to what is reported and fall back by `fall` a
 * frame, drawn straight to the page by `draw` rather than through React: at
 * thirty reports a second, state would make every knob in the room feel
 * sticky.
 *
 * Returns `feed`, which takes one bar's newest reading, already on the bar's
 * own 0..1 scale. A reading is consumed by the next frame -- left in place it
 * would hold the bar up for good once the rack went quiet. With `max`, two
 * readings that land in the same frame keep the louder, for a source that
 * reports several things into one bar.
 */
export function useFallingMeter<K>(
  fall: number,
  draw: (key: K, value: number) => void,
): (key: K, value: number, max?: boolean) => void {
  const shown = useContext(FaceShown)
  const incoming = useRef(new Map<K, number>())
  const level = useRef(new Map<K, number>())
  const drawRef = useRef(draw)
  drawRef.current = draw
  const shownRef = useRef(shown)
  shownRef.current = shown

  const tick = useRef<Tick>(null!)
  if (tick.current === null) {
    tick.current = () => {
      let busy = false
      const keys = new Set([...incoming.current.keys(), ...level.current.keys()])
      for (const key of keys) {
        const target = incoming.current.get(key) ?? 0
        incoming.current.delete(key)
        const was = level.current.get(key) ?? 0
        const fallen = was - fall
        const v = target > fallen ? target : fallen > 0 ? fallen : 0
        if (v > 0) busy = true
        if (v === was) continue
        if (v > 0) level.current.set(key, v)
        else level.current.delete(key)
        drawRef.current(key, v)
      }
      return busy
    }
  }

  // Turned away, nothing is drawn; turned back, whatever was left standing
  // falls from where it was.
  useEffect(() => {
    const t = tick.current
    if (shown && level.current.size > 0) wake(t)
    if (!shown) sleep(t)
    return () => sleep(t)
  }, [shown])

  return useCallback((key: K, value: number, max = false) => {
    if (!shownRef.current) return
    // Silence reported for a bar already at the floor changes nothing, and
    // is most of what a quiet rack reports.
    if (value <= 0 && !level.current.has(key) && !incoming.current.has(key)) return
    const pending = incoming.current.get(key)
    incoming.current.set(key, max && pending !== undefined && pending > value ? pending : value)
    wake(tick.current)
  }, [])
}
