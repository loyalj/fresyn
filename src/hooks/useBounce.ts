import { useCallback } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import type { StemMix } from '../audio/renderSong'
import type { SampleLibrary } from '../audio/SampleLibrary'
import type { Transport } from '../audio/Transport'
import { encodeWav } from '../audio/wav'
import { makeZip, type ZipEntry } from '../audio/zip'
import { downloadBytes, slug } from '../patch/storage'
import type { Rack } from '../song/project'
import { songEnd } from '../song/schedule'
import type { Song } from '../song/types'
import { nextFrame } from './nextFrame'

interface Options {
  song: Song
  racks: Record<string, Rack>
  name: string
  engine: AudioEngine
  samples: SampleLibrary
  transport: Transport
  setNotice: (text: string) => void
}

/**
 * The arrangement as audio: the whole mix, or a file per track.
 *
 * The renderer is fetched when a bounce is asked for rather than with the
 * page. It is a second copy of the whole DSP, and most sessions never bounce.
 */
export function useBounce({ song, racks, name, engine, samples, transport, setNotice }: Options) {
  /**
   * Bounce the arrangement to a file.
   *
   * The transport is stopped first. The bounce runs its own player and would
   * be correct either way, but the two would be competing for the same thread
   * and the loop you were listening to would stutter for as long as it took.
   */
  const bounceSong = useCallback(async () => {
    if (songEnd(song) <= 0) {
      setNotice('Nothing on the playlist to bounce -- put a pattern in a bar first')
      return
    }
    transport.stop()
    setNotice('Bouncing...')
    try {
      const { renderSong } = await import('../audio/renderSong')
      const audio = await renderSong(song, racks, {
        sampleRate: engine.sampleRate,
        samples: samples.bank(),
        onProgress: async (done) => {
          setNotice(`Bouncing ${Math.round(done * 100)}%`)
          await nextFrame()
        },
      })
      // 24-bit: a mix is more likely than a one-shot to be mastered or
      // re-encoded afterwards, and the headroom costs a third of a file that
      // is already small.
      downloadBytes(
        encodeWav([audio.left, audio.right], audio.sampleRate, 24) as BlobPart,
        `${slug(name)}.wav`,
        'audio/wav',
      )
      setNotice(
        audio.peak > 1
          ? `Bounced ${audio.seconds.toFixed(1)}s -- it clips at ${audio.peak.toFixed(2)}, so bring the levels down`
          : `Bounced ${audio.seconds.toFixed(1)}s, peak ${audio.peak.toFixed(2)}`,
      )
    } catch (err) {
      setNotice(`Bounce failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [song, racks, name, engine, samples, transport, setNotice])

  /**
   * One file per track, so the mix can be rebuilt or re-balanced elsewhere --
   * carrying as much of each track's channel as was asked for: the rack
   * alone, through its strip, or with its reverb and echo as well.
   */
  const bounceStems = useCallback(
    async (stemMix: StemMix) => {
      if (songEnd(song) <= 0) {
        setNotice('Nothing on the playlist to bounce -- put a pattern in a bar first')
        return
      }
      transport.stop()
      setNotice('Bouncing stems...')
      try {
        const { renderStems } = await import('../audio/renderSong')
        const stems = await renderStems(song, racks, {
          stemMix,
          sampleRate: engine.sampleRate,
          samples: samples.bank(),
          onProgress: async (done) => {
            setNotice(`Bouncing stems ${Math.round(done * 100)}%`)
            await nextFrame()
          },
        })
        if (stems.length === 0) {
          setNotice('Every track is muted, so there are no stems to write')
          return
        }
        // Numbered, so they sort into the order the tracks are in rather than
        // alphabetically -- which is the order anybody will want to line them up.
        const entries: ZipEntry[] = stems.map((stem, i) => ({
          name: `${String(i + 1).padStart(2, '0')} ${slug(stem.name)}.wav`,
          data: encodeWav([stem.audio.left, stem.audio.right], stem.audio.sampleRate, 24),
        }))
        downloadBytes(makeZip(entries) as BlobPart, `${slug(name)}-stems.zip`, 'application/zip')
        setNotice(`Bounced ${stems.length} stem${stems.length === 1 ? '' : 's'}`)
      } catch (err) {
        setNotice(`Bounce failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [song, racks, name, engine, samples, transport, setNotice],
  )

  return { bounceSong, bounceStems }
}
