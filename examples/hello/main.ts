import { mount } from '@inferal-oss/semblance/web'
import app from './app.ttl?raw'
import tally from './tally.ttl?raw'

await mount(document.getElementById('app')!, { root: 'https://example.org/hello#page', graphs: [tally, app] })
