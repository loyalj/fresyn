import { useCallback } from 'react'
import type { StemMix } from '../audio/renderSong'
import type { SampleLibrary } from '../audio/SampleLibrary'
import type { Transport } from '../audio/Transport'
import { makeZip, type ZipEntry } from '../audio/zip'
import { downloadBytes, slug } from '../patch/storage'
import type { Rack } from '../song/project'
import { songEnd } from '../song/schedule'
import type { Song } from '../song/types'
import { songToMidi } from '../song/midi'
import { rowZero, tuningOf } from '../song/tuning'
import type { BounceSettings } from '../ui/BounceDialog'
import { progress, reason, warn, type SetNotice } from '../ui/notice'
import { nextFrame } from './nextFrame'

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
 * The arrangement as audio: the whole mix, or a file per track.
 *
 * The renderer is fetched when a bounce is asked for rather than with the
 * page. It is a second copy of the whole DSP, and most sessions never bounce.
 */
export function useBounce({ song, racks, name, samples, transport, setNotice, runJob }: Options) {
  /**
   * Bounce the arrangement to a file.
   *
   * The transport is stopped first. The bounce runs its own player and would
   * be correct either way, but the two would be competing for the same thread
   * and the loop you were listening to would stutter for as long as it took.
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
        const [{ renderSong }, { encodeAudio }] = await Promise.all([
          import('../audio/renderSong'),
          import('../audio/encoders'),
        ])
        const audio = await renderSong(song, racks, {
          sampleRate: settings.sampleRate,
          samples: samples.bank(),
          onProgress: async (done) => {
            setNotice(progress(`Bouncing ${Math.round(done * 100)}%`))
            await nextFrame()
          },
        })
        setNotice(progress(`Encoding ${settings.format.toUpperCase()}...`))
        await nextFrame()
        const file = await encodeAudio([audio.left, audio.right], audio.sampleRate, settings)
        downloadBytes(file.bytes as BlobPart, `${slug(name)}.${file.extension}`, file.mime)
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
          const [{ renderStems }, { encodeAudio }] = await Promise.all([
            import('../audio/renderSong'),
            import('../audio/encoders'),
          ])
          const stems = await renderStems(song, racks, {
            stemMix,
            sampleRate: settings.sampleRate,
            samples: samples.bank(),
            onProgress: async (done) => {
              setNotice(progress(`Bouncing stems ${Math.round(done * 100)}%`))
              await nextFrame()
            },
          })
          if (stems.length === 0) {
            setNotice('Every track is muted, so there are no stems to write')
            return
          }
          // Numbered, so they sort into the order the tracks are in rather than
          // alphabetically -- which is the order anybody will want to line them up.
          const entries: ZipEntry[] = []
          for (const [i, stem] of stems.entries()) {
            setNotice(progress(`Encoding stem ${i + 1} of ${stems.length}...`))
            await nextFrame()
            const file = await encodeAudio([stem.audio.left, stem.audio.right], stem.audio.sampleRate, settings)
            entries.push({ name: `${String(i + 1).padStart(2, '0')} ${slug(stem.name)}.${file.extension}`, data: file.bytes })
          }
          downloadBytes(makeZip(entries) as BlobPart, `${slug(name)}-stems.zip`, 'application/zip')
          setNotice(`Bounced ${stems.length} stem${stems.length === 1 ? '' : 's'}`)
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
