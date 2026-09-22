import { fromStored, type LoadResult, type StoredPatch } from './serialize'

const KEY = 'fresyn.patch.v1'
/**
 * What the key was called before the app was renamed. Read as a fallback so
 * that a session open across the rename keeps its rack; the next autosave
 * writes the new key. It is never deleted here -- loadLocal is called during
 * render, where StrictMode runs it twice, and a removal on the first pass
 * would leave the second with nothing to find.
 */
const LEGACY_KEY = 'freeson.patch.v1'

/**
 * Autosave to the browser. Every accessor is guarded: storage throws outright
 * in a private window or with site data blocked, and losing the autosave is
 * never a reason to take the app down with it.
 */
export function saveLocal(stored: StoredPatch) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored))
  } catch {
    // Nothing to do; the session simply will not be restored.
  }
}

export function loadLocal(): LoadResult | null {
  let text: string | null = null
  try {
    text = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
  } catch {
    return null
  }
  if (!text) return null

  try {
    const result = fromStored(JSON.parse(text))
    return 'error' in result ? null : result
  } catch {
    return null
  }
}

export function clearLocal() {
  try {
    localStorage.removeItem(KEY)
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // ignored, as above
  }
}

/** Hand a file to the browser as a download. */
export function downloadBytes(data: BlobPart, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick so the click has taken the URL first.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadPatch(stored: StoredPatch) {
  downloadBytes(
    JSON.stringify(stored, null, 2),
    `${slug(stored.name)}.fresyn.json`,
    'application/json',
  )
}

export async function readPatchFile(file: File): Promise<LoadResult | { error: string }> {
  try {
    return fromStored(JSON.parse(await file.text()))
  } catch {
    return { error: `${file.name} is not valid JSON` }
  }
}

export function slug(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'patch'
}
