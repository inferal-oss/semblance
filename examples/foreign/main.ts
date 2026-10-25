import { mount } from '@inferal-oss/semblance/web'
import app from './app.ttl?raw'
import foreign from './foreign.ttl?raw'
import { foreignExampleFunctions } from './functions.ts'
import { spark } from './spark.ts'
import { defineStarRating } from './star-rating.ts'

// The third-party code: a custom element defined as its library would, and a widget registered by name.
defineStarRating()
const mounted = await mount(document.getElementById('app')!, {
  root: 'https://example.org/foreign#page',
  graphs: [foreign, app],
  functions: foreignExampleFunctions,
  // Mounted by the islands effect: it pushes their inputs and turns their outputs into events.
  widgets: { spark },
})
Object.assign(globalThis, { semblance: mounted })
