/**
 * General MIDI's 128 programs, each with the library voice nearest to it, for
 * giving a track brought in from a MIDI file something like the sound it was
 * written for. Only a starting point: the library has no acoustic piano, for
 * one, and an overdriven guitar is a screaming lead here. Channel 10 is the
 * drums whatever its program says; see `GM_DRUMS`.
 */

/** The voice for each program, by library id: eight to a family, in General MIDI's order. */
const VOICES: readonly string[] = [
  // Piano
  'synthpiano', 'synthpiano', 'synthpiano', 'synthpiano', 'epiano', 'epiano', 'harpsichord', 'clavinet',
  // Chromatic percussion
  'celesta', 'glockenspiel', 'musicbox', 'vibraphone', 'marimba', 'xylophone', 'tubularbell', 'gamelan',
  // Organ
  'organ', 'organ', 'organ', 'organ', 'reedpiano', 'accordion', 'harmonica', 'accordion',
  // Guitar
  'guitar', 'steelguitar', 'guitar', 'guitar', 'mutedguitar', 'screamer', 'screamer', 'guitar',
  // Bass
  'uprightbass', 'pluckbass', 'pluckbass', 'uprightbass', 'pluckbass', 'pluckbass', 'synthbass', 'acidbass',
  // Strings
  'strings', 'strings', 'cello', 'cello', 'strings', 'pizzicato', 'harp', 'timpani',
  // Ensemble
  'strings', 'strings', 'stringmachine', 'stringmachine', 'choir', 'choir', 'vowellead', 'brass',
  // Brass
  'trumpet', 'brass', 'tuba', 'trumpet', 'horn', 'brass', 'brass', 'brass',
  // Reed
  'saxophone', 'saxophone', 'saxophone', 'saxophone', 'oboe', 'oboe', 'clarinet', 'clarinet',
  // Pipe
  'flute', 'flute', 'flute', 'panflute', 'panflute', 'flute', 'whistle', 'flute',
  // Synth lead
  'squarelead', 'sawlead', 'chiplead', 'chiplead', 'synclead', 'vowellead', 'supersaw', 'sawlead',
  // Synth pad
  'shimmerpad', 'warmpad', 'sweeppad', 'choir', 'glasspad', 'evolvingpad', 'shimmerpad', 'sweeppad',
  // Synth effects
  'glasspad', 'evolvingpad', 'glasspad', 'shimmerpad', 'glasspad', 'evolvingpad', 'shimmerpad', 'evolvingpad',
  // Ethnic
  'sitar', 'banjo', 'koto', 'koto', 'kalimba', 'accordion', 'strings', 'oboe',
  // Percussive
  'handbell', 'cowbell', 'steeldrum', 'woodblock', 'tom', 'tom', 'tom', 'crash',
  // Sound effects
  'swish', 'swish', 'swish', 'whistle', 'uitick', 'teleport', 'swish', 'punch',
]

/** General MIDI's own names for the programs, for naming a track the file left unnamed. */
const NAMES: readonly string[] = [
  'Acoustic Grand Piano', 'Bright Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Nylon Guitar', 'Steel Guitar', 'Jazz Guitar', 'Clean Guitar', 'Muted Guitar', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Finger Bass', 'Pick Bass', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Square Lead', 'Saw Lead', 'Calliope Lead', 'Chiff Lead', 'Charang Lead', 'Voice Lead', 'Fifths Lead', 'Bass and Lead',
  'New Age Pad', 'Warm Pad', 'Polysynth Pad', 'Choir Pad', 'Bowed Pad', 'Metallic Pad', 'Halo Pad', 'Sweep Pad',
  'Rain', 'Soundtrack', 'Crystal', 'Atmosphere', 'Brightness', 'Goblins', 'Echoes', 'Sci-fi',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
]

/** The library's whole General MIDI kit, for channel 10. */
export const GM_DRUMS = 'drumkit'
/** A track with no program change: General MIDI's first program, a piano. */
export const GM_DEFAULT_PROGRAM = 0

export function gmVoice(program: number): string {
  return VOICES[program & 0x7f] ?? VOICES[0]
}

export function gmName(program: number): string {
  return NAMES[program & 0x7f] ?? NAMES[0]
}
