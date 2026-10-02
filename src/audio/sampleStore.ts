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

/**
 * Stamped with when it went in, which is what `pruneSamples` leaves alone for
 * a while: a file dropped a moment ago may not have reached the autosave yet,
 * and another tab starting up should not take it for an orphan.
 */
export function putSample(sample: StoredSample): Promise<void> {
  askToPersist()
  const stamped: StoredSample & { addedAt: number } = { ...sample, addedAt: Date.now() }
  return run('readwrite', (store) => store.put(stamped) as IDBRequest<IDBValidKey>).then(() => {})
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

/** How long a sample is safe from pruning after it was stored. */
const PRUNE_GRACE_MS = 60 * 60 * 1000

/**
 * Delete every stored sample nothing refers to any more, and say how many.
 *
 * Every file dropped on a Sampler is stored, and a file dropped by mistake,
 * replaced, or left in a patch that was then thrown away is still stored --
 * so without this the database only ever grows. `keep` is every id something
 * still names: the open project, the saved-patches shelf, anything else that
 * holds a patch.
 *
 * Deliberately timid, because deleting audio somebody wanted is far worse
 * than keeping audio nobody does. A null `keep` -- the caller could not read
 * one of the places a patch lives, so does not actually know what is in use
 * -- deletes nothing. Nor does anything stored within the last hour, which
 * covers a drop not yet autosaved and a second tab working on something this
 * one has never seen. And any failure part way through stops where it is:
 * what was not reached is kept.
 */
export function pruneSamples(keep: Iterable<string> | null): Promise<number> {
  if (keep === null) return Promise.resolve(0)
  const wanted = new Set(keep)
  const cutoff = Date.now() - PRUNE_GRACE_MS
  return open().then(
    (db) =>
      new Promise<number>((resolve) => {
        if (!db) {
          resolve(0)
          return
        }
        let removed = 0
        try {
          const tx = db.transaction(STORE, 'readwrite')
          const request = tx.objectStore(STORE).openCursor()
          request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) return
            const value = cursor.value as Partial<StoredSample> & { addedAt?: unknown }
            const recent = typeof value.addedAt === 'number' && value.addedAt > cutoff
            if (typeof value.id === 'string' && !wanted.has(value.id) && !recent) {
              cursor.delete()
              removed++
            }
            cursor.continue()
          }
          request.onerror = () => resolve(0)
          tx.oncomplete = () => resolve(removed)
          // An aborted transaction deletes nothing, whatever was counted.
          tx.onerror = () => resolve(0)
          tx.onabort = () => resolve(0)
        } catch {
          resolve(0)
        }
      }),
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
  if (asked) return
  asked = true
  void navigator.storage?.persist?.().catch(() => false)
}

/**
 * Asked with the first sample stored, not as the page opens: Firefox answers
 * with a permission prompt, and a prompt about storage on a first visit, before
 * anything has been stored, is a question nobody can make sense of.
 */
let asked = false
