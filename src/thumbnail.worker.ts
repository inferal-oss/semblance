// The preview worker (src/file-store.ts workerThumbnails): it decodes an image straight to a small
// size and encodes it, so the page that kept the file never decodes it at all.
import { decodeThumbnail } from './file-store.ts'

self.onmessage = async (e: MessageEvent<{ id: number; image: Blob; size: number }>) => {
  const preview = await decodeThumbnail(e.data.image, e.data.size).catch(() => undefined)
  ;(self as unknown as Worker).postMessage({ id: e.data.id, preview })
}
