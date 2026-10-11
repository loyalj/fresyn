import { createContext, useContext } from 'react'
import type { ModuleDef } from '../patch/types'
import { useFace } from './useFace'

/**
 * What a Track In can be pointed at: the song's tracks, and whether hearing
 * each from the track on the bench would close a loop. Handed down by the
 * app, since a rack on its own knows nothing of the song.
 */
export interface TrackChoices {
  /** The track whose rack is on the bench, which cannot hear itself. */
  self: string
  tracks: readonly { id: string; name: string }[]
  /** Whether the rack on the bench may hear this track. */
  canHear: (id: string) => boolean
}

export const TrackChoicesContext = createContext<TrackChoices | null>(null)

interface Props {
  def: ModuleDef
  /** The track it hears, by id, as the patch has it; absent is none. */
  text?: string
  onText?: (text: string) => void
  valueOf: (paramId: string) => number | undefined
  onChange: (paramId: string, value: number) => void
}

/**
 * The Track In's panel: which track it hears, and how loud. A track that
 * would close a loop is offered greyed out rather than refused after it is
 * picked, as the Mix view's routes are.
 */
export function TrackInFace({ def, text, onText, valueOf, onChange }: Props) {
  const choices = useContext(TrackChoicesContext)
  const { control } = useFace(def, valueOf, onChange)
  const others = choices?.tracks.filter((t) => t.id !== choices.self) ?? []
  const current = text ?? ''
  // Pointed at a track that has since gone, or opened outside a song.
  const lost = current !== '' && !others.some((t) => t.id === current)
  return (
    <div className="trackin-face">
      <select
        className="trackin-source"
        value={current}
        aria-label="Track it hears"
        title="The track this hears, straight out of its rack: before its fader, so a muted track is heard too"
        onChange={(e) => onText?.(e.target.value)}
      >
        <option value="">No track</option>
        {others.map((t) => (
          <option key={t.id} value={t.id} disabled={t.id !== current && !choices!.canHear(t.id)}>
            {t.name}
          </option>
        ))}
        {lost && <option value={current}>(gone)</option>}
      </select>
      <div className="controls">{def.params.map((spec) => control(spec.id))}</div>
    </div>
  )
}
