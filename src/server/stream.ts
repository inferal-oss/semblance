// A rendered document as a stream: the head goes out as soon as the address is read (the
// stylesheet and the preloads in it start loading), the root's HTML once the projection is done.
// The projection is the cost (rules); serializing is a small part, so this is the streaming that
// pays: the browser fetches the client's files while the server runs the rules.
import { documentParts, type DocumentOptions } from './document.ts'
import { project, readyToRender, type RenderOptions } from './render.ts'

export interface StreamOptions extends RenderOptions, Omit<DocumentOptions, 'stylesheet'> {
  /** The template: the client build's index.html (with an empty mount element). */
  template: string
  /** The stylesheet to link (the CSS is not inline in a stream: it is known only after the head). */
  stylesheet?: { href: string } | 'none'
  /** Hear the response status once known (before the first chunk). */
  onStatus?: (status: number) => void
}

/** Render `root` at `url` into `template`, as a stream of UTF-8 chunks. */
export function renderToStream(opts: StreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const ready = await readyToRender(opts)
        opts.onStatus?.(ready.status)
        const [before, after] = documentParts(opts.template, { lang: ready.lang, dir: ready.dir }, { ...opts, stylesheet: opts.stylesheet ?? 'none' })
        controller.enqueue(encoder.encode(before))
        // Let the head reach the client before the rules run.
        await new Promise((r) => setTimeout(r, 0))
        const { html, runtime } = project({ ...opts, styles: false }, ready.languages)
        controller.enqueue(encoder.encode(html + after))
        runtime.dispose()
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
  })
}
