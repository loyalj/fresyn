import { DspModule } from './types'

/**
 * The recorder: where an offline render is taken from.
 *
 * It does nothing at audio rate, and that is the point. It has no fader,
 * because it is a tape machine and not a mixer -- it takes the level it is
 * given, so what you hear is what lands in the wav. The compiler reads the
 * slots feeding its jacks and hands them to the render; the signal itself
 * never passes through here, so patching a recorder into a rack cannot
 * change what the rack sounds like, any more than a scope can.
 */
export class RecorderModule extends DspModule {
  processBlock() {}
}
