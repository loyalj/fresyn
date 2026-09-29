import { useEffect, useRef } from 'react'

interface Props {
  /** Every step, oldest first: the first is where the session started. */
  labels: string[]
  /** The step you are on. Everything after it is what undo put aside. */
  current: number
  onJump: (index: number) => void
  onClose: () => void
}

/**
 * The undo history as a list, for going back several steps in one click.
 *
 * Not a sheet: nothing behind it is out of reach while it is up, because the
 * point is to watch the rack and the roll change as you step through it.
 * Ctrl+Z and Ctrl+Y still work with it open and it follows them. The steps
 * after the one you are on are dimmed rather than gone -- they are still
 * there to jump forward to, until the next edit replaces them.
 */
export function HistoryPanel({ labels, current, onJump, onClose }: Props) {
  const list = useRef<HTMLOListElement>(null)

  // Keep the step you are on in view as undo moves it.
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[aria-current="step"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [current, labels.length])

  return (
    <section className="history-panel" aria-labelledby="history-title">
      <header className="history-head">
        <h2 id="history-title">History</h2>
        <span className="history-count">
          {current} of {labels.length - 1}
        </span>
        <button className="sheet-close" onClick={onClose} aria-label="Close history" title="Close" type="button">
          ×
        </button>
      </header>
      <ol className="history-list" ref={list}>
        {labels.map((label, i) => (
          <li key={i}>
            <button
              type="button"
              className={`history-step${i === current ? ' current' : ''}${i > current ? ' undone' : ''}`}
              aria-current={i === current ? 'step' : undefined}
              onClick={() => onJump(i)}
              title={
                i === current
                  ? 'You are here'
                  : i < current
                    ? `Go back ${current - i} step${current - i > 1 ? 's' : ''}`
                    : `Go forward ${i - current} step${i - current > 1 ? 's' : ''}`
              }
            >
              <span className="history-index">{i}</span>
              <span className="history-label">{label}</span>
            </button>
          </li>
        ))}
      </ol>
      <footer className="history-foot">Click a step to go straight to it</footer>
    </section>
  )
}
