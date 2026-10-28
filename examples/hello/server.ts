// The app served by Node, every page rendered per request and taken over by the client:
//   npx vite build examples/hello && npx tsx examples/hello/server.ts
// (`npx semblance serve --assets dist` in an app's own directory does the same.)
import { createHandler, listen, loadSite } from '@inferal-oss/semblance/node'

const here = new URL('.', import.meta.url).pathname
const site = await loadSite(here + 'semblance.config.ts')
await listen(createHandler({ site, assets: here + 'dist' }), Number(process.env.PORT ?? 3000))
console.log(`http://localhost:${process.env.PORT ?? 3000}/`)
