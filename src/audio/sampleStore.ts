import { crc32 } from './zip'

/**
 * A sample as it is kept between sessions: the file exactly as it arrived.
 *
 * The original bytes rather than the decoded audio, for three reasons that
 * all point the same way. Nothing is re-encoded, so a bundle round trip loses
 * nothing and no bit depth has to be chosen for anybody. Whatever the browser
 * can decode is supported for free -- WAV, MP3, OGG, FLAC -- because the only
 * thing that ever interprets these bytes is `decodeAudioData`. And the file
 * that goes into a shared bundle is the file the user dropped, under its own
 * name.
 */
export interface StoredSample {
  /** Content hash: the same file dropped twice is the same sample. */
  id: string
  name: string
  /** MIME type as the browser reported it, for writing the bundle back out. */
  type: string
  bytes: ArrayBuffer
}

const DB_NAME = 'fresyn'
const DB_VERSION = 1
const STORE = 'samples'

/**
 * A content hash, from the CRC the zip writer already needed.
 *
 * Not `crypto.subtle.digest`, which is the obvious answer and is unavailable
 * outside a secure context -- the app is opened from a plain http address on
 * a LAN often enough that "hashing is broken here" would be a real bug. A CRC
 * and a length, on files a person picked by hand, will not collide.
 */
export function idFor(bytes: ArrayBuffer): string {
  const crc = crc32(new Uint8Array(bytes))
  return `${crc.toString(16).padStart(8, '0')}-${bytes.byteLength.toString(16)}`
}

let opening: Promise<IDBDatabase | null> | null = null

/**
 * The database, or null where there is not one.
 *
 * Null rather than a throw: a private window, blocked site data or a browser
 * that refuses the quota all mean the same thing to the rack, which is that
 * samples last as long as the session does. That is a worse experience, not a
 * broken one, so every call here degrades instead of failing.
 */
function open(): Promise<IDBDatabase | null> {
  if (!opening) {
    opening = new Promise((resolve) => {
      let request: IDBOpenDBRequest
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION)
      } catch {
        resolve(null)
        return
      }
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    })
  }
  return opening
}

function run<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const tx = db.transaction(STORE, mode)
          const request = body(tx.objectStore(STORE))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(null)
          tx.onerror = () => resolve(null)
          tx.onabort = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

export function putSample(sample: StoredSample): Promise<void> {
  return run('readwrite', (store) => store.put(sample) as IDBRequest<IDBValidKey>).then(() => {})
}

export function getSample(id: string): Promise<StoredSample | null> {
  return run('readonly', (store) => store.get(id) as IDBRequest<StoredSample | undefined>).then(
    (found) => found ?? null,
  )
}

export function removeSample(id: string): Promise<void> {
  return run('readwrite', (store) => store.delete(id) as IDBRequest<undefined>).then(() => {})
}

export function allSamples(): Promise<StoredSample[]> {
  return run('readonly', (store) => store.getAll() as IDBRequest<StoredSample[]>).then(
    (found) => found ?? [],
  )
}

/**
 * Ask the browser to stop treating this origin's storage as disposable.
 *
 * Best effort by design: the answer is the browser's, it is usually decided
 * by how much the user has used the site, and it is never worth blocking on.
 * Without it a sample can be evicted under disk pressure, which lands a patch
 * in exactly the state a shared patch is already in -- naming a file that is
 * not here -- so nothing depends on the answer.
 */
export function askToPersist() {
  void navigator.storage?.persist?.().catch(() => false)
}
