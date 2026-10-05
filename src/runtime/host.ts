import { lowpass, Section } from '../dsp/Biquad'
import { SongPlayer, loadProject } from '../song/runtime'
import { songEnd } from '../song/schedule'
import type { Loop } from '../song/transport'
import type { FromRuntime, LoopSetup, PlayerInfo, PlayerReport, ToRuntime } from './protocol'

/**
 * Several projects playing at once, for a game: the music, a bank of sound
 * effects, a jingle, each a `SongPlayer` of its own, summed.
 *
 * Kept free of the worklet for the reason `SongEngine` is: everything that
 * decides what is heard can then be run and checked with no browser at all,
 * and the processor that hosts it in a game is a few lines of glue.
 *
 * Players are separate rather than one song with every sound in it, because
 * they are used separately. The music changes section and tempo; the sound
 * effects must not change with it. A jingle is loaded, played and dropped.
 * What they share is the clock -- every player renders the same blocks, so a
 * frame on one is a fixed distance from the same moment on another, which is
 * what lets a sound effect land on the music's grid.
 */

/** A muffle of 1 is this far down: about a voice through a wall. */
const MUFFLE_FLOOR_HZ = 280
const OPEN_HZ = 20000

/** A player's own bus after its master: a fader and a low-pass, each gliding. */
class Bus {
  gain = 1
  private gainTo = 1
  private gainStep = 0
  muffle = 0
  private muffleTo = 0
  private muffleStep = 0
  private l = new Section()
  private r = new Section()
  private shaped = -1

  constructor(private readonly sampleRate: number) {}

  set(gain: number | undefined, muffle: number | undefined, glide: number) {
    const blocks = Math.max(1, Math.round((Math.max(0, glide) * this.sampleRate) / 128))
    if (gain !== undefined && Number.isFinite(gain)) {
      this.gainTo = Math.max(0, gain)
      this.gainStep = (this.gainTo - this.gain) / blocks
    }
    if (muffle !== undefined && Number.isFinite(muffle)) {
      this.muffleTo = Math.min(1, Math.max(0, muffle))
      this.muffleStep = (this.muffleTo - this.muffle) / blocks
    }
  }

  /** Faded all the way out and staying there: nothing left to hear. */
  get silent() {
    return this.gain === 0 && this.gainTo === 0
  }

  /** Move a block's worth toward the targets, then run the block through. */
  process(left: Float32Array, right: Float32Array, n: number) {
    const from = this.gain
    this.gain = step(this.gain, this.gainTo, this.gainStep)
    this.muffle = step(this.muffle, this.muffleTo, this.muffleStep)

    if (this.muffle > 1e-4) {
      // Logarithmic, so the middle of the travel is the middle of what is heard.
      if (this.muffle !== this.shaped) {
        const f = OPEN_HZ * Math.pow(MUFFLE_FLOOR_HZ / OPEN_HZ, this.muffle)
        lowpass(this.l, this.sampleRate, f, Math.SQRT1_2)
        this.r.copy(this.l)
        this.shaped = this.muffle
      }
      for (let i = 0; i < n; i++) {
        left[i] = this.l.process(left[i])
        right[i] = this.r.process(right[i])
      }
    }
    // The fader ramps across the block rather than stepping at its edge.
    const to = this.gain
    if (from === 1 && to === 1) return
    const d = (to - from) / n
    for (let i = 0; i < n; i++) {
      const g = from + d * i
      left[i] *= g
      right[i] *= g
    }
  }
}

function step(at: number, to: number, by: number) {
  if (at === to) return at
  const next = at + by
  return (by > 0 && next >= to) || (by < 0 && next <= to) || by === 0 ? to : next
}

interface Hosted {
  player: SongPlayer
  playing: boolean
  /** Stop once the fade out has finished. */
  stopping: boolean
  bus: Bus
  loop: Loop | null
}

export class RuntimeHost {
  private players = new Map<string, Hosted>()
  private scratchL = new Float32Array(128)
  private scratchR = new Float32Array(128)
  private master = 1

  constructor(readonly sampleRate: number) {}

  /** The player itself, for a caller on the same thread: a headless game, or a check. */
  player(id: string): SongPlayer | undefined {
    return this.players.get(id)?.player
  }

