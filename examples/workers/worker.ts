// examples/hello served by a Cloudflare Worker (docs/WORKERS.md): every page rendered per request
// by a warm runtime kept in the isolate, from the part of Semblance's ontology the app uses; the
// client's files (scripts, the engine, the stylesheet) from Workers static assets.
//   npx vite build --config examples/hello/vite.config.ts
//   npx semblance subset --config examples/hello/semblance.config.ts --out examples/workers/build/ontology.ttl
//   npx wrangler@4 dev --config examples/workers/wrangler.jsonc
import { engineStore, renderDocument, warmRenderer } from '@inferal-oss/semblance/server'
// A .wasm import is a WebAssembly.Module, compiled when the Worker is deployed (a Worker may not
// compile WebAssembly from bytes at run time).
import wat from '../../rdf-engine/build/wat.wasm'
// What the second command above writes: `semblance subset` of the app's site description.
import ontology from './build/ontology.ttl'
import tally from '../hello/tally.ttl'
import app from '../hello/app.ttl'

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

// One per isolate: the first request loads the store and projects it (about 20 ms of CPU for this
// app), every later one moves it to its address.
const renderer = warmRenderer({
  root: 'https://example.org/hello#page',
  load() {
    // Compiled queries stay off: they compile WebAssembly at run time.
    const store = engineStore(wat, 'wat')
    for (const turtle of [ontology, tally, app]) store.loadTurtle(turtle)
    return store
  },
  // The stylesheet is the build's (semblance.css, compiled from the same subset).
  styles: false,
})

let template: Promise<string> | undefined

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // A file of the client build is served as it is.
    if (/\.\w+$/.test(url.pathname) && !url.pathname.endsWith('.html')) return env.ASSETS.fetch(request)
    // The client alone (the build's 404.html) is the template every page is rendered into.
    template ??= env.ASSETS.fetch(new Request(new URL('/404.html', url))).then((r) => r.text())
    const rendered = await renderer.render(url.pathname + url.search)
    const page = renderDocument(await template, rendered, { stylesheet: { href: '/semblance.css' }, attributes: rendered.attributes })
    return new Response(page, { status: rendered.status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
  },
}
