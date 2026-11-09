// The page, bound to the store: the graph declares the source (ex:store in app.ttl), and the host
// says where the store is. The remote-sources effect loads the todos, follows the store's changes
// and sends the page's back (docs/REMOTE.md).
import { mount } from '@inferal-oss/semblance/web'
import app from './app.ttl?raw'

const EX = 'https://example.org/remote#'

await mount(document.getElementById('app')!, {
  root: EX + 'page',
  graphs: [app],
  sources: { endpoints: { [EX + 'store']: { url: new URL('/store/', location.href).href } } },
})
