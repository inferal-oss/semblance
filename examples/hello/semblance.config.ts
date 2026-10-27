// The app as a site (docs/SSR.md): what `semblance build` renders beforehand and `semblance serve`
// (or server.ts) renders per request. The client (main.ts) mounts the same graphs at the same root.
import { readFileSync } from 'node:fs'
import { defineSite } from '@inferal-oss/semblance/node'

const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')

export default defineSite({
  root: 'https://example.org/hello#page',
  graphs: () => [read('tally.ttl'), read('app.ttl')],
})
