// semblance.dev as a site (src/server/site.ts): what `vite build` renders beforehand, one page per
// address (the Vite plugin in vite.config.ts), and what `semblance serve` renders per request.
// The host's own writes before its first projection are demo/site.ts, which demo/main.ts runs too.
import { readdirSync, readFileSync } from 'node:fs'
import { carryInFragment, documentAttributes, FIRST_GRAPHS, prepareSite, recordSiteSources, ROOT, siteLayers, siteNamedGraphs } from './demo/site.ts'
import { defineSite } from './src/server/site.ts'

const demo = new URL('./demo/', import.meta.url)
const gallery = Object.fromEntries(
  readdirSync(new URL('gallery/', demo))
    .filter((f) => f.endsWith('.ttl'))
    .map((f) => ['demo/gallery/' + f, readFileSync(new URL('gallery/' + f, demo), 'utf8')]),
)

export default defineSite({
  root: ROOT,
  graphs: () => siteNamedGraphs(readFileSync(new URL('app.ttl', demo), 'utf8'), gallery),
  // Each page names the graphs its client needs first (the rest load in idle time); app.ttl and
  // the todo example's come with the client.
  pageGraphs: { always: FIRST_GRAPHS },
  setup(store, { single, graphs }) {
    recordSiteSources(store, gallery, graphs)
    if (single) carryInFragment(store)
  },
  // The defaults a visitor's address does not change (?store=, ?prefer=, ?compile= are the client's).
  prepare: (store) => prepareSite(store, { kind: 'wat', prefer: 'sparql', compile: 'off' }),
  layers: siteLayers,
  documentAttributes,
  // Every place in every language, but the Reference's 1,600 terms in English only: a term's page
  // is about 100 KB, and all four languages would make the site 650 MB. A term in another language
  // is rendered by the client (404.html), as any address the build did not render.
  routes: (found) => found.filter((r) => !/^\/(uk|de|ar)\/reference\/[^/]+\/$/.test(r)),
})
