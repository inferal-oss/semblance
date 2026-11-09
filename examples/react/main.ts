// The todo app's graph (src/examples/todo.ts), drawn by a design system of the example's own
// (design-system.tsx) through @inferal-oss/semblance-react. Semblance projects, reacts and renders the
// text; React draws the hosted components. The page is rendered at build time and taken over here.
import { L10N } from '@inferal-oss/semblance'
import { mount } from '@inferal-oss/semblance/web'
import { reactHosts } from '@inferal-oss/semblance-react'
import { todoApp, todoReactions } from '../../src/examples/todo.ts'
import app from './app.ttl?raw'
import bindings from './bindings.ttl?raw'
import { components } from './design-system.tsx'
import './design-system.css'

const SHELL = 'https://example.org/react#shell'

const mounted = await mount(document.getElementById('app')!, {
  root: SHELL,
  graphs: [todoApp(5), bindings, app],
  reactions: todoReactions,
  hosts: reactHosts({ components }),
  onHandled: language,
})

/** The viewer's language (l10n:language on the shell) is the projection's, and a right-to-left one flips the page. */
function language() {
  const { store, projection } = mounted
  const f = store.factory
  const chosen = store.match(f.namedNode(SHELL), f.namedNode(L10N.language), null, f.defaultGraph())[0]?.object
  if (!chosen) return
  const code = store.match(chosen as never, f.namedNode(L10N.code), null, f.defaultGraph())[0]?.object.value ?? 'en'
  const rtl = store.match(chosen as never, f.namedNode(L10N.direction), f.namedNode(L10N.RTL), f.defaultGraph()).length > 0
  if (projection.engine.languages[0] !== code) projection.engine.reconfigure({ languages: [code] }), mounted.flush()
  document.documentElement.lang = code
  document.documentElement.dir = rtl ? 'rtl' : 'ltr'
}
language()
Object.assign(globalThis, { semblance: mounted })
