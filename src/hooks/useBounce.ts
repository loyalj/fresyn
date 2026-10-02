import { useCallback } from 'react'
import * as offline from '../audio/offline'
import type { StemMix } from '../audio/renderSong'
import type { SampleLibrary } from '../audio/SampleLibrary'
import type { Transport } from '../audio/Transport'
import { downloadBytes, slug } from '../patch/storage'
import type { Rack } from '../song/project'
import { songEnd } from '../song/schedule'
import type { Song } from '../song/types'
import { songToMidi } from '../song/midi'
import { rowZero, tuningOf } from '../song/tuning'
import type { BounceSettings } from '../ui/BounceDialog'
import { progress, reason, warn, type SetNotice } from '../ui/notice'

interface Options {
  song: Song
  racks: Record<string, Rack>
  name: string
  samples: SampleLibrary
  transport: Transport
  setNotice: SetNotice
  /** The one-job-at-a-time lock, shared with saving. */
  runJob: (label: string, job: () => Promise<void>) => Promise<void>
}

/**
 * A progress callback that only touches the notice when the percentage it
 * shows has changed. The worker reports every tenth of a second or so, and
 * each notice is a render of the app's notice area; most of those would
 * draw the same number again.
 */
function percentNotice(setNotice: SetNotice, say: (p: offline.OfflineProgress) => string) {
  let last = ''
  return (p: offline.OfflineProgress) => {
    const text = say(p)
    if (text === last) return
    last = text
    setNotice(progress(text))
  }
}

/**
 * The arrangement as audio: the whole mix, or a file per track.
 *
 * Both run in the bounce worker (`audio/offline.ts`), so the page stays
 * live while they do and a bounce left running in a background tab carries
 * on. The renderer and the encoders are fetched with the worker, when a
 * bounce is first asked for, rather than with the page: they are a second
 * copy of the whole DSP, and most sessions never bounce.
 */
export function useBounce({ song, racks, name, samples, transport, setNotice, runJob }: Options) {
  /**
   * Bounce the arrangement to a file.
   *
   * The transport is stopped first. The bounce runs its own player in its
   * own thread and would be correct either way, but it wants a whole core
   * for as long as it takes, and on a machine without one to spare it is the
   * loop you were listening to that would stutter.
   */
  const bounceSong = useCallback(async (settings: BounceSettings) => {
    if (songEnd(song) <= 0) {
      setNotice('Nothing on the playlist to bounce -- put a pattern in a bar first')
      return
    }
    await runJob('bouncing', async () => {
      transport.stop()
      setNotice(progress('Bouncing...'))
      try {
        const audio = await offline.bounceSong(
          { song, racks, samples: samples.bank(), sampleRate: settings.sampleRate, encode: settings },
          percentNotice(setNotice, (p) =>
            p.stage === 'encode'
              ? `Encoding ${settings.format.toUpperCase()}...`
              : `Bouncing ${Math.round(p.done * 100)}%`,
          ),
        )
        downloadBytes(audio.blob, `${slug(name)}.${audio.extension}`, audio.mime)
        setNotice(
          audio.peak > 1
            ? warn(`Bounced ${audio.seconds.toFixed(1)}s -- it clips at ${audio.peak.toFixed(2)}, so bring the levels down`)
            : `Bounced ${audio.seconds.toFixed(1)}s, peak ${audio.peak.toFixed(2)}`,
        )
      } catch (err) {
        setNotice(warn(`Bounce failed: ${reason(err)}`))
      }
    })
  }, [song, racks, name, samples, transport, setNotice, runJob])

  /**
   * One file per track, so the mix can be rebuilt or re-balanced elsewhere --
   * carrying as much of each track's channel as was asked for: the rack
   * alone, through its strip, or with its reverb and echo as well.
   */
  const bounceStems = useCallback(
    async (stemMix: StemMix, settings: BounceSettings) => {
      if (songEnd(song) <= 0) {
        setNotice('Nothing on the playlist to bounce -- put a pattern in a bar first')
        return
      }
      await runJob('bouncing', async () => {
        transport.stop()
        setNotice(progress('Bouncing stems...'))
        try {
          const stems = await offline.bounceStems(
            {
              song,
              racks,
              samples: samples.bank(),
              sampleRate: settings.sampleRate,
              encode: settings,
              stemMix,
              names: Object.fromEntries(song.tracks.map((t) => [t.id, slug(t.name)])),
            },
            percentNotice(setNotice, (p) =>
              p.stage === 'encode'
                ? `Encoding stem ${(p.index ?? 0) + 1} of ${p.count}...`
                : `Bouncing stems ${Math.round(p.done * 100)}%`,
            ),
          )
          if (!stems.zip) {
            setNotice('Every track is muted, so there are no stems to write')
            return
          }
          downloadBytes(stems.zip, `${slug(name)}-stems.zip`, 'application/zip')
          setNotice(`Bounced ${stems.count} stem${stems.count === 1 ? '' : 's'}`)
        } catch (err) {
          setNotice(warn(`Bounce failed: ${reason(err)}`))
        }
      })
    },
    [song, racks, name, samples, transport, setNotice, runJob],
  )

  /**
   * The arrangement as a MIDI file, for another DAW or a game's own
   * sequencer. Instant, and nothing is rendered: it is the notes.
   */
  const exportMidi = useCallback(() => {
    if (songEnd(song) <= 0) {
      setNotice('Nothing on the playlist to export -- put a pattern in a bar first')
      return
    }
    // Each track's rows as the notes they sound, read off its own rack.
    const zeros = new Map(song.tracks.map((t) => [t.id, racks[t.id] ? rowZero(tuningOf(racks[t.id])) : rowZero(null)]))
    const file = songToMidi(song, { name, noteOf: (track, row) => (zeros.get(track) ?? rowZero(null)) + row })
    downloadBytes(file as BlobPart, `${slug(name)}.mid`, 'audio/midi')
    setNotice(`Exported ${slug(name)}.mid`)
  }, [song, racks, name, setNotice])

  return { bounceSong, bounceStems, exportMidi }
}