  /** Act on one message. Hands back a reply when the message wants one. */
  handle(msg: ToRuntime): FromRuntime | undefined {
    if (msg.type === 'master') {
      if (Number.isFinite(msg.gain)) this.master = Math.max(0, msg.gain)
      return
    }
    if (msg.type === 'load') return this.load(msg)
    const hosted = this.players.get(msg.id)
    if (!hosted) return
    const p = hosted.player
    switch (msg.type) {
      case 'unload':
        this.players.delete(msg.id)
        break
      case 'start': {
        p.seek(0)
        p.setLoop(hosted.loop)
        if (msg.section) p.playSection(msg.section, { when: 'now', loop: msg.loop ?? true })
        hosted.playing = true
        hosted.stopping = false
        const fade = msg.fade ?? 0
        if (fade > 0) hosted.bus.set(0, undefined, 0)
        hosted.bus.set(msg.gain ?? 1, undefined, fade)
        break
      }
      case 'stop':
        if (!hosted.playing) break
        hosted.bus.set(0, undefined, msg.fade ?? 0)
        hosted.stopping = true
        break
      case 'section':
        p.playSection(msg.name, { when: msg.when, loop: msg.loop })
        break
      case 'release':
        p.releaseSection()
        break
      case 'param':
        p.setParam(msg.track, msg.knob, msg.value)
        break
      case 'releaseParam':
        p.releaseParam(msg.track, msg.knob)
        break
      case 'note':
        p.noteOn(msg.track, msg.pitch, msg.velocity, { at: this.frameFor(hosted, msg.when, msg.sync), length: msg.length })
        break
      case 'noteOff':
        p.noteOff(msg.track, msg.pitch)
        break
      case 'trigger':
        p.trigger(msg.track, msg.velocity, { at: this.frameFor(hosted, msg.when, msg.sync) })
        break
      case 'track':
        if (msg.gain !== undefined) p.setTrackGain(msg.track, msg.gain)
        if (msg.pan !== undefined) p.setTrackPan(msg.track, msg.pan)
        if (msg.mute !== undefined) p.setTrackMute(msg.track, msg.mute)
        break
      case 'tempo':
        p.setTempoScale(msg.scale)
        break
      case 'bus':
        hosted.bus.set(msg.gain, msg.muffle, msg.glide ?? 0)
        break
    }
    return
  }

  private load(msg: Extract<ToRuntime, { type: 'load' }>): FromRuntime {
    const loaded = loadProject(msg.project)
    if ('error' in loaded) return { type: 'failed', request: msg.request, message: loaded.error }
    const { song, racks } = loaded
    const setup: LoopSetup = msg.loop === undefined ? 'song' : msg.loop
    let loop: Loop | null = null
    if (setup === 'song') {
      const end = songEnd(song)
      loop = song.loop ?? (end > 0 ? { from: 0, to: end } : null)
    } else if (setup) loop = setup

    const player = new SongPlayer(song, racks, { sampleRate: this.sampleRate, seed: msg.seed, loop })
    // Built stopped: a game loads everything up front and starts what it needs.
    this.players.set(msg.id, { player, playing: false, stopping: false, bus: new Bus(this.sampleRate), loop })
    const params: Record<string, string[]> = {}
    for (const name of player.trackNames) params[name] = player.paramsOf(name)
    const ids = new Set(player.playable)
    const info: PlayerInfo = {
      id: msg.id,
      tracks: player.trackNames,
      playable: song.tracks.filter((t) => ids.has(t.id)).map((t) => t.name),
      sections: player.sections,
      key: player.key,
      tempo: song.tempo,
      params,
    }
    return { type: 'loaded', request: msg.request, info }
  }

  /**
   * The frame, on this player's clock, that a grid-timed note lands on: the
   * next line of the grid of the player it is synced to, carried across to
   * this one's clock. The two have rendered the same blocks since either
   * started, so the distance between their clocks is the same at every
   * moment.
   */
  private frameFor(hosted: Hosted, when: Parameters<SongPlayer['frameOf']>[0] | undefined, sync: string | undefined) {
    if (!when || when === 'now') return undefined
    const clock = sync ? this.players.get(sync) : hosted
    if (!clock || !clock.playing) return undefined
    return hosted.player.frame + (clock.player.frameOf(when) - clock.player.frame)
  }

  /** Render every playing player and sum them. A stopped player is not run at all. */
  render(left: Float32Array, right: Float32Array) {
    const n = left.length
    left.fill(0)
    right.fill(0)
    if (this.scratchL.length !== n) {
      this.scratchL = new Float32Array(n)
      this.scratchR = new Float32Array(n)
    }
    const sl = this.scratchL
    const sr = this.scratchR
    for (const hosted of this.players.values()) {
      if (!hosted.playing) continue
      hosted.player.render(sl, sr)
      hosted.bus.process(sl, sr, n)
      for (let i = 0; i < n; i++) {
        left[i] += sl[i]
        right[i] += sr[i]
      }
      if (hosted.stopping && hosted.bus.silent) {
        hosted.player.seek(0)
        hosted.playing = false
        hosted.stopping = false
      }
    }
    const m = this.master
    if (m !== 1) {
      for (let i = 0; i < n; i++) {
        left[i] *= m
        right[i] *= m
      }
    }
  }

  /** Every player's clock and levels, as of now. */
  report(time: number): FromRuntime {
    const players: Record<string, PlayerReport> = {}
    for (const [id, hosted] of this.players) {
      const p = hosted.player
      const levels = hosted.playing ? p.levels() : { tracks: {}, master: 0 }
      players[id] = { playing: hosted.playing, clock: p.clock, section: p.section, levels: levels.tracks, master: levels.master }
    }
    return { type: 'report', time, players }
  }
}
