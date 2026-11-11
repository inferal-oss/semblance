// The page: views over the todo store, kept up to date by its deltas, drawn by React. No ontology,
// no renderer: the store's stream (docs/REMOTE.md) goes into a store of Semblance's engine, the
// views follow it, and the components read the views.
import { followSource, httpTransport, openViews } from '@inferal-oss/semblance/views'
import { createRoot } from 'react-dom/client'
import { App } from './Todos.tsx'
import { patterns, todoViews } from './todos.ts'

const views = await openViews({ kind: 'wat' })
const { open, counts } = todoViews(views)
const source = followSource(views, httpTransport({ url: new URL('/store/', location.href).href }), { patterns })
await source.ready
createRoot(document.getElementById('app')!).render(<App open={open} counts={counts} />)
performance.mark('views:shown')
