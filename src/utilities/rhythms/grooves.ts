/**
 * Drum-kit grooves for the Rhythm library: rock, funk and soul, hip-hop,
 * electronic, Caribbean and Afro-pop, and jazz.
 *
 * Each is the recognisable core of a style, not a finished part: the kick,
 * the backbeat and the timekeeping that tell a player which style it is.
 * Swing, laziness and push are timing, not placement, so where a style lives
 * on them the description says so and the steps stay straight.
 */

import type { LibraryRhythm } from '../rhythmLibrary'

export const GROOVES: LibraryRhythm[] = [
  // ---------------------------------------------------------------- rock & pop
  {
    id: 'rock-beat', name: 'Rock beat', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 2,
    description: 'Kick on one and three, snare on two and four, eighth hats: where most songs start',
    lanes: [
      { note: 36, pattern: 'x...x...' },
      { note: 38, pattern: '..X...X.' },
      { note: 42, pattern: 'xxxxxxxx' },
    ],
  },
  {
    id: 'rock-eighths', name: 'Rock, eighth hats', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'The everyday rock beat with a kick on the and of two pushing into three',
    lanes: [
      { note: 36, pattern: 'x.....x.x.......' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'rock-sixteenths', name: 'Rock, sixteenth hats', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Sixteenth hats leaning on the beat, a kick pickup on the a of two into three',
    lanes: [
      { note: 36, pattern: 'x......xx.......' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'XxxxXxxxXxxxXxxx' },
    ],
  },
  {
    id: 'rock-ride', name: 'Rock on the ride', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Eighths on the ride for the big chorus, hat foot on two and four',
    lanes: [
      { note: 36, pattern: 'x.......x.x.....' },
      { note: 38, pattern: '....X.......X...' },
      { note: 51, pattern: 'x.x.x.x.x.x.x.x.' },
      { note: 42, pattern: '....x.......x...' },
    ],
  },
  {
    id: 'rock-half-time', name: 'Half-time rock', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'One snare a bar, on three: the heavy bridge or the slow verse',
    lanes: [
      { note: 36, pattern: 'x.....x...x.....' },
      { note: 38, pattern: '........X.......' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'punk-double-time', name: 'Double-time punk', kind: 'groove', category: 'rock', origin: 'US / UK', meter: '4/4', perBeat: 2,
    description: 'Kick on the beat, snare on every and, open hats on every eighth: the fast oom-pah of hardcore and skate punk',
    lanes: [
      { note: 36, pattern: 'x.x.x.x.' },
      { note: 38, pattern: '.X.X.X.X' },
      { note: 46, pattern: 'xxxxxxxx' },
    ],
  },
  {
    id: 'pop-punk', name: 'Pop punk', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Doubled kicks on one and three under a crash-ride on eighths, played fast and straight',
    lanes: [
      { note: 36, pattern: 'x.x.....x.x.....' },
      { note: 38, pattern: '....X.......X...' },
      { note: 51, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'rock-four-floor', name: 'Four-on-the-floor rock', kind: 'groove', category: 'rock', origin: 'UK / US', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat under a rock backbeat: glam stomp and dance-rock',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'hambone-beat', name: 'Hambone beat', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'The 3-2 clave on floor tom under shaken maracas: the shave-and-a-haircut rhythm of fifties rock and roll',
    lanes: [
      { note: 45, pattern: 'X..x..x...X.x...' },
      { note: 36, pattern: 'x.......x.......' },
      { note: 70, pattern: 'XxxxXxxxXxxxXxxx' },
    ],
  },
  {
    id: 'sixties-backbeat', name: 'Sixties backbeat', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Snare doubled by tambourine on two and four, eighth hats: beat-group pop',
    lanes: [
      { note: 36, pattern: 'x.....x.x.......' },
      { note: 38, pattern: '....X.......X...' },
      { note: 54, pattern: '....x.......x...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'train-beat', name: 'Train beat', kind: 'groove', category: 'rock', origin: 'US (Nashville)', meter: '4/4', perBeat: 4,
    description: 'Sixteenths on the snare, quiet but for two and four, kick on one and three: country and rockabilly rolling along',
    lanes: [
      { note: 36, pattern: 'x.......x.......' },
      { note: 38, pattern: 'ggggXgggggggXggg' },
      { note: 42, pattern: '....x.......x...' },
    ],
  },
  {
    id: 'tom-groove', name: 'Tom groove', kind: 'groove', category: 'rock', origin: 'UK', meter: '4/4', perBeat: 4,
    description: 'Floor toms in the Burundi-style tumble, accent and two quick strokes, instead of hats and backbeat',
    lanes: [
      { note: 36, pattern: 'x.......x.......' },
      { note: 45, pattern: 'X.xxX.x.X.xxX.x.' },
      { note: 38, pattern: '....x.......x...' },
    ],
  },
  {
    id: 'surf-beat', name: 'Surf beat', kind: 'groove', category: 'rock', origin: 'US (California)', meter: '4/4', perBeat: 4,
    description: 'Sixteenths on the floor tom accented on the beat, kick on all four, snare cracking two and four',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '....X.......X...' },
      { note: 45, pattern: 'XxxxXxxxXxxxXxxx' },
    ],
  },
  {
    id: 'rock-ballad-12-8', name: 'Rock ballad, 12/8', kind: 'groove', category: 'rock', origin: 'US', meter: '12/8', perBeat: 3,
    description: 'Hats in triplets, the beat accented, snare on two and four, a kick pickup into three',
    lanes: [
      { note: 36, pattern: 'x....xx.....' },
      { note: 38, pattern: '...X.....X..' },
      { note: 42, pattern: 'XxxXxxXxxXxx' },
    ],
  },
  {
    id: 'rock-shuffle', name: 'Shuffle rock', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 3,
    description: 'Long-short hats on the triplet grid, kick on one and three, backbeat on two and four: boogie and blues-rock',
    lanes: [
      { note: 36, pattern: 'x.....x.....' },
      { note: 38, pattern: '...X.....X..' },
      { note: 42, pattern: 'x.xx.xx.xx.x' },
    ],
  },
  {
    id: 'rockabilly', name: 'Rockabilly', kind: 'groove', category: 'rock', origin: 'US (Memphis)', meter: '4/4', perBeat: 3,
    description: 'The shuffle played on the snare itself, slapping two and four, kick on one and three',
    lanes: [
      { note: 36, pattern: 'x.....x.....' },
      { note: 38, pattern: 'g.gX.gg.gX.g' },
    ],
  },
  {
    id: 'disco-rock', name: 'Disco-rock', kind: 'groove', category: 'rock', origin: 'US / UK', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat, open hat on every and, closed sixteenths between',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'xx.xxx.xxx.xxx.x' },
      { note: 46, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'pop-ballad', name: 'Pop ballad', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Side stick on two and four, soft eighth hats, kick on one and the and of three',
    lanes: [
      { note: 36, pattern: 'x.........x.....' },
      { note: 37, pattern: '....x.......x...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'power-ballad', name: 'Power ballad', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'The chorus lift: quarters on the ride, a huge snare on two and four, crash on one',
    lanes: [
      { note: 36, pattern: 'x.......x.x.....' },
      { note: 38, pattern: '....X.......X...' },
      { note: 51, pattern: '....x...x...x...' },
      { note: 49, pattern: 'X...............' },
    ],
  },
  {
    id: 'new-wave', name: 'New wave', kind: 'groove', category: 'rock', origin: 'UK', meter: '4/4', perBeat: 4,
    description: 'Machine-straight sixteenth hats leaning on the ands over a kick on every beat',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'xxXxxxXxxxXxxxXx' },
    ],
  },
  {
    id: 'post-punk', name: 'Post-punk', kind: 'groove', category: 'rock', origin: 'UK (Manchester)', meter: '4/4', perBeat: 4,
    description: 'Eighths on the floor tom instead of hats, a dry snare, the kick tight to the beat',
    lanes: [
      { note: 36, pattern: 'x.......x.x.....' },
      { note: 38, pattern: '....X.......X...' },
      { note: 45, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'motorik', name: 'Motorik', kind: 'groove', category: 'rock', origin: 'Germany', meter: '4/4', perBeat: 4,
    description: 'The krautrock autobahn beat: kick on one, three and the and of three, eighth hats that never change',
    lanes: [
      { note: 36, pattern: 'x.......x.x.....' },
      { note: 38, pattern: '....x.......x...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
      { note: 54, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'stomp-clap', name: 'Stomp-stomp-clap', kind: 'groove', category: 'rock', origin: 'US / UK', meter: '4/4', perBeat: 4,
    description: 'Two stomps and a clap, twice a bar, for a stadium or a folk-pop chorus',
    lanes: [
      { note: 36, pattern: 'X.x.....X.x.....' },
      { note: 39, pattern: '....X.......X...' },
    ],
  },
  {
    id: 'blast-beat', name: 'Blast beat', kind: 'groove', category: 'rock', origin: 'UK / US', meter: '4/4', perBeat: 4,
    description: 'Kick and cymbal on every downstroke, snare on every upstroke, as fast as it goes',
    lanes: [
      { note: 36, pattern: 'x.x.x.x.x.x.x.x.' },
      { note: 38, pattern: '.x.x.x.x.x.x.x.x' },
      { note: 51, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'd-beat', name: 'D-beat', kind: 'groove', category: 'rock', origin: 'UK', meter: '4/4', perBeat: 2,
    description: 'Kick, snare, kick-kick, snare, under open hats on every eighth: crust and hardcore',
    lanes: [
      { note: 36, pattern: 'x..xx...' },
      { note: 38, pattern: '..X...X.' },
      { note: 46, pattern: 'xxxxxxxx' },
    ],
  },
  {
    id: 'gallop', name: 'Gallop', kind: 'groove', category: 'rock', origin: 'UK', meter: '4/4', perBeat: 4,
    description: 'An eighth and two sixteenths on the kick, every beat: heavy metal at a canter',
    lanes: [
      { note: 36, pattern: 'x.xxx.xxx.xxx.xx' },
      { note: 38, pattern: '....X.......X...' },
      { note: 49, pattern: 'x...x...x...x...' },
    ],
  },
  {
    id: 'breakdown', name: 'Breakdown', kind: 'groove', category: 'rock', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Half-time metalcore breakdown: kick with the riff, one snare on three, china-style crash on the beat',
    lanes: [
      { note: 36, pattern: 'x..x..x...x.x...' },
      { note: 38, pattern: '........X.......' },
      { note: 49, pattern: 'x...x...x...x...' },
    ],
  },

  // ---------------------------------------------------------------- funk & soul
  {
    id: 'funk-ghost-notes', name: 'Funk with ghost notes', kind: 'groove', category: 'funk', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Sixteenth hats, the backbeat hard, quiet snare strokes filling around it, kick syncopated',
    lanes: [
      { note: 36, pattern: 'x.x.......x..x..' },
      { note: 38, pattern: '....X..g.g..X..g' },
      { note: 42, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'linear-funk', name: 'Linear funk', kind: 'groove', category: 'funk', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Never two limbs at once: hats, kick and snare take turns through every sixteenth',
    lanes: [
      { note: 36, pattern: 'x..x...x.x....x.' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: '.xx..xx.x.xx.x.x' },
    ],
  },
  {
    id: 'open-hat-break', name: 'Open-hat break', kind: 'groove', category: 'funk', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'The much-sampled late-sixties break feel: ghosted snare all round the backbeat, hats opening on the a of two and the and of four',
    lanes: [
      { note: 36, pattern: 'x.x...x...x.....' },
      { note: 38, pattern: '....X..g.g.gX..g' },
      { note: 42, pattern: 'xxxxxxx.xxxxxx.x' },
      { note: 46, pattern: '.......x......x.' },
    ],
  },
  {
    id: 'funk-on-the-one', name: 'On the one', kind: 'groove', category: 'funk', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Everything lands hard on one, then the bar is left to the hats and a few kicks',
    lanes: [
      { note: 36, pattern: 'X.....x...x.x...' },
      { note: 38, pattern: '....X..g.g..X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
      { note: 49, pattern: 'X...............' },
    ],
  },
  {
    id: 'half-time-shuffle', name: 'Half-time shuffle', kind: 'groove', category: 'funk', origin: 'US', meter: '4/4', perBeat: 3,
    description: 'Ghost notes on the middle triplet of each beat, one backbeat on three, hats long-short: the studio half-time shuffle',
    lanes: [
      { note: 36, pattern: 'x....x..x...' },
      { note: 38, pattern: '.g..g.X...g.' },
      { note: 42, pattern: 'x.xx.xx.xx.x' },
    ],
  },
  {
    id: 'second-line-funk', name: 'Second-line funk', kind: 'groove', category: 'funk', origin: 'US (New Orleans)', meter: '4/4', perBeat: 4,
    description: 'Parade snare on a funk kit: ghosted strokes everywhere, accents on the and of two and on four, kick in dotted pairs',
    lanes: [
      { note: 36, pattern: 'x..x....x..x....' },
      { note: 38, pattern: 'g.ggg.X.g.ggX.g.' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'new-orleans-funk', name: 'New Orleans funk', kind: 'groove', category: 'funk', origin: 'US (New Orleans)', meter: '4/4', perBeat: 4,
    description: 'Kick and snare trading syncopations, open hat on the and of four, everything slightly behind',
    lanes: [
      { note: 36, pattern: 'x..x..x.......x.' },
      { note: 38, pattern: '....X..x.g..X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x...' },
      { note: 46, pattern: '..............x.' },
    ],
  },
  {
    id: 'go-go', name: 'Go-go', kind: 'groove', category: 'funk', origin: 'US (Washington, DC)', meter: '4/4', perBeat: 4,
    description: 'The pocket, played swung: congas answering the kit, open hat on the and of four, cowbell on the beat',
    lanes: [
      { note: 36, pattern: 'x......x..x.....' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x...' },
      { note: 46, pattern: '..............x.' },
      { note: 63, pattern: '..x..x.x..x..x.x' },
      { note: 56, pattern: 'x...x...x...x...' },
    ],
  },
  {
    id: 'motown', name: 'Motown', kind: 'groove', category: 'funk', origin: 'US (Detroit)', meter: '4/4', perBeat: 4,
    description: 'Snare on all four beats with tambourine doubling two and four, kick in dotted pairs underneath',
    lanes: [
      { note: 36, pattern: 'x.....x.x.....x.' },
      { note: 38, pattern: 'x...X...x...X...' },
      { note: 54, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'northern-soul', name: 'Northern soul', kind: 'groove', category: 'funk', origin: 'US / UK', meter: '4/4', perBeat: 4,
    description: 'Fast stomper: kick and snare on every beat, tambourine on every eighth',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: 'x...X...x...X...' },
      { note: 54, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'stax-soul', name: 'Southern soul', kind: 'groove', category: 'funk', origin: 'US (Memphis)', meter: '4/4', perBeat: 4,
    description: 'Plain and heavy: a fat, late backbeat with tambourine on it, kick on one and three',
    lanes: [
      { note: 36, pattern: 'x.......x.......' },
      { note: 38, pattern: '....X.......X...' },
      { note: 54, pattern: '....x.......x...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'soul-ballad-12-8', name: 'Soul ballad, 12/8', kind: 'groove', category: 'funk', origin: 'US', meter: '12/8', perBeat: 3,
    description: 'Ride in triplets, side stick on two and four, the kick walking into each half',
    lanes: [
      { note: 36, pattern: 'x.x...x.x...' },
      { note: 37, pattern: '...X.....X..' },
      { note: 51, pattern: 'xxxxxxxxxxxx' },
    ],
  },
  {
    id: 'disco', name: 'Disco', kind: 'groove', category: 'funk', origin: 'US (New York)', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat, open hat on every and, snare on two and four, congas between',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '....X.......X...' },
      { note: 46, pattern: '..x...x...x...x.' },
      { note: 42, pattern: 'x...x...x...x...' },
      { note: 63, pattern: '...x..x....x..x.' },
    ],
  },
  {
    id: 'philly-soul', name: 'Philly soul', kind: 'groove', category: 'funk', origin: 'US (Philadelphia)', meter: '4/4', perBeat: 4,
    description: 'Smooth four on the floor: sixteenth hats opening on the and, tambourine on eighths, ghosts round the snare',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '....X..g....X...' },
      { note: 42, pattern: 'xx.xxx.xxx.xxx.x' },
      { note: 46, pattern: '..x...x...x...x.' },
      { note: 54, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'neo-soul', name: 'Neo-soul', kind: 'groove', category: 'funk', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Lazy and late: rimshot on two and four, ghosted hats, the kick dragging behind the beat',
    lanes: [
      { note: 36, pattern: 'x......x..x.....' },
      { note: 37, pattern: '....X.......X...' },
      { note: 42, pattern: 'xgxgxgxgxgxgxgxg' },
    ],
  },
  {
    id: 'gospel-chops', name: 'Gospel chops', kind: 'groove', category: 'funk', origin: 'US', meter: '4/4', perBeat: 6,
    description: 'Sixteenth-triplet runs, four hand strokes and two kicks a beat, moving between snare and toms',
    lanes: [
      { note: 38, pattern: 'Xgxg........Xgxg........' },
      { note: 45, pattern: '......xxxx........xxxx..' },
      { note: 36, pattern: '....xx....xx....xx....xx' },
    ],
  },

  // ---------------------------------------------------------------- hip-hop & trap
  {
    id: 'boom-bap', name: 'Boom bap', kind: 'groove', category: 'hiphop', origin: 'US (New York)', meter: '4/4', perBeat: 4,
    description: 'Kick on one, a late kick around three, a hard snare on two and four, eighth hats swung by feel',
    lanes: [
      { note: 36, pattern: 'x......x..x.....' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'boom-bap-chopped', name: 'Boom bap, chopped break', kind: 'groove', category: 'hiphop', origin: 'US (New York)', meter: '4/4', perBeat: 4,
    description: 'A break cut up: doubled kick on one, two kicks after three, a ghost before the second snare',
    lanes: [
      { note: 36, pattern: 'x.x.......xx....' },
      { note: 38, pattern: '....X......gX...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x...' },
      { note: 46, pattern: '..............x.' },
    ],
  },
  {
    id: 'golden-era', name: 'Golden era', kind: 'groove', category: 'hiphop', origin: 'US (New York)', meter: '4/4', perBeat: 4,
    description: 'Two bars of late-eighties sampler drums, the kick moving in the second, open hat to turn it round',
    lanes: [
      { note: 36, pattern: 'x......x.x......x......x..x..x..' },
      { note: 38, pattern: '....X.......X.......X.......X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x...' },
      { note: 46, pattern: '..............................x.' },
    ],
  },
  {
    id: 'jazz-rap', name: 'Jazz rap', kind: 'groove', category: 'hiphop', origin: 'US (New York)', meter: '4/4', perBeat: 4,
    description: 'Soft kick, side stick for a snare, a ride keeping eighths: the bookish nineties loop',
    lanes: [
      { note: 36, pattern: 'x......x.x......' },
      { note: 37, pattern: '....X.......X...' },
      { note: 51, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'lo-fi', name: 'Lo-fi', kind: 'groove', category: 'hiphop', origin: 'Internet', meter: '4/4', perBeat: 4,
    description: 'Dusty and lazy: rim on two and four, quiet hats, kick wandering, everything a little late',
    lanes: [
      { note: 36, pattern: 'x......x..x...x.' },
      { note: 37, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.g.x.g.x.g.x.g.' },
      { note: 70, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'g-funk', name: 'G-funk', kind: 'groove', category: 'hiphop', origin: 'US (Los Angeles)', meter: '4/4', perBeat: 4,
    description: 'Laid-back West Coast: clap with the snare, sixteenth hats, a rolling kick',
    lanes: [
      { note: 36, pattern: 'x.....x...x..x..' },
      { note: 38, pattern: '....X.......X...' },
      { note: 39, pattern: '....x.......x...' },
      { note: 42, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'trap', name: 'Trap', kind: 'groove', category: 'hiphop', origin: 'US (Atlanta)', meter: '4/4', perBeat: 4,
    description: 'Clap on three in half time, sparse 808 kicks, sixteenth hats rolling into thirty-seconds on four',
    lanes: [
      { note: 36, pattern: 'x......x......x.' },
      { note: 39, pattern: '........X.......' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.x.x.x.x.xxxxx.x.', perBeat: 8 },
    ],
  },
  {
    id: 'trap-triplets', name: 'Trap, triplet hats', kind: 'groove', category: 'hiphop', origin: 'US (Atlanta)', meter: '4/4', perBeat: 4,
    description: 'Half-time clap on three, triplet hats with a sixteenth-triplet roll into the next bar',
    lanes: [
      { note: 36, pattern: 'x.........x.....' },
      { note: 39, pattern: '........X.......' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.x.xxxxxx', perBeat: 6 },
    ],
  },
  {
    id: 'half-time-808', name: 'Half-time 808', kind: 'groove', category: 'hiphop', origin: 'US', meter: '4/4', perBeat: 4,
    description: 'Two bars with room in them: long 808 kicks, a clap on three, eighth hats',
    lanes: [
      { note: 36, pattern: 'x.........x.....x..x............' },
      { note: 39, pattern: '........X...............X.......' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'uk-drill', name: 'UK drill', kind: 'groove', category: 'hiphop', origin: 'UK (London)', meter: '4/4', perBeat: 4,
    description: 'Snare on three, then early in the second bar and again on four; triplet hats skipping; sliding 808s',
    lanes: [
      { note: 36, pattern: 'x.....x...........x.....x.......' },
      { note: 38, pattern: '........X..............X....x...' },
      { note: 42, pattern: 'xx.xx.xxx.xx', perBeat: 3 },
    ],
  },
  {
    id: 'ny-drill', name: 'NY drill', kind: 'groove', category: 'hiphop', origin: 'US (New York)', meter: '4/4', perBeat: 4,
    description: 'Bouncier drill: kick in dotted pairs, snare on three with a pickup, hats in triplets with gaps',
    lanes: [
      { note: 36, pattern: 'x..x......x..x..' },
      { note: 38, pattern: '........X.....x.' },
      { note: 42, pattern: 'x.x.x.x..xx.x.x.x.x..xx.', perBeat: 6 },
    ],
  },
  {
    id: 'memphis-rap', name: 'Memphis rap', kind: 'groove', category: 'hiphop', origin: 'US (Memphis)', meter: '4/4', perBeat: 4,
    description: 'Dark and slow: 808 kick in a tresillo, cowbell on top, triplet hats',
    lanes: [
      { note: 36, pattern: 'x..x..x...x.....' },
      { note: 39, pattern: '....X.......X...' },
      { note: 56, pattern: 'x..x..x.x..x..x.' },
      { note: 42, pattern: 'x.xx.xx.xx.x', perBeat: 3 },
    ],
  },
  {
    id: 'phonk', name: 'Phonk', kind: 'groove', category: 'hiphop', origin: 'Internet', meter: '4/4', perBeat: 4,
    description: 'Memphis cowbell over half-time drums: clap on three, busy sixteenth hats',
    lanes: [
      { note: 36, pattern: 'x.....xx......x.' },
      { note: 39, pattern: '........X.......' },
      { note: 56, pattern: 'x..x..x...x..x..' },
      { note: 42, pattern: 'x.xxx.xxx.xxx.xx' },
    ],
  },
  {
    id: 'crunk', name: 'Crunk', kind: 'groove', category: 'hiphop', origin: 'US (Atlanta)', meter: '4/4', perBeat: 4,
    description: 'Huge kicks and a clap on two and four, nothing subtle',
    lanes: [
      { note: 36, pattern: 'X.....x.X.......' },
      { note: 39, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'jersey-club', name: 'Jersey club', kind: 'groove', category: 'hiphop', origin: 'US (Newark)', meter: '4/4', perBeat: 4,
    description: 'Kick on one, two and three, then a run of triplet kicks on four; claps on two and four',
    lanes: [
      { note: 36, pattern: 'x..x..x..xxx', perBeat: 3 },
      { note: 39, pattern: '....X.......X...' },
      { note: 42, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'dirty-south-bounce', name: 'Southern bounce', kind: 'groove', category: 'hiphop', origin: 'US (South)', meter: '4/4', perBeat: 4,
    description: 'Club rap at a strut: snare and clap on two and four, kick hitting the and, sixteenth hats',
    lanes: [
      { note: 36, pattern: 'x.x...x...x...x.' },
      { note: 38, pattern: '....X.......X...' },
      { note: 39, pattern: '....x.......x...' },
      { note: 42, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },

  // ---------------------------------------------------------------- electronic
  {
    id: 'four-on-the-floor', name: 'Four on the floor', kind: 'groove', category: 'electronic', origin: 'US (Chicago)', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat, clap on two and four, hats between',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 39, pattern: '....x.......x...' },
      { note: 42, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'house', name: 'House', kind: 'groove', category: 'electronic', origin: 'US (Chicago)', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat, clap on two and four, open hat on the ands, shaker running sixteenths',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 39, pattern: '....X.......X...' },
      { note: 46, pattern: '..x...x...x...x.' },
      { note: 70, pattern: 'xxXxxxXxxxXxxxXx' },
    ],
  },
  {
    id: 'jacking-house', name: 'Jacking house', kind: 'groove', category: 'electronic', origin: 'US (Chicago)', meter: '4/4', perBeat: 4,
    description: 'Drum-machine house: sixteenth hats with accents on the ands, clap on two and four, an open hat to end the bar',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 39, pattern: '....X.......X...' },
      { note: 42, pattern: 'xxXxxxXxxxXxxx.x' },
      { note: 46, pattern: '..............x.' },
    ],
  },
  {
    id: 'deep-house', name: 'Deep house', kind: 'groove', category: 'electronic', origin: 'US (Chicago / New York)', meter: '4/4', perBeat: 4,
    description: 'Soft kick on the beat, a gentle clap, rim shots off the grid, closed hats on the ands',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 39, pattern: '....x.......x...' },
      { note: 37, pattern: '...x.......x..x.' },
      { note: 42, pattern: '..x...x...x...x.' },
      { note: 70, pattern: 'x.xxx.xxx.xxx.xx' },
    ],
  },
  {
    id: 'tech-house', name: 'Tech house', kind: 'groove', category: 'electronic', origin: 'UK', meter: '4/4', perBeat: 4,
    description: 'Tight four on the floor, sixteenth hats, a shuffled rim and open hat on the ands',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 39, pattern: '....X.......X...' },
      { note: 42, pattern: 'xx.xxx.xxx.xxx.x' },
      { note: 46, pattern: '..x...x...x...x.' },
      { note: 37, pattern: '.......x..x....x' },
    ],
  },
  {
    id: 'afro-house', name: 'Afro house', kind: 'groove', category: 'electronic', origin: 'South Africa', meter: '4/4', perBeat: 4,
    description: 'Four on the floor under congas and shaker, a rim playing a three-three-two',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 63, pattern: '..x..x.x..x..x.x' },
      { note: 37, pattern: 'x..x..x.x..x..x.' },
      { note: 70, pattern: 'xxXxxxXxxxXxxxXx' },
      { note: 46, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'techno', name: 'Techno', kind: 'groove', category: 'electronic', origin: 'US (Detroit) / Germany', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat, open hat on the ands, closed sixteenths around it, a clap on two and four',
    lanes: [
      { note: 36, pattern: 'X...X...X...X...' },
      { note: 39, pattern: '....x.......x...' },
      { note: 46, pattern: '..x...x...x...x.' },
      { note: 42, pattern: 'xx.xxx.xxx.xxx.x' },
    ],
  },
  {
    id: 'detroit-techno', name: 'Detroit techno', kind: 'groove', category: 'electronic', origin: 'US (Detroit)', meter: '4/4', perBeat: 4,
    description: 'Drum machine soul: clap on two and four, ride on the ands, syncopated toms',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 39, pattern: '....X.......X...' },
      { note: 51, pattern: '..x...x...x...x.' },
      { note: 42, pattern: 'xxxxxxxxxxxxxxxx' },
      { note: 45, pattern: '...x..x.....x..x' },
    ],
  },
  {
    id: 'minimal-techno', name: 'Minimal', kind: 'groove', category: 'electronic', origin: 'Germany (Berlin)', meter: '4/4', perBeat: 4,
    description: 'Kick, an offbeat hat, and a rim click wandering off the grid',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 42, pattern: '..x...x...x...x.' },
      { note: 37, pattern: '.....x....x..x..' },
      { note: 70, pattern: '.x.x.x.x.x.x.x.x' },
    ],
  },
  {
    id: 'hard-techno', name: 'Hard techno', kind: 'groove', category: 'electronic', origin: 'Germany / Belgium', meter: '4/4', perBeat: 4,
    description: 'Accented kick on every beat, open hat on the ands, ride in sixteenths, clap to drive two and four',
    lanes: [
      { note: 36, pattern: 'X...X...X...X...' },
      { note: 39, pattern: '....X.......X...' },
      { note: 46, pattern: '..x...x...x...x.' },
      { note: 51, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'trance', name: 'Trance', kind: 'groove', category: 'electronic', origin: 'Germany / Netherlands', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat, open hat on the ands, clap on two and four, closed hats ticking between',
    lanes: [
      { note: 36, pattern: 'X...X...X...X...' },
      { note: 39, pattern: '....x.......x...' },
      { note: 46, pattern: '..x...x...x...x.' },
      { note: 42, pattern: '.x.x.x.x.x.x.x.x' },
    ],
  },
  {
    id: 'hardstyle', name: 'Hardstyle', kind: 'groove', category: 'electronic', origin: 'Netherlands', meter: '4/4', perBeat: 4,
    description: 'The distorted kick on every beat, the offbeat left to the hat and the bass; a doubled kick to turn the second bar',
    lanes: [
      { note: 36, pattern: 'X...X...X...X...X...X...X...X.X.' },
      { note: 39, pattern: '....x.......x.......x.......x...' },
      { note: 46, pattern: '..x...x...x...x...x...x...x...x.' },
    ],
  },
  {
    id: 'electro', name: 'Electro', kind: 'groove', category: 'electronic', origin: 'US (New York)', meter: '4/4', perBeat: 4,
    description: 'An 808 two-bar: kicks broken up, a clap on two and four, sixteenth hats, cowbell',
    lanes: [
      { note: 36, pattern: 'x.....x.........x.....x...x.x...' },
      { note: 39, pattern: '....X.......X.......X.......X...' },
      { note: 42, pattern: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { note: 56, pattern: '..x.....x.x.....' },
    ],
  },
  {
    id: 'miami-bass', name: 'Miami bass', kind: 'groove', category: 'electronic', origin: 'US (Miami)', meter: '4/4', perBeat: 4,
    description: 'Booming 808 kick, clap on two and four, fast hats: the car-trunk beat',
    lanes: [
      { note: 36, pattern: 'X.....x...x.x...' },
      { note: 39, pattern: '....X.......X...' },
      { note: 42, pattern: 'xxxxxxxxxxxxxxxx' },
      { note: 56, pattern: 'x.....x.....x...' },
    ],
  },
  {
    id: 'baltimore-club', name: 'Baltimore club', kind: 'groove', category: 'electronic', origin: 'US (Baltimore)', meter: '4/4', perBeat: 4,
    description: 'Kick on one, two and three, then the a of three and the and of four; claps on top',
    lanes: [
      { note: 36, pattern: 'x...x...x..x..x.' },
      { note: 39, pattern: '....X.......X...' },
      { note: 42, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'breakbeat', name: 'Breakbeat', kind: 'groove', category: 'electronic', origin: 'UK', meter: '4/4', perBeat: 4,
    description: 'A funk break on a dance-floor tempo: doubled kick on one, the and of three, ghosts round the snare',
    lanes: [
      { note: 36, pattern: 'x.x.......x.....' },
      { note: 38, pattern: '....X..g.g..X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'big-beat', name: 'Big beat', kind: 'groove', category: 'electronic', origin: 'UK (Brighton)', meter: '4/4', perBeat: 4,
    description: 'A loud break at rock weight: snare slammed, open hat at the end of the bar, tambourine in sixteenths',
    lanes: [
      { note: 36, pattern: 'x.......x.x.....' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x...' },
      { note: 46, pattern: '..............x.' },
      { note: 54, pattern: 'xxXxxxXxxxXxxxXx' },
    ],
  },
  {
    id: 'uk-garage-2step', name: 'UK garage two-step', kind: 'groove', category: 'electronic', origin: 'UK (London)', meter: '4/4', perBeat: 4,
    description: 'The kick skips two and four, the snare holds them; shuffled hats, heavy swing by feel',
    lanes: [
      { note: 36, pattern: 'x.........x.....x......x..x.....' },
      { note: 38, pattern: '....X.......X.......X.......X...' },
      { note: 42, pattern: '..x...x...x...x...x...x...x...x.' },
      { note: 70, pattern: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'uk-garage-4x4', name: 'UK garage four-four', kind: 'groove', category: 'electronic', origin: 'UK (London)', meter: '4/4', perBeat: 4,
    description: 'Speed garage: kick on every beat, snare with a pickup, open hat on the ands, swung shaker',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '....X..x....X...' },
      { note: 46, pattern: '..x...x...x...x.' },
      { note: 70, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'dnb-two-step', name: 'Drum & bass two-step', kind: 'groove', category: 'electronic', origin: 'UK', meter: '4/4', perBeat: 4,
    description: 'Kick on one and the and of three, snare on two and four, at 170',
    lanes: [
      { note: 36, pattern: 'x.........x.....' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'dnb-roller', name: 'Drum & bass roller', kind: 'groove', category: 'electronic', origin: 'UK', meter: '4/4', perBeat: 4,
    description: 'The two-step with ghost snares rolling around it and a ride on the ands',
    lanes: [
      { note: 36, pattern: 'x.........x.....' },
      { note: 38, pattern: '....X..g.g..X..g' },
      { note: 51, pattern: '..x...x...x...x.' },
      { note: 70, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'amen-chop', name: 'Amen-style chop', kind: 'groove', category: 'electronic', origin: 'UK', meter: '4/4', perBeat: 4,
    description: 'The most famous break, two bars: kick-kick, snare, snare-snare; the second bar holds back the last snare',
    lanes: [
      { note: 36, pattern: 'x.x.......xx....x.x.......x.....' },
      { note: 38, pattern: '....X..x.x..X..x....X..x.x....X.' },
      { note: 51, pattern: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'jungle', name: 'Jungle', kind: 'groove', category: 'electronic', origin: 'UK (London)', meter: '4/4', perBeat: 4,
    description: 'A chopped break at 160: ghost snares tumbling, the kick displaced, a snare roll to end the second bar',
    lanes: [
      { note: 36, pattern: 'x.x.......x.......x.......x.x...' },
      { note: 38, pattern: '....X..g.g..X..g.g..X..g.g..XxXx' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'dubstep', name: 'Dubstep', kind: 'groove', category: 'electronic', origin: 'UK (London)', meter: '4/4', perBeat: 4,
    description: 'Half time at 140: kick on one, snare on three, the kick answering after, triplet hats',
    lanes: [
      { note: 36, pattern: 'x.........x.....' },
      { note: 38, pattern: '........X.......' },
      { note: 42, pattern: 'x.xx.xx.xx.x', perBeat: 3 },
    ],
  },
  {
    id: 'footwork', name: 'Footwork', kind: 'groove', category: 'electronic', origin: 'US (Chicago)', meter: '4/4', perBeat: 4,
    description: 'At 160, kicks in threes against the bar, sparse claps, tom stutters',
    lanes: [
      { note: 36, pattern: 'x..x..x...x..x..' },
      { note: 39, pattern: '....x.......x...' },
      { note: 45, pattern: '.......x.x....xx' },
      { note: 42, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'juke', name: 'Juke', kind: 'groove', category: 'electronic', origin: 'US (Chicago)', meter: '4/4', perBeat: 4,
    description: 'Ghetto house sped up: four on the floor with extra kicks, syncopated claps, offbeat hats',
    lanes: [
      { note: 36, pattern: 'x...x...x..xx...' },
      { note: 39, pattern: '....x..x....x..x' },
      { note: 42, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'synthwave', name: 'Synthwave', kind: 'groove', category: 'electronic', origin: 'Internet', meter: '4/4', perBeat: 4,
    description: 'Eighties drive: kick on one and three, a huge gated snare on two and four, straight sixteenth hats',
    lanes: [
      { note: 36, pattern: 'x.......x.......' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'idm', name: 'IDM-ish', kind: 'groove', category: 'electronic', origin: 'UK', meter: '4/4', perBeat: 4,
    description: 'A broken, fidgety bar: displaced kick, ghosted snare, hats on a sixteenth-triplet grid against it',
    lanes: [
      { note: 36, pattern: 'x..x.....x.x..x.' },
      { note: 38, pattern: '......X..g...X.g' },
      { note: 42, pattern: 'x.x..x.x.xxx..x.x..xxx.x', perBeat: 6 },
    ],
  },
  {
    id: 'gqom', name: 'Gqom', kind: 'groove', category: 'electronic', origin: 'South Africa (Durban)', meter: '4/4', perBeat: 4,
    description: 'No four on the floor: a three-step kick, toms and claps in the gaps, dark and raw',
    lanes: [
      { note: 36, pattern: 'x..x..x.....x...' },
      { note: 45, pattern: '..x....x..x...x.' },
      { note: 39, pattern: '....x.......x...' },
      { note: 70, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'amapiano', name: 'Amapiano', kind: 'groove', category: 'electronic', origin: 'South Africa (Gauteng)', meter: '4/4', perBeat: 4,
    description: 'Shakers in sixteenths over a soft four on the floor, rimshots in threes, an open hat on the ands',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 70, pattern: 'xxXxxxXxxxXxxxXx' },
      { note: 37, pattern: '...x..x....x..x.' },
      { note: 39, pattern: '....x.......x...' },
      { note: 46, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'three-against-four', name: 'Three against four', kind: 'groove', category: 'electronic', origin: 'Everywhere', meter: '4/4', perBeat: 4,
    description: 'Four kicks and three cowbells in the same bar',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 56, pattern: 'x...x...x...', perBeat: 3 },
      { note: 42, pattern: '.x.x.x.x.x.x.x.x' },
    ],
  },
  {
    id: 'drifting', name: 'Drifting', kind: 'groove', category: 'electronic', origin: 'Everywhere', meter: '4/4', perBeat: 4,
    description: 'Lanes of five, seven and sixteen steps; the five and seven are short on purpose, so they drift in and out of phase',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 63, pattern: 'x.x..' },
      { note: 75, pattern: 'x.x.x..' },
      { note: 42, pattern: 'Xx.xx.Xx.xx.Xxx.' },
    ],
  },

  // ---------------------------------------------------------------- caribbean & afro-pop
  {
    id: 'tresillo-groove', name: 'Tresillo', kind: 'groove', category: 'caribbean', origin: 'Cuba / everywhere', meter: '4/4', perBeat: 4,
    description: 'Three in eight: the 3-3-2 under reggaeton, dancehall and half of pop',
    lanes: [
      { note: 36, pattern: 'x..x..x.x..x..x.' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'XxxxXxxxXxxxXxxx' },
    ],
  },
  {
    id: 'cinquillo-groove', name: 'Cinquillo', kind: 'groove', category: 'caribbean', origin: 'Cuba', meter: '4/4', perBeat: 4,
    description: 'Five in eight, the Cuban cell, over a steady kick',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 37, pattern: 'x.xx.xx.x.xx.xx.' },
      { note: 42, pattern: '.x.x.x.x.x.x.x.x' },
    ],
  },
  {
    id: 'one-drop', name: 'One drop', kind: 'groove', category: 'caribbean', origin: 'Jamaica', meter: '4/4', perBeat: 3,
    description: 'Nothing on one: kick and rim together on three, hats shuffling',
    lanes: [
      { note: 36, pattern: '......x.....' },
      { note: 37, pattern: '......X.....' },
      { note: 42, pattern: 'x.xx.xx.xx.x' },
    ],
  },
  {
    id: 'rockers', name: 'Rockers', kind: 'groove', category: 'caribbean', origin: 'Jamaica', meter: '4/4', perBeat: 4,
    description: 'Kick on one and three, rim on two and four, busy hats opening on the ands',
    lanes: [
      { note: 36, pattern: 'x.......x.......' },
      { note: 37, pattern: '....X.......X...' },
      { note: 42, pattern: 'xx.xxx.xxx.xxx.x' },
      { note: 46, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'steppers', name: 'Steppers', kind: 'groove', category: 'caribbean', origin: 'Jamaica / UK', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat, snare on three, hats on the ands: marching roots and dub',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '........X.......' },
      { note: 42, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'rocksteady', name: 'Rocksteady', kind: 'groove', category: 'caribbean', origin: 'Jamaica', meter: '4/4', perBeat: 4,
    description: 'Slower than ska and straighter than reggae: kick and rim on three, steady eighth hats',
    lanes: [
      { note: 36, pattern: '........x.......' },
      { note: 37, pattern: '........X.......' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
      { note: 38, pattern: '....g.......g...' },
    ],
  },
  {
    id: 'ska', name: 'Ska', kind: 'groove', category: 'caribbean', origin: 'Jamaica', meter: '4/4', perBeat: 4,
    description: 'Fast, upbeat hats on the ands, kick on one and three, snare on two and four',
    lanes: [
      { note: 36, pattern: 'x.......x.......' },
      { note: 38, pattern: '....X.......X...' },
      { note: 46, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'dancehall', name: 'Dancehall', kind: 'groove', category: 'caribbean', origin: 'Jamaica', meter: '4/4', perBeat: 4,
    description: 'A 3-3-2 kick twice a bar, snare on two and four, sixteenth hats',
    lanes: [
      { note: 36, pattern: 'x..x..x.x..x..x.' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'x.xxx.xxx.xxx.xx' },
    ],
  },
  {
    id: 'dembow', name: 'Dembow', kind: 'groove', category: 'caribbean', origin: 'Puerto Rico / Panama', meter: '4/4', perBeat: 4,
    description: 'Boom-ch-boom-chick: kick on every beat, snare on the a of one and the and of two, twice: the reggaeton beat',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '...X..X....X..X.' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'moombahton', name: 'Moombahton', kind: 'groove', category: 'caribbean', origin: 'US (Washington, DC)', meter: '4/4', perBeat: 4,
    description: 'Dembow at 108 dressed in house drums: open hat on the ands, claps doubling the snare',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '...X..X....X..X.' },
      { note: 39, pattern: '...x..x....x..x.' },
      { note: 46, pattern: '..x...x...x...x.' },
      { note: 70, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'soca', name: 'Soca', kind: 'groove', category: 'caribbean', origin: 'Trinidad and Tobago', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat, snare on two and four with a pickup after, the iron ringing on the ands',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '....X..x....X..x' },
      { note: 56, pattern: '..x.x.x...x.x.x.' },
      { note: 46, pattern: '..x...x...x...x.' },
    ],
  },
  {
    id: 'zouk', name: 'Zouk', kind: 'groove', category: 'caribbean', origin: 'Guadeloupe / Martinique', meter: '4/4', perBeat: 4,
    description: 'Kick on every beat, the rim in a 3-3-2 against it, sixteenth hats: carnival music slowed for the dance floor',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 37, pattern: 'x..x..x.x..x..x.' },
      { note: 38, pattern: '....X.......X...' },
      { note: 42, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'kompa', name: 'Kompa', kind: 'groove', category: 'caribbean', origin: 'Haiti', meter: '4/4', perBeat: 4,
    description: 'Steady cowbell on the beat, kick in dotted pairs, the snare and floor tom swinging the end of the bar',
    lanes: [
      { note: 36, pattern: 'x.....x.x.....x.' },
      { note: 56, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '....X.......X...' },
      { note: 45, pattern: '.......x......xx' },
      { note: 42, pattern: 'x.xxx.xxx.xxx.xx' },
    ],
  },
  {
    id: 'cumbia', name: 'Cumbia', kind: 'groove', category: 'caribbean', origin: 'Colombia', meter: '4/4', perBeat: 4,
    description: 'Scraper in eighth and two sixteenths, the drum calling on the ands, kick on one and three',
    lanes: [
      { note: 36, pattern: 'x.......x.......' },
      { note: 63, pattern: '..x...x...x...x.' },
      { note: 70, pattern: 'x.xxx.xxx.xxx.xx' },
      { note: 37, pattern: '....x.......x...' },
    ],
  },
  {
    id: 'afrobeats', name: 'Afrobeats', kind: 'groove', category: 'caribbean', origin: 'Nigeria / Ghana', meter: '4/4', perBeat: 4,
    description: 'Tresillo kick, clap on two and four, rim and shaker in syncopated sixteenths',
    lanes: [
      { note: 36, pattern: 'x..x..x...x.....' },
      { note: 39, pattern: '....X.......X...' },
      { note: 37, pattern: '..x..x....x..x..' },
      { note: 70, pattern: 'xxXxxxXxxxXxxxXx' },
    ],
  },
  {
    id: 'afrobeat-lagos', name: 'Afrobeat', kind: 'groove', category: 'caribbean', origin: 'Nigeria (Lagos)', meter: '4/4', perBeat: 4,
    description: 'The seventies Lagos groove: hats in sixteenths opening on four-and, ghosted snare, clave and shaker locked to it',
    lanes: [
      { note: 36, pattern: 'x.....x...x.....' },
      { note: 38, pattern: '..g.X..g.g.gX.g.' },
      { note: 42, pattern: 'xxxxxxxxxxxxxx.x' },
      { note: 46, pattern: '..............x.' },
      { note: 75, pattern: 'x..x..x...x.x...' },
      { note: 70, pattern: 'xxXxxxXxxxXxxxXx' },
    ],
  },
  {
    id: 'highlife', name: 'Highlife', kind: 'groove', category: 'caribbean', origin: 'Ghana', meter: '4/4', perBeat: 4,
    description: 'A bell in a lilting 2-2-3 line, kick on one and three, rim on two and four',
    lanes: [
      { note: 36, pattern: 'x.......x.......' },
      { note: 37, pattern: '....x.......x...' },
      { note: 56, pattern: 'x.x.x..x.x.x..x.' },
      { note: 70, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
  {
    id: 'azonto', name: 'Azonto', kind: 'groove', category: 'caribbean', origin: 'Ghana (Accra)', meter: '4/4', perBeat: 4,
    description: 'Bouncy Ghanaian dance beat: tresillo kick, snare on two and four, rim answering',
    lanes: [
      { note: 36, pattern: 'x..x..x...x..x..' },
      { note: 38, pattern: '....X.......X...' },
      { note: 37, pattern: '.x....x..x....x.' },
      { note: 70, pattern: 'x.xxx.xxx.xxx.xx' },
    ],
  },
  {
    id: 'coupe-decale', name: 'Coupé-décalé', kind: 'groove', category: 'caribbean', origin: 'Ivory Coast', meter: '4/4', perBeat: 4,
    description: 'Fast four on the floor with the snare and toms rattling in sixteenths against it',
    lanes: [
      { note: 36, pattern: 'x...x...x...x...' },
      { note: 38, pattern: '..x...xx..x...xx' },
      { note: 45, pattern: '...x.....x.x....' },
      { note: 42, pattern: 'xxxxxxxxxxxxxxxx' },
    ],
  },
  {
    id: 'kuduro', name: 'Kuduro', kind: 'groove', category: 'caribbean', origin: 'Angola (Luanda)', meter: '4/4', perBeat: 4,
    description: 'Hard kick on every beat, toms and claps in threes over it, at full speed',
    lanes: [
      { note: 36, pattern: 'X...X...X...X...' },
      { note: 45, pattern: '..x..x.x..x..x.x' },
      { note: 39, pattern: '...x..x....x..x.' },
      { note: 42, pattern: '..x...x...x...x.' },
    ],
  },

  // ---------------------------------------------------------------- jazz & swing
  {
    id: 'swing-ride', name: 'Swing ride', kind: 'groove', category: 'jazz', origin: 'US', meter: '4/4', perBeat: 3,
    description: 'Ding, ding-a, ding, ding-a on the ride, hat foot on two and four, the kick barely there',
    lanes: [
      { note: 51, pattern: 'x..X.xx..X.x' },
      { note: 42, pattern: '...x.....x..' },
      { note: 36, pattern: 'g...........' },
    ],
  },
  {
    id: 'swing-feathered', name: 'Swing, feathered kick', kind: 'groove', category: 'jazz', origin: 'US (Kansas City)', meter: '4/4', perBeat: 3,
    description: 'Big-band swing: the kick feathered on all four, ride and hat on top',
    lanes: [
      { note: 51, pattern: 'x..X.xx..X.x' },
      { note: 42, pattern: '...x.....x..' },
      { note: 36, pattern: 'g..g..g..g..' },
    ],
  },
  {
    id: 'bebop-comping', name: 'Bebop comping', kind: 'groove', category: 'jazz', origin: 'US (New York)', meter: '4/4', perBeat: 3,
    description: 'Two bars of ride and hat with snare comping on the lets and a kick bomb dropped where it hurts',
    lanes: [
      { note: 51, pattern: 'x..X.xx..X.xx..X.xx..X.x' },
      { note: 42, pattern: '...x.....x.....x.....x..' },
      { note: 38, pattern: '.....x.....g........x...' },
      { note: 36, pattern: '........X..............X' },
    ],
  },
  {
    id: 'cross-stick-four', name: 'Cross-stick on four', kind: 'groove', category: 'jazz', origin: 'US', meter: '4/4', perBeat: 3,
    description: 'Hard-bop and medium swing: ride and hat as usual, a side stick on every four',
    lanes: [
      { note: 51, pattern: 'x..X.xx..X.x' },
      { note: 42, pattern: '...x.....x..' },
      { note: 37, pattern: '.........x..' },
    ],
  },
  {
    id: 'two-beat', name: 'Two-beat', kind: 'groove', category: 'jazz', origin: 'US', meter: '4/4', perBeat: 3,
    description: 'Kick on one and three under the ride, hat on two and four: early jazz and the head of a tune',
    lanes: [
      { note: 36, pattern: 'x.....x.....' },
      { note: 51, pattern: 'x..X.xx..X.x' },
      { note: 42, pattern: '...x.....x..' },
    ],
  },
  {
    id: 'jazz-waltz', name: 'Jazz waltz', kind: 'groove', category: 'jazz', origin: 'US', meter: '3/4', perBeat: 3,
    description: 'Three-four swing, one bar of nine triplet steps: ride on one, two-let and three, hat on two',
    lanes: [
      { note: 51, pattern: 'x..x.xx..' },
      { note: 42, pattern: '...x.....' },
      { note: 36, pattern: 'g........' },
      { note: 38, pattern: '........g' },
    ],
  },
  {
    id: 'blues-shuffle', name: 'Shuffle', kind: 'groove', category: 'jazz', origin: 'US (Texas / Kansas City)', meter: '4/4', perBeat: 3,
    description: 'Long-short on the hats, backbeat on two and four, kick on all four',
    lanes: [
      { note: 36, pattern: 'x..x..x..x..' },
      { note: 38, pattern: '...X.....X..' },
      { note: 42, pattern: 'x.xx.xx.xx.x' },
    ],
  },
  {
    id: 'slow-blues', name: 'Slow blues, 12/8', kind: 'groove', category: 'jazz', origin: 'US (Chicago)', meter: '12/8', perBeat: 3,
    description: 'Ride in steady triplets, ghosts on the snare between hard two and four',
    lanes: [
      { note: 36, pattern: 'x.....x.....' },
      { note: 38, pattern: '.g.X.g.g.X.g' },
      { note: 51, pattern: 'XxxXxxXxxXxx' },
    ],
  },
  {
    id: 'brush-ballad', name: 'Brush ballad', kind: 'groove', category: 'jazz', origin: 'US', meter: '4/4', perBeat: 3,
    description: 'Brush sweeping in quiet triplets, a tap on two and four, kick feathered on one and three (an approximation of a sweep)',
    lanes: [
      { note: 38, pattern: 'gggXgggggXgg' },
      { note: 42, pattern: '...x.....x..' },
      { note: 36, pattern: 'g.....g.....' },
    ],
  },
  {
    id: 'new-orleans-swing', name: 'New Orleans swing', kind: 'groove', category: 'jazz', origin: 'US (New Orleans)', meter: '4/4', perBeat: 3,
    description: 'Street parade on a kit: kick on all four, the snare shuffling with accents on two and four, woodblock on the beat',
    lanes: [
      { note: 36, pattern: 'x..x..x..x..' },
      { note: 38, pattern: 'g.gX.gg.gX.g' },
      { note: 76, pattern: 'x..x..x..x..' },
    ],
  },
  {
    id: 'bossa-groove', name: 'Bossa nova (Euclidean)', kind: 'groove', category: 'jazz', origin: 'Brazil', meter: '4/4', perBeat: 4,
    description: 'Five in sixteen on the rim, a three-in-eight kick, shaker in sixteenths',
    lanes: [
      { note: 36, pattern: 'x..x..x.x..x..x.' },
      { note: 37, pattern: 'x..x..x..x..x...' },
      { note: 70, pattern: 'XxxxXxxxXxxxXxxx' },
    ],
  },
  {
    id: 'jazz-samba', name: 'Jazz samba', kind: 'groove', category: 'jazz', origin: 'Brazil', meter: '4/4', perBeat: 4,
    description: 'Surdo on the kick in dotted pairs, Brazilian clave on the rim, sixteenths on the ride leaning on the last of each beat',
    lanes: [
      { note: 36, pattern: 'x..xx..xx..xx..x' },
      { note: 37, pattern: 'x..x..x...x..x..' },
      { note: 51, pattern: 'xxxXxxxXxxxXxxxX' },
    ],
  },
  {
    id: 'afro-cuban-6-8-kit', name: 'Afro-Cuban 6/8 on the kit', kind: 'groove', category: 'jazz', origin: 'Cuba / US', meter: '12/8', perBeat: 3,
    description: 'The bell pattern on the ride bell, kick on the big beats, hat on the other two, rim between',
    lanes: [
      { note: 51, pattern: 'x.x.xx.x.x.x' },
      { note: 36, pattern: 'x.....x.....' },
      { note: 42, pattern: '...x.....x..' },
      { note: 37, pattern: '....x.....x.' },
    ],
  },
  {
    id: 'songo', name: 'Songo', kind: 'groove', category: 'jazz', origin: 'Cuba (Havana)', meter: '4/4', perBeat: 4,
    description: 'Bell on the beat, kick on the and of two and on four with the bass, snare and tom chattering in sixteenths',
    lanes: [
      { note: 56, pattern: 'x...x...x...x...' },
      { note: 36, pattern: '......x.....x...' },
      { note: 38, pattern: 'g..X..g.g..X..g.' },
      { note: 45, pattern: '.........x....xx' },
    ],
  },
  {
    id: 'boogaloo', name: 'Boogaloo', kind: 'groove', category: 'jazz', origin: 'US (New York)', meter: '4/4', perBeat: 4,
    description: 'Latin soul, straight eighths: cowbell on the beat, backbeat on two and four, conga tumbao opening on four',
    lanes: [
      { note: 36, pattern: 'x.....x.x.....x.' },
      { note: 38, pattern: '....X.......X...' },
      { note: 56, pattern: 'x...x...x...x...' },
      { note: 63, pattern: '....x..x....x.x.' },
      { note: 42, pattern: 'x.x.x.x.x.x.x.x.' },
    ],
  },
]
