import { AdsrModule } from './Adsr'
import { BubbleModule } from './Bubble'
import { BounceModule } from './Bounce'
import { ChipModule } from './Chip'
import { DopplerModule } from './Doppler'
import { LoopSeamModule } from './LoopSeam'
import { RoundRobinModule } from './RoundRobin'
import { EngineModule } from './Engine'
import { ExpressionModule } from './Expression'
import { FrictionModule } from './Friction'
import { ScrapeModule } from './Scrape'
import { SubharmonicModule } from './Subharmonic'
import { ReverseModule } from './Reverse'
import { ShimmerModule } from './Shimmer'
import { HowlModule } from './Howl'
import { SpringMassModule } from './SpringMass'
import { BitcrushModule } from './Bitcrush'
import { BurstModule } from './Burst'
import { BusInModule } from './BusIn'
import { TrackInModule } from './TrackIn'
import { ClipsModule } from './Clips'
import { ChordModule } from './Chord'
import { ChorusModule } from './Chorus'
import { ClockModule } from './Clock'
import { ClockDivModule } from './ClockDiv'
import { CompressorModule } from './Compressor'
import { ConvolveModule } from './Convolve'
import { CvUtilModule } from './CvUtil'
import { DelayModule } from './Delay'
import { DriveModule } from './Drive'
import { DrunkModule } from './Drunk'
import { DustModule } from './Dust'
import { EqModule } from './Eq'
import { FollowerModule } from './Follower'
import { FormantModule } from './Formant'
import { GateModule } from './Gate'
import { GranularModule } from './Granular'
import { KeysModule } from './Keys'
import { KitModule } from './Kit'
import { LadderModule } from './Ladder'
import { LfoModule } from './Lfo'
import { LpgModule } from './Lpg'
import { MacroModule } from './Macro'
import { MixerModule } from './Mixer'
import { NoiseModule } from './Noise'
import { OrganModule } from './Organ'
import { OscModule } from './Osc'
import { QuantizerModule } from './Quantizer'
import { RecorderModule } from './Recorder'
import { ResonatorModule } from './Resonator'
import { ReverbModule } from './Reverb'
import { RingModModule } from './RingMod'
import { RotaryModule } from './Rotary'
import { SampleHoldModule } from './SampleHold'
import { SamplerModule } from './Sampler'
import { ScopeModule } from './Scope'
import { SeqModule } from './Seq'
import { ShepardModule } from './Shepard'
import { SlewModule } from './Slew'
import { SplitModule } from './Split'
import { SpringModule } from './Spring'
import { SvfModule } from './Svf'
import { TapeModule } from './Tape'
import type { DspModule, ModuleContext } from './types'
import { UnisonModule } from './Unison'
import { VcaModule } from './Vca'
import { VoiceModule } from './Voice'
import { WavefoldModule } from './Wavefold'

type Factory = (ctx: ModuleContext) => DspModule

/** Module type to DSP implementation. Keys must match `MODULE_DEFS`. */
export const MODULE_FACTORIES: Record<string, Factory> = {
  gate: (c) => new GateModule(c),
  osc: (c) => new OscModule(c),
  sampler: (c) => new SamplerModule(c),
  voice: (c) => new VoiceModule(c),
  keys: (c) => new KeysModule(c),
  kit: (c) => new KitModule(c),
  noise: (c) => new NoiseModule(c),
  dust: (c) => new DustModule(c),
  lfo: (c) => new LfoModule(c),
  adsr: (c) => new AdsrModule(c),
  sh: (c) => new SampleHoldModule(c),
  drunk: (c) => new DrunkModule(c),
  clock: (c) => new ClockModule(c),
  chord: (c) => new ChordModule(c),
  burst: (c) => new BurstModule(c),
  seq: (c) => new SeqModule(c),
  macro: (c) => new MacroModule(c),
  slew: (c) => new SlewModule(c),
  follow: (c) => new FollowerModule(c),
  unison: (c) => new UnisonModule(c),
  organ: (c) => new OrganModule(c),
  shepard: (c) => new ShepardModule(c),
  clkdiv: (c) => new ClockDivModule(c),
  lpg: (c) => new LpgModule(c),
  tape: (c) => new TapeModule(c),
  quant: (c) => new QuantizerModule(c),
  cv: (c) => new CvUtilModule(c),
  ladder: (c) => new LadderModule(c),
  svf: (c) => new SvfModule(c),
  formant: (c) => new FormantModule(c),
  vca: (c) => new VcaModule(c),
  eq: (c) => new EqModule(c),
  split: (c) => new SplitModule(c),
  drive: (c) => new DriveModule(c),
  fold: (c) => new WavefoldModule(c),
  ring: (c) => new RingModModule(c),
  crush: (c) => new BitcrushModule(c),
  comp: (c) => new CompressorModule(c),
  gran: (c) => new GranularModule(c),
  delay: (c) => new DelayModule(c),
  chorus: (c) => new ChorusModule(c),
  rotary: (c) => new RotaryModule(c),
  reverb: (c) => new ReverbModule(c),
  spring: (c) => new SpringModule(c),
  convolve: (c) => new ConvolveModule(c),
  res: (c) => new ResonatorModule(c),
  busin: (c) => new BusInModule(c),
  trackin: (c) => new TrackInModule(c),
  clips: (c) => new ClipsModule(c),
  bubble: (c) => new BubbleModule(c),
  chip: (c) => new ChipModule(c),
  robin: (c) => new RoundRobinModule(c),
  bounce: (c) => new BounceModule(c),
  doppler: (c) => new DopplerModule(c),
  seam: (c) => new LoopSeamModule(c),
  engine: (c) => new EngineModule(c),
  friction: (c) => new FrictionModule(c),
  scrape: (c) => new ScrapeModule(c),
  mass: (c) => new SpringMassModule(c),
  expr: (c) => new ExpressionModule(c),
  sub: (c) => new SubharmonicModule(c),
  howl: (c) => new HowlModule(c),
  reverse: (c) => new ReverseModule(c),
  shimmer: (c) => new ShimmerModule(c),
  mixer: (c) => new MixerModule(c),
  scope: (c) => new ScopeModule(c),
  rec: (c) => new RecorderModule(c),
}

export type { DspModule, ModuleContext }
