import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import { renderTakes, writeWavs } from '../audio/offline'
import type { SampleLibrary } from '../audio/SampleLibrary'
import { downloadBytes, slug } from '../patch/storage'
import type { Patch } from '../patch/types'
import { DEFAULT_EXPORT, ExportPanel, type ExportSettings } from '../ui/ExportPanel'
import { reason, warn, type SetNotice } from '../ui/notice'
import { TakeList, type Take } from '../ui/TakeList'

interface Options {
  engine: AudioEngine
  samples: SampleLibrary
  trackId: string
  patchName: string
  patch: Patch
  values: Readonly<Record<string, number>>
  setNotice: SetNotice
}

/**
 * The recorder's side of the rack: rendering takes of the patch on the
 * bench, auditioning them, and writing out the ones worth keeping. Hands back
 * the controls for the recorder's panel, ready to put on it.
 */
export function useTakes({ engine, samples, trackId, patchName, patch, values, setNotice }: Options) {
  /**
   * Rendered takes, by the track they were rendered from.
   *
   * Per track because a take is a recording of one rack: with one list for
   * the whole app, switching tracks left the last track's takes on the new
   * track's recorder, and downloading them named the files after whichever
   * track happened to be on the bench. Outside the history like the
   * selection -- a take is a file waiting to be written, not an edit.
   */
  const [takeSets, setTakeSets] = useState<Readonly<Record<string, Take[]>>>({})
  const [playing, setPlaying] = useState<number | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)
  /**
   * Each track's render settings. Up here rather than in the recorder's
   * panel, which is remounted whenever the rack changes track or the
   * recorder moves, and forgot them every time.
   */
  const [exportSettings, setExportSettings] = useState<Readonly<Record<string, ExportSettings>>>({})
  const stopPreview = useRef<(() => void) | null>(null)

  const stop = useCallback(() => {
    stopPreview.current?.()
    stopPreview.current = null
    setPlaying(null)
  }, [])

  useEffect(() => () => stopPreview.current?.(), [])

  // A take playing belongs to the track it came from; the list it would be
  // lit in goes away with the track.
  useEffect(() => stop(), [trackId, stop])

  /** The takes on the bench's recorder: this track's, and no other's. */
  const takes = useMemo(() => takeSets[trackId] ?? [], [takeSets, trackId])
  const setTakes = useCallback(
    (id: string, fn: (prev: Take[]) => Take[]) =>
      setTakeSets((all) => ({ ...all, [id]: fn(all[id] ?? []) })),
    [],
  )

  /**
   * The rack as it is now, read by a render when it starts rather than
   * closed over: a render that had to be rebuilt on every knob turn would
   * redraw the recorder's panel along with every knob in the rack.
   */
  const bench = useRef({ trackId, patchName, patch, values })
  useEffect(() => {
    bench.current = { trackId, patchName, patch, values }
  })

  const onRender = useCallback(
    async (settings: ExportSettings) => {
      // Captured at the start: the render takes a while, and a track switched
      // to half way through is not the one these takes are of.
      const { trackId: id, patchName: source, patch, values } = bench.current
      stop()
      setTakes(id, () => [])
      setExporting('Rendering')

      try {
        // In the takes worker, a take at a time: the page stays live while
        // a long batch renders, and the panel counts them in as they arrive.
        const rendered: Take[] = []
        let limited = 0
        await renderTakes({ patch, values, samples: samples.bank(), settings }, (take) => {
          if (take.limited) limited++
          rendered.push({
            index: take.index,
            seed: take.seed,
            seconds: take.seconds,
            peak: take.peak,
            sampleRate: take.sampleRate,
            left: take.left,
            right: take.right,
            envelope: take.envelope,
            keep: true,
            source,
            bitDepth: settings.bitDepth,
          })
          if (rendered.length < settings.count) setExporting(`Take ${rendered.length + 1} of ${settings.count}`)
        })
        setTakes(id, () => rendered)
        setNotice(
          `Rendered ${rendered.length} take${rendered.length === 1 ? '' : 's'}` +
            // Said, because the file is quieter than the target it was set to.
            (limited > 0
              ? ` -- ${limited} held at -1 dB peak, short of the loudness target`
              : ''),
        )
      } catch (err) {
        setNotice(warn(`Render failed: ${reason(err)}`))
      } finally {
        setExporting(null)
      }
    },
    [stop, setTakes, samples, setNotice],
  )

  const onPlayTake = useCallback(
    async (index: number) => {
      const wasPlaying = playing === index
      stop()
      if (wasPlaying) return

      const take = takes.find((t) => t.index === index)
      if (!take) return

      setPlaying(index)
      stopPreview.current = await engine.preview(
        take.left,
        take.right,
        take.sampleRate,
        // This also fires when we stop it early, so only clear if the take
        // that ended is still the one showing as playing.
        () => setPlaying((p) => (p === index ? null : p)),
      )
    },
    [engine, takes, playing, stop],
  )

  const onDownloadTakes = useCallback(async () => {
    const kept = takes.filter((t) => t.keep)
    if (kept.length === 0) return

    // Named after the sound they were rendered from, as it was called then.
    const base = slug(kept[0].source)
    const bitDepth = kept[0].bitDepth
    const one = kept.length === 1
    try {
      // Written in the worker too: a batch of long takes at 24 bits is a
      // good many megabytes of arithmetic.
      const { blob } = await writeWavs(
        kept.map((take) => ({
          name: one ? `${base}.wav` : `${base}_${String(take.index + 1).padStart(2, '0')}.wav`,
          left: take.left,
          right: take.right,
          sampleRate: take.sampleRate,
          bitDepth,
        })),
        !one,
      )
      downloadBytes(blob, one ? `${base}.wav` : `${base}.zip`, one ? 'audio/wav' : 'application/zip')
      setNotice(`Downloaded ${kept.length} take${one ? '' : 's'}`)
    } catch (err) {
      setNotice(warn(`Download failed: ${reason(err)}`))
    }
  }, [takes, setNotice])

  /**
   * The render controls and the takes, for the recorder's panel. Built here
   * and memoized, so the panel carrying them redraws when a take arrives or
   * a setting moves, and not when a knob elsewhere in the rack does.
   */
  const recorder = useMemo(
    () => (
      <>
        <ExportPanel
          settings={exportSettings[trackId] ?? DEFAULT_EXPORT}
          onSettings={(next) => setExportSettings((all) => ({ ...all, [trackId]: next }))}
          onExport={(s) => void onRender(s)}
          busy={exporting}
          hasTakes={takes.length > 0}
        />
        <TakeList
          takes={takes}
          playing={playing}
          onPlay={(i) => void onPlayTake(i)}
          onToggleKeep={(i) =>
            setTakes(trackId, (prev) => prev.map((t) => (t.index === i ? { ...t, keep: !t.keep } : t)))
          }
          onKeepAll={(keep) => setTakes(trackId, (prev) => prev.map((t) => ({ ...t, keep })))}
          onExport={() => void onDownloadTakes()}
          onDiscard={() => {
            stop()
            setTakes(trackId, () => [])
          }}
        />
      </>
    ),
    [exportSettings, trackId, onRender, exporting, takes, playing, onPlayTake, setTakes, onDownloadTakes, stop],
  )

  return { recorder }
}
