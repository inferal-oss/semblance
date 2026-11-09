# Cloudflare Workers

A Semblance app can be rendered per request at the edge. A Worker renders each page with
Semblance's WebAssembly engine from the part of the ontology the app uses, and keeps one warm
runtime per isolate, so a request costs what its address changes. The client's files come from
Workers static assets, and the client takes the page over as it does any server-rendered page
([SSR.md](SSR.md)). The example is `examples/workers/`: examples/hello as a Worker (#383).

```bash
npx vite build --config examples/hello/vite.config.ts
```

```bash
npx semblance subset --config examples/hello/semblance.config.ts --out examples/workers/build/ontology.ttl
```

```bash
npx wrangler@4 dev --config examples/workers/wrangler.jsonc
```

The first command builds the client (and its pages, and `semblance.css` from the subset), the
second writes the subset of the ontology the Worker loads, the third serves the Worker locally
(`wrangler deploy` with the same config deploys it). `scripts/workers-check.sh` runs all three and
requests a page, a page again, an address that names nothing and the stylesheet.

## The Worker

```ts
import { engineStore, renderDocument, warmRenderer } from '@inferal-oss/semblance/server'
import wat from '@inferal-oss/semblance/wasm/wat.wasm' // a WebAssembly.Module
import ontology from './build/ontology.ttl' // `semblance subset`
import app from './app.ttl'

const renderer = warmRenderer({
  root: 'https://example.org/hello#page',
  load() {
    const store = engineStore(wat, 'wat')
    for (const turtle of [ontology, app]) store.loadTurtle(turtle)
    return store
  },
  styles: false, // the build's semblance.css
})

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }) {
    const url = new URL(request.url)
    if (/\.\w+$/.test(url.pathname) && !url.pathname.endsWith('.html')) return env.ASSETS.fetch(request)
    const template = await (await env.ASSETS.fetch(new Request(new URL('/404.html', url)))).text()
    const rendered = await renderer.render(url.pathname + url.search)
    const page = renderDocument(template, rendered, { stylesheet: { href: '/semblance.css' }, attributes: rendered.attributes })
    return new Response(page, { status: rendered.status, headers: { 'content-type': 'text/html; charset=utf-8' } })
  },
}
```

`@inferal-oss/semblance/server` is platform-neutral: it reads no files and fetches nothing. What a
Worker needs differently from Node:

- **The engine is a module.** A Worker may not compile WebAssembly at run time, so the engine's
  `.wasm` is imported (wrangler compiles it when the Worker is deployed) and handed to
  `engineStore`. Compiled queries (`compile` in the engine's options) stay off for the same reason.
- **No filesystem.** The app's Turtle and the subset are bundled as text (`rules` in
  `wrangler.jsonc`: `**/*.ttl` as `Text`). `semblance subset` writes the subset from the site
  description beforehand: computing it in the Worker would mean bundling and parsing the whole
  ontology (4.6 MB) at startup.
- **Node's stream and buffer.** The Turtle parser (N3) uses them: `compatibility_flags:
  ["nodejs_compat"]`.
- **Static assets.** `assets.directory` is the client build; with `run_worker_first` the Worker
  answers every request and hands files to the `ASSETS` binding, so every page, `/` included, is
  rendered for the request rather than served from the build's pre-rendered `index.html`. Leave
  `run_worker_first` off to serve the pre-rendered pages as files and render only addresses the
  build did not.

## Limits and costs

| examples/hello in `wrangler dev` | |
|---|---:|
| the Worker's bundle (framework, subset, app), gzipped | about 600 KiB, within the 3 MiB of the free plan |
| first request in an isolate (load the subset, project) | 80–115 ms (about 18 ms of it rendering, measured in Node) |
| every later request | 2–3 ms |

- **CPU.** The first request of an isolate loads the store and runs the first projection: about
  20 ms of CPU for examples/hello. The free plan allows 10 ms of CPU per request on average, so an
  app this size fits the paid plan, or the free plan when isolates are reused (later requests cost
  well under a millisecond of rendering). A larger app costs more on its first request: keep it to
  its subset, and to the graphs a page needs.
- **Memory.** An isolate has 128 MB. examples/hello's store and runtime are a few MB; one runtime is
  kept per language the app renders in.
- **One request at a time.** The warm renderer renders requests in turn; rendering does not wait on
  I/O, so an isolate is not held up by one. A render that fails drops the runtime, and the next
  request loads afresh.
- **Caching.** A page depends on its address only (the warm runtime is moved back from each
  address), so a page can be cached by its URL (`cache-control`, or the Cache API) when the app's
  data does not change between deployments.
- **What the app can do there.** Per-request rendering runs no host effects: no persistence, no
  timers, no network capture. What the graph says the page shows at its address is what is
  rendered; the client does the rest after it takes the page over.
