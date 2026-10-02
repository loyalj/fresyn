import { useCallback, useEffect, useRef } from 'react'
import { midiToHz } from '../../utilities/pitch'
import { PITCH_RANGE } from '../../song/types'
import type { UtilityProps, UtilityTrack } from '../../utilities'

/** The row a real note plays on a track, held inside the rows there are. */
export function rowOf(track: Pick<UtilityTrack, 'zero'>, midi: number): number {
  return Math.min(PITCH_RANGE.high, Math.max(PITCH_RANGE.low, Math.round(midi - track.zero)))
}

/**
 * Notes sounded for a moment through the rack on the bench, the way a key
 * in the roll's gutter sounds one: the track's own sound, at the pitch it
 * would be written at. A rack with no Keyboard has no pitch to give, so
 * there the notes are a plain tone of their own instead, quietly, through
 * the same device -- a chord is worth hearing even before the rack can play
 * one.
 *
 * Whatever is still sounding is let go when the panel closes.
 */
export function useAudition({ tracks, bench, preview, release, audio }: Pick<UtilityProps, 'tracks' | 'bench' | 'preview' | 'release' | 'audio'>) {
  const held = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const track = tracks.find((t) => t.id === bench) ?? null
  const pitched = track?.kind === 'note'

  useEffect(() => {
    const map = held.current
    return () => {
      for (const [key, timer] of map) {
        clearTimeout(timer)
        const [id, row] = key.split('|')
        release(id, Number(row))
      }
      map.clear()
    }
  }, [release])

  /** A row of a track, sounded for `seconds`; struck again if it is still sounding. */
  const strike = useCallback(
    (trackId: string, row: number, velocity: number, seconds: number) => {
      const key = `${trackId}|${row}`
      const was = held.current.get(key)
      if (was !== undefined) {
        clearTimeout(was)
        release(trackId, row)
      }
      preview(trackId, row, velocity)
      held.current.set(
        key,
        setTimeout(() => {
          held.current.delete(key)
          release(trackId, row)
        }, seconds * 1000),
      )
    },
    [preview, release],
  )

  const play = useCallback(
    async (midis: readonly number[], seconds = 1.1, velocity = 0.8) => {
      if (track && pitched) {
        for (const m of midis) strike(track.id, rowOf(track, m), velocity, seconds)
        return
      }
      const ctx = await audio()
      if (!ctx) return
      const t = ctx.currentTime + 0.02
      const level = 0.18 / Math.max(1, midis.length)
      for (const m of midis) {
        const osc = ctx.createOscillator()
        const env = ctx.createGain()
        osc.type = 'triangle'
        osc.frequency.value = midiToHz(m)
        env.gain.setValueAtTime(0, t)
        env.gain.linearRampToValueAtTime(level, t + 0.015)
        env.gain.setTargetAtTime(0, t + seconds * 0.6, seconds * 0.15)
        osc.connect(env)
        env.connect(ctx.destination)
        osc.start(t)
        osc.stop(t + seconds + 0.3)
        osc.onended = () => env.disconnect()
      }
    },
    [track, pitched, strike, audio],
  )

  return { play, strike, track, pitched }
}
