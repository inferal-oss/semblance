// semblance.dev as a site (src/server/site.ts): what `vite build` renders beforehand, one page per
// address (the Vite plugin in vite.config.ts), and what `semblance serve` renders per request.
// The host's own writes before its first projection are demo/site.ts, which demo/main.ts runs too.
import { readdirSync, readFileSync } from 'node:fs'
import { carryInFragment, documentAttributes, prepareSite, recordSiteSources, ROOT, siteGraphs, siteLayers } from './demo/site.ts'
import { defineSite } from './src/server/site.ts'

const demo = new URL('./demo/', import.meta.url)
const gallery = Object.fromEntries(
  readdirSync(new URL('gallery/', demo))
    .filter((f) => f.endsWith('.ttl'))
    .map((f) => ['demo/gallery/' + f, readFileSync(new URL('gallery/' + f, demo), 'utf8')]),
)

export default defineSite({
  root: ROOT,
  graphs: () => siteGraphs(readFileSync(new URL('app.ttl', demo), 'utf8'), gallery),
  setup(store, { single }) {
    recordSiteSources(store, gallery)
    if (single) carryInFragment(store)
  },
  // The defaults a visitor's address does not change (?store=, ?prefer=, ?compile= are the client's).
  prepare: (store) => prepareSite(store, { kind: 'wat', prefer: 'sparql', compile: 'off' }),
  layers: siteLayers,
  documentAttributes,
})
