/**
 * Files on disk that the app can write back to, the way a desktop program
 * does: open a file, change it, and Save puts the changes in that file rather
 * than handing the browser a fresh download called "name (1).json".
 *
 * This is the File System Access API, which only Chromium browsers have.
 * Everywhere else `canUseFileHandles` is false and the caller keeps to the
 * download and the file input it always used.
 */

export interface FileKind {
  description: string
  /** MIME type to the extensions that count as one. */
  accept: Record<string, string[]>
}

interface OpenPickerOptions {
  types?: FileKind[]
  excludeAcceptAllOption?: boolean
  multiple?: boolean
}

interface SavePickerOptions {
  suggestedName?: string
  types?: FileKind[]
  excludeAcceptAllOption?: boolean
}

// The pickers are not in TypeScript's DOM library yet; the handles they
// return are.
declare global {
  interface Window {
    showOpenFilePicker?: (options?: OpenPickerOptions) => Promise<FileSystemFileHandle[]>
    showSaveFilePicker?: (options?: SavePickerOptions) => Promise<FileSystemFileHandle>
  }
}

export const canUseFileHandles =
  typeof window !== 'undefined' &&
  typeof window.showOpenFilePicker === 'function' &&
  typeof window.showSaveFilePicker === 'function'

/**
 * Ask for a file to open. Null when the picker is dismissed, which is a
 * choice and not an error.
 */
export async function pickFileToOpen(
  types: FileKind[],
): Promise<{ file: File; handle: FileSystemFileHandle } | null> {
  try {
    const [handle] = await window.showOpenFilePicker!({ types, multiple: false })
    return { file: await handle.getFile(), handle }
  } catch (e) {
    if (isCancel(e)) return null
    throw e
  }
}

/** Ask where to save. Null when the picker is dismissed. */
export async function pickFileToSave(
  suggestedName: string,
  types: FileKind[],
): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker!({ suggestedName, types })
  } catch (e) {
    if (isCancel(e)) return null
    throw e
  }
}

/**
 * Replace a file's contents. The first write to a file that was only opened
 * has the browser ask whether the page may change it, so this has to run in
 * answer to a click or a key -- a Save, in other words.
 */
export async function writeFile(handle: FileSystemFileHandle, data: BlobPart) {
  const stream = await handle.createWritable()
  // The browser writes to a scratch copy and only swaps it in on close, so a
  // write that fails is abandoned and the file on disk is left as it was.
  try {
    await stream.write(new Blob([data]))
  } catch (e) {
    await stream.abort().catch(() => {})
    throw e
  }
  await stream.close()
}

function isCancel(e: unknown) {
  return e instanceof DOMException && e.name === 'AbortError'
}
