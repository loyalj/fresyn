import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import { normalize } from '../audio/normalize'
import type { SampleLibrary } from '../audio/SampleLibrary'
import { encodeWav } from '../audio/wav'
import { peakEnvelope } from '../audio/waveform'
import { makeZip, type ZipEntry } from '../audio/zip'
import { downloadBytes, slug } from '../patch/storage'
import type { Patch } from '../patch/types'
import { DEFAULT_EXPORT, ExportPanel, type ExportSettings } from '../ui/ExportPanel'
import { reason, warn, type SetNotice } from '../ui/notice'
import { TakeList, type Take } from '../ui/TakeList'
import { nextFrame } from './nextFrame'

const WAVE_COLUMNS = 200

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
        // The offline renderer is the whole DSP a second time over, so it is
        // fetched the first time something is rendered rather than with the
        // page.
        const { renderVariation } = await import('../audio/render')
        const rendered: Take[] = []
        let limited = 0
        for (let i = 0; i < settings.count; i++) {
          setExporting(`Take ${i + 1} of ${settings.count}`)
          // Rendering is synchronous and fast, but a batch still has to let
          // the page paint between takes or the progress never appears.
          await nextFrame()

          const take = renderVariation(
            patch,
            values,
            {
              sampleRate: settings.sampleRate,
              duration: settings.duration,
              gateSeconds: settings.gateSeconds,
              seed: settings.seed,
              // A take has to contain whatever a Sampler is playing, so the
              // offline pass gets the same audio the live rack has.
              samples: samples.bank(),
            },
            i,
            settings.spread,
          )
          // Levelled here, before anything is drawn or heard, so the take
          // you audition is the take that gets saved.
          const level = normalize(take.left, take.right, take.sampleRate, settings.normalize)
          if (level.limited) limited++
          rendered.push({
            index: i,
            seed: take.seed,
            seconds: take.seconds,
            peak: level.peak,
            sampleRate: take.sampleRate,
            left: level.left,
            right: level.right,
            envelope: peakEnvelope(level.left, level.right, WAVE_COLUMNS),
            keep: true,
            source,
            bitDepth: settings.bitDepth,
          })
        }
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

  const onDownloadTakes = useCallback(() => {
    const kept = takes.filter((t) => t.keep)
    if (kept.length === 0) return

    // Named after the sound they were rendered from, as it was called then.
    const base = slug(kept[0].source)
    const bitDepth = kept[0].bitDepth
    const files: ZipEntry[] = kept.map((take) => ({
      name:
        kept.length === 1
          ? `${base}.wav`
          : `${base}_${String(take.index + 1).padStart(2, '0')}.wav`,
      data: encodeWav([take.left, take.right], take.sampleRate, bitDepth),
    }))

    if (files.length === 1) downloadBytes(files[0].data, files[0].name, 'audio/wav')
    else downloadBytes(makeZip(files), `${base}.zip`, 'application/zip')
    setNotice(`Downloaded ${files.length} take${files.length === 1 ? '' : 's'}`)
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
          onExport={onDownloadTakes}
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
