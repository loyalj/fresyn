import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppBoundary } from './ui/ErrorBoundary'
import { applyAppearance, loadAppearance } from './ui/theme'
import './app.css'

// Before the first render, not during it: React would paint one frame of the
// default rack before a mount effect could repaint it, and a flash of the
// wrong theme on every load is worse than no theme at all.
applyAppearance(loadAppearance())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost, so that whatever throws, the page still has a way to hand
        back the autosave rather than going blank. */}
    <AppBoundary>
      <App />
    </AppBoundary>
  </StrictMode>,
)
