import { mount } from '@inferal-oss/semblance/web'
import app from './app.ttl?raw'
import tally from './tally.ttl?raw'
// The part of Semblance's ontology the app uses (semblance.config.ts: subset), from the Vite plugin.
import ontology from 'virtual:semblance/ontology'

await mount(document.getElementById('app')!, { root: 'https://example.org/hello#page', graphs: [tally, app], ontology })
