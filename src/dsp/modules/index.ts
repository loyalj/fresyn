import { AdsrModule } from './Adsr'
import { BitcrushModule } from './Bitcrush'
import { BurstModule } from './Burst'
import { ClockModule } from './Clock'
import { CompressorModule } from './Compressor'
import { CvUtilModule } from './CvUtil'
import { DelayModule } from './Delay'
import { DriveModule } from './Drive'
import { GateModule } from './Gate'
import { GranularModule } from './Granular'
import { KeysModule } from './Keys'
import { LadderModule } from './Ladder'
import { LfoModule } from './Lfo'
import { MixerModule } from './Mixer'
import { NoiseModule } from './Noise'
import { OscModule } from './Osc'
import { RecorderModule } from './Recorder'
import { ResonatorModule } from './Resonator'
import { RingModModule } from './RingMod'
import { ReverbModule } from './Reverb'
import { SampleHoldModule } from './SampleHold'
import { ScopeModule } from './Scope'
import { SeqModule } from './Seq'
import { SlewModule } from './Slew'
import type { DspModule, ModuleContext } from './types'
import { VcaModule } from './Vca'
import { WavefoldModule } from './Wavefold'

type Factory = (ctx: ModuleContext) => DspModule

/** Module type to DSP implementation. Keys must match `MODULE_DEFS`. */
export const MODULE_FACTORIES: Record<string, Factory> = {
  gate: (c) => new GateModule(c),
  osc: (c) => new OscModule(c),
  keys: (c) => new KeysModule(c),
  noise: (c) => new NoiseModule(c),
  lfo: (c) => new LfoModule(c),
  adsr: (c) => new AdsrModule(c),
  sh: (c) => new SampleHoldModule(c),
  clock: (c) => new ClockModule(c),
  burst: (c) => new BurstModule(c),
  seq: (c) => new SeqModule(c),
  slew: (c) => new SlewModule(c),
  cv: (c) => new CvUtilModule(c),
  ladder: (c) => new LadderModule(c),
  vca: (c) => new VcaModule(c),
  drive: (c) => new DriveModule(c),
  fold: (c) => new WavefoldModule(c),
  ring: (c) => new RingModModule(c),
  crush: (c) => new BitcrushModule(c),
  comp: (c) => new CompressorModule(c),
  gran: (c) => new GranularModule(c),
  delay: (c) => new DelayModule(c),
  reverb: (c) => new ReverbModule(c),
  res: (c) => new ResonatorModule(c),
  mixer: (c) => new MixerModule(c),
  scope: (c) => new ScopeModule(c),
  rec: (c) => new RecorderModule(c),
}

export type { DspModule, ModuleContext }
