export interface ZipEntry {
  name: string
  // Pinned to ArrayBuffer: a SharedArrayBuffer-backed view cannot go into a
  // Blob, so the download would not type-check.
  data: Uint8Array<ArrayBuffer>
}

/**
 * A minimal store-only ZIP writer.
 *
 * No compression and no dependency: PCM audio barely compresses, and a batch
 * of variations needs to arrive as one file rather than as sixteen downloads
 * the browser will start blocking after the first few.
 */
export function makeZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method: stored
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0x2821, true) // mod date: 2000-01-01
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true) // compressed size
    lv.setUint32(22, size, true) // uncompressed size
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true) // extra length
    local.set(name, 30)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true) // central directory header
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x2821, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk number
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true) // offset of local header
    central.set(name, 46)

    locals.push(local, entry.data)
    centrals.push(central)
    offset += local.length + size
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true) // end of central directory
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true) // comment length

  return concat([...locals, ...centrals, end])
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

let table: Uint32Array | null = null

/**
 * Read a zip back, which is only worth having because we write them.
 *
 * Through the central directory rather than by walking the local headers.
 * Our own writer puts the sizes in both places, but an archive that has been
 * unzipped, edited and zipped again by a file manager may carry them in a
 * trailing descriptor instead, leaving the local header saying zero -- and
 * the central directory is the one place they are always right.
 *
 * Stored entries come out as they went in. Deflated ones -- which is what
 * anything re-zipped elsewhere will be -- go through the browser's own
 * decompressor, so reading somebody else's bundle still costs no dependency.
 */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()

  // The end record is last, but may be followed by a comment, so it is found
  // by scanning back rather than by arithmetic.
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')

  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []

  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) break
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localAt = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength

    // The local header repeats the name and carries its own extra field,
    // which is often a different length from the central one.
    const localName = view.getUint16(localAt + 26, true)
    const localExtra = view.getUint16(localAt + 28, true)
    const from = localAt + 30 + localName + localExtra
    const raw = bytes.slice(from, from + compressed)

    if (method === 0) {
      entries.push({ name, data: raw as Uint8Array<ArrayBuffer> })
    } else if (method === 8) {
      entries.push({ name, data: await inflate(raw) })
    } else {
      throw new Error(`${name} is compressed in a way this cannot read`)
    }
  }

  return entries
}

async function inflate(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  const out = new Uint8Array(await new Response(stream).arrayBuffer())
  return out as Uint8Array<ArrayBuffer>
}

export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
