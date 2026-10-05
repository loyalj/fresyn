import { FADER_MAX_DB, FADER_MIN_DB } from '../dsp/automation'
import type { ParamSpec } from '../patch/param'

/**
 * The song desk's knobs and fader, shared by the Mix view that draws them
 * and the MIDI mapping that moves them, so a controller's knob and the one
 * on screen cover the same range in the same way.
 */

const knob = (id: string, label: string, min: number, max: number, def: number, unit: string, curve: 'lin' | 'exp' = 'lin'): ParamSpec => ({
  id, label, min, max, default: def, unit, curve,
})

export const EQ = {
  high: knob('high', 'High', -24, 12, 0, 'dB'),
  mid: knob('mid', 'Mid', -24, 12, 0, 'dB'),
  low: knob('low', 'Low', -24, 12, 0, 'dB'),
}
export const PAN = knob('pan', 'Pan', -1, 1, 0, '')
export const BALANCE = knob('balance', 'Balance', -1, 1, 0, '')
export const SEND_SPACE = knob('space', 'Space', 0, 1, 0, '')
export const SEND_DELAY = knob('delay', 'Delay', 0, 1, 0, '')
export const RETURNS = {
  size: knob('size', 'Size', 0, 1, 0.6, ''),
  decay: knob('decay', 'Decay', 0.05, 20, 2.2, 's', 'exp'),
  spaceDamp: knob('damping', 'Damp', 0, 1, 0.4, ''),
  spaceLevel: knob('level', 'Return', 0, 2, 1, ''),
  time: knob('time', 'Time', 0.002, 2, 0.375, 's', 'exp'),
  feedback: knob('feedback', 'Fdbk', 0, 0.95, 0.35, ''),
  delayDamp: knob('damping', 'Damp', 0, 1, 0.3, ''),
  delayLevel: knob('level', 'Return', 0, 2, 1, ''),
}

/**
 * The fader's travel, in dB: the bottom is off, the top a little past unity.
 * Kept with the automation's arithmetic, which turns a fader's position into
 * a level the same way.
 */
export { FADER_MAX_DB, FADER_MIN_DB }

export const toDb = (gain: number) => (gain <= 0 ? FADER_MIN_DB : Math.max(FADER_MIN_DB, 20 * Math.log10(gain)))
export const toGain = (db: number) => (db <= FADER_MIN_DB ? 0 : Math.pow(10, db / 20))

/** A level as the fader's position, 0..1, and back. */
export const faderPosition = (gain: number) => (toDb(gain) - FADER_MIN_DB) / (FADER_MAX_DB - FADER_MIN_DB)
export const faderGain = (t: number) => toGain(FADER_MIN_DB + Math.min(1, Math.max(0, t)) * (FADER_MAX_DB - FADER_MIN_DB))
