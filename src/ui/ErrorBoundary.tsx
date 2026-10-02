import { Component, type ErrorInfo, type ReactNode } from 'react'
import { clearLocal, downloadBytes, readLocalProjectText } from '../patch/storage'
import { ConfirmButton } from './ConfirmButton'

interface State {
  error: Error | null
}

/**
 * What the page shows when the app itself has failed to draw.
 *
 * Without one of these React unmounts the whole tree on an error during
 * render and leaves a blank page -- and the next load reads the same
 * autosave and fails the same way, so a project that trips a bug is a
 * project that can never be opened again. The screen offers the two ways
 * out of that: take the work away as a file, and start over without it.
 *
 * Written against storage directly rather than through anything in the app,
 * because whatever threw may be anywhere in the app.
 */
export class AppBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[fresyn] the app failed to draw', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const saved = readLocalProjectText()

    return (
      <div className="crash" role="alert">
        <h1>Fresyn stopped</h1>
        <p>
          Something went wrong drawing the app: <code>{error.message || String(error)}</code>
        </p>
        <p>
          {saved
            ? 'The last autosave is still in this browser. Download it first -- it is an ordinary project file, and Open project reads it back -- and then start fresh if reloading keeps landing here.'
            : 'There is no autosave in this browser to rescue.'}
        </p>
        <div className="crash-actions">
          {saved && (
            <button
              className="export-go"
              type="button"
              onClick={() => downloadBytes(saved, 'fresyn-autosave.json', 'application/json')}
            >
              Download autosave
            </button>
          )}
          <button className="panel-cancel" type="button" onClick={() => location.reload()}>
            Reload
          </button>
          {/* Asks, because it is the one thing on this screen that cannot be
              taken back: the autosave is the only copy of whatever was not
              saved to a file. */}
          <ConfirmButton
            className="panel-cancel"
            ask="Clear it?"
            onConfirm={() => {
              clearLocal()
              location.reload()
            }}
            title="Forget the autosave and reload with an empty project"
          >
            Start fresh
          </ConfirmButton>
        </div>
      </div>
    )
  }
}

interface UnitProps {
  moduleId: string
  /**
   * Take the broken unit out of the rack, which is undoable as ever. Handed
   * the id rather than closed over it, so the rack's one stable handler can
   * be passed straight in.
   */
  onRemove: (moduleId: string) => void
  children: ReactNode
}

/**
 * One rack unit's own safety net.
 *
 * A panel that throws -- a face handed a value it did not expect, say --
 * takes only itself down: the rest of the rack keeps playing and stays
 * editable, and the broken unit is a small card saying which it was, with a
 * way to try again and a way to take it out. Carries the same class and
 * data attribute as a unit so the rack's drag and index still find it.
 */
export class UnitBoundary extends Component<UnitProps, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[fresyn] ${this.props.moduleId} failed to draw`, error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { moduleId, onRemove } = this.props
    return (
      <div className="unit-flip unit-error" data-module={moduleId} role="alert">
        <div className="unit-error-card">
          <span>
            <strong>{moduleId}</strong> could not be drawn: {error.message || String(error)}
          </span>
          <button className="panel-cancel" type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="panel-cancel" type="button" onClick={() => onRemove(moduleId)}>
            Remove
          </button>
        </div>
      </div>
    )
  }
}
