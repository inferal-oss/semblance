// Where the files effect (src/files.ts) keeps files in the browser (file:Store, ontology/layers/files.ttl),
// and how it makes their previews. The graph never sees the bytes: a kept file is a record here under its
// file:handle - its contents, a small preview if it is an image, and enough metadata to account for it
// (its size and its store) - and the effect tells the graph only addresses (object URLs) and totals.
import type { FileLike } from './files.ts'

/** One kept file. */
export interface KeptFile {
  /** The file:Store it is kept for (its IRI). */
  store: string
  name: string
  type: string
  size: number
  /** The contents (a Blob, or a stand-in in tests). */
  contents: Blob | FileLike
  /** A small picture of it (images only), if one could be made. */
  preview?: Blob
}

/** Where kept files live. Asynchronous, so IndexedDB fits; a memory stand-in for tests. */
export interface FileStoreBackend {
  put(handle: string, file: KeptFile): Promise<void>
  get(handle: string): Promise<KeptFile | undefined>
  remove(handle: string): Promise<void>
  /** Every kept file, by handle (read once, when the effect starts). */
  all(): Promise<Map<string, KeptFile>>
}

export function memoryFileStore(): FileStoreBackend & { readonly files: Map<string, KeptFile> } {
  const files = new Map<string, KeptFile>()
  return {
    files,
    put: async (h, f) => void files.set(h, f),
    get: async (h) => files.get(h),
    remove: async (h) => void files.delete(h),
    all: async () => new Map(files),
  }
}

/** Kept files in an IndexedDB database of their own (Blobs are stored as they are: the browser keeps them on disk). */
export function indexedDbFileStore(name = 'semblance-files'): FileStoreBackend {
  let opened: Promise<IDBDatabase> | undefined
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('files')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }))
  const tx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) => {
    const d = await db()
    return new Promise<T>((resolve, reject) => {
      const t = d.transaction('files', mode)
      const r = run(t.objectStore('files'))
      // A write counts once it is committed (a full disk fails the transaction, not the request).
      t.oncomplete = () => resolve(r.result)
      t.onerror = () => reject(t.error ?? r.error)
      t.onabort = () => reject(t.error ?? new Error('The browser did not keep it.'))
    })
  }
  return {
    put: async (h, f) => void (await tx('readwrite', (s) => s.put(f, h))),
    get: async (h) => (await tx<KeptFile | undefined>('readonly', (s) => s.get(h) as IDBRequest<KeptFile | undefined>)) ?? undefined,
    remove: async (h) => void (await tx('readwrite', (s) => s.delete(h))),
    all: async () => {
      const d = await db()
      return new Promise((resolve, reject) => {
        const out = new Map<string, KeptFile>()
        const req = d.transaction('files', 'readonly').objectStore('files').openCursor()
        req.onsuccess = () => {
          const c = req.result
          if (!c) return resolve(out)
          out.set(String(c.key), c.value as KeptFile)
          c.continue()
        }
        req.onerror = () => reject(req.error)
      })
    },
  }
}

/** Makes a small picture of an image (or answers undefined when it cannot). */
export type Thumbnailer = (image: Blob | FileLike, size: number) => Promise<Blob | undefined>

/** The longest side of a preview, in pixels. */
export const PREVIEW_SIZE = 192

/**
 * A preview in this thread, without putting the image in the page: the browser decodes it straight
 * to the small size (createImageBitmap's resize; no <img>, no full-size bitmap kept), and an
 * OffscreenCanvas encodes it as WebP (a few kB). Works in a worker as well (thumbnail.worker.ts).
 */
export const decodeThumbnail: Thumbnailer = async (image, size) => {
  const g = globalThis as { createImageBitmap?: typeof createImageBitmap; OffscreenCanvas?: typeof OffscreenCanvas }
  if (!g.createImageBitmap || !g.OffscreenCanvas || !(image instanceof Blob)) return undefined
  // Decoded to `size` pixels wide (the height follows the aspect ratio), never at full size; a tall
  // image is then drawn smaller still, to fit `size` both ways.
  const bitmap = await g.createImageBitmap(image, { resizeWidth: size, resizeQuality: 'medium' }).catch(() => undefined)
  if (!bitmap) return undefined
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new g.OffscreenCanvas(w, h)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.75 }).catch(() => undefined)
}

/** Previews made in a Web Worker (thumbnail.worker.ts), so decoding never holds up the page; one worker, asked in turn. */
export function workerThumbnails(start: () => Worker): Thumbnailer {
  let worker: Worker | undefined
  let next = 0
  const waiting = new Map<number, (b: Blob | undefined) => void>()
  return (image, size) => {
    if (!(image instanceof Blob)) return Promise.resolve(undefined)
    if (!worker) {
      worker = start()
      worker.onmessage = (e: MessageEvent<{ id: number; preview?: Blob }>) => {
        waiting.get(e.data.id)?.(e.data.preview)
        waiting.delete(e.data.id)
      }
    }
    const id = ++next
    return new Promise((resolve) => {
      waiting.set(id, resolve)
      worker!.postMessage({ id, image, size })
    })
  }
}
