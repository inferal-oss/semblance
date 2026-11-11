// useView / useRows (packages/react/src/views.ts, docs/VIEWS.md): React components over views of
// @inferal-oss/semblance/views. Renders are counted: a change re-renders the components whose view it
// changed, and only those; a change no view sees re-renders nothing. renderToString gives the server
// snapshot, and a client over the same data hydrates it without a mismatch.
import { parseHTML } from 'linkedom'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useRows, useView } from '../packages/react/src/views.ts'
import { openViews, type ViewHandle, type Views } from '../src/views/node.ts'

const EX = 'https://example.org/r#'
const P = `PREFIX ex: <${EX}>\n`
const DATA = `@prefix ex: <${EX}> .
ex:a a ex:Todo ; ex:label "Write" .
ex:b a ex:Todo ; ex:label "Read" ; ex:done true .
ex:c a ex:Todo ; ex:label "Ask" .
ex:note ex:text "unrelated" .
`

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function setup() {
  const views = await openViews({ kind: 'wat' })
  views.load(DATA)
  const open = views.select(EX + 'open', P + 'SELECT ?todo ?label WHERE { ?todo a ex:Todo ; ex:label ?label FILTER NOT EXISTS { ?todo ex:done true } } ORDER BY ?label')
  const done = views.select(EX + 'done', P + 'SELECT (COUNT(?todo) AS ?n) WHERE { ?todo a ex:Todo ; ex:done true }')
  const labels = views.construct(EX + 'labels', P + 'CONSTRUCT { ?t rdfs:label ?l } WHERE { ?t ex:label ?l }')
  return { views, open, done, labels }
}

function components() {
  const renders = { open: 0, done: 0, labels: 0, parent: 0 }
  function Open({ view }: { view: ViewHandle }) {
    renders.open++
    const rows = useRows(view)
    return createElement('ul', null, ...rows.map((r) => createElement('li', { key: r.todo }, r.label)))
  }
  function Done({ view }: { view: ViewHandle }) {
    renders.done++
    const [row] = useRows(view, (r) => Number(r.get('n')?.value ?? 0))
    return createElement('p', null, `${row ?? 0} done`)
  }
  function Labels({ view }: { view: ViewHandle }) {
    renders.labels++
    const { quads } = useView(view)
    return createElement('p', null, `${quads.length} labels`)
  }
  const App = ({ open, done, labels }: { open: ViewHandle; done: ViewHandle; labels: ViewHandle }): ReactNode => {
    renders.parent++
    return createElement('main', null, createElement(Open, { view: open }), createElement(Done, { view: done }), createElement(Labels, { view: labels }))
  }
  return { renders, App }
}

function dom(html = '') {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body><div id="app">${html}</div></body></html>`)
  Object.assign(globalThis, { window, document })
  return document.getElementById('app')!
}

const f = (views: Views) => views.store.factory
const tdone = (views: Views, s: string) => f(views).quad(f(views).namedNode(EX + s), f(views).namedNode(EX + 'done'), f(views).literal('true', f(views).namedNode('http://www.w3.org/2001/XMLSchema#boolean')))

describe('useView and useRows', () => {
  it('re-renders a component when its own view changes, and only then', async () => {
    const { views, open, done, labels } = await setup()
    const { renders, App } = components()
    const el = dom()
    const root = createRoot(el)
    await act(() => root.render(createElement(App, { open, done, labels })))
    expect(el.textContent).toBe('AskWrite1 done3 labels')
    expect(renders).toEqual({ open: 1, done: 1, labels: 1, parent: 1 })

    // Write done: the open todos and the count change, the labels do not.
    await act(() => void views.apply({ add: [tdone(views, 'a')], remove: [] }))
    expect(el.textContent).toBe('Ask2 done3 labels')
    expect(renders).toEqual({ open: 2, done: 2, labels: 1, parent: 1 })

    // A change no view reads: nothing re-renders.
    await act(() => void views.load(`@prefix ex: <${EX}> . ex:note ex:text "still unrelated" .`))
    expect(renders).toEqual({ open: 2, done: 2, labels: 1, parent: 1 })

    // A new label: only the CONSTRUCT's reader (the todo is not ex:Todo, so not open).
    await act(() => void views.load(`@prefix ex: <${EX}> . ex:x ex:label "Elsewhere" .`))
    expect(el.textContent).toBe('Ask2 done4 labels')
    expect(renders).toEqual({ open: 2, done: 2, labels: 2, parent: 1 })

    // Several changes in one transaction: one render per changed view.
    await act(() =>
      views.transaction(() => {
        views.apply({ add: [tdone(views, 'c')], remove: [] })
        views.apply({ add: [], remove: [tdone(views, 'a')] })
      }),
    )
    expect(el.textContent).toBe('Write2 done4 labels')
    expect(renders).toEqual({ open: 3, done: 2, labels: 2, parent: 1 })
    await act(() => root.unmount())
    views.dispose(true)
  })

  it('gives readers of one view the same snapshot until it changes', async () => {
    const { views, open } = await setup()
    const seen: unknown[] = []
    function Reader() {
      seen.push(useRows(open))
      return null
    }
    const root = createRoot(dom())
    await act(() => root.render(createElement('div', null, createElement(Reader), createElement(Reader))))
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
    await act(() => void views.apply({ add: [tdone(views, 'a')], remove: [] }))
    expect(seen).toHaveLength(4)
    expect(seen[2]).toBe(seen[3])
    expect(seen[2]).not.toBe(seen[0])
    await act(() => root.unmount())
    views.dispose(true)
  })

  it('renders on the server from the views as they are, and hydrates without a mismatch', async () => {
    const server = await setup()
    const html = renderToString(createElement(components().App, { open: server.open, done: server.done, labels: server.labels }))
    expect(html).toBe('<main><ul><li>Ask</li><li>Write</li></ul><p>1 done</p><p>3 labels</p></main>')
    server.views.dispose(true)

    const client = await setup()
    const { renders, App } = components()
    const el = dom(html)
    const errors: unknown[] = []
    let root!: ReturnType<typeof hydrateRoot>
    await act(() => {
      root = hydrateRoot(el, createElement(App, { open: client.open, done: client.done, labels: client.labels }), { onRecoverableError: (e) => errors.push(e) })
    })
    expect(errors).toEqual([])
    expect(el.innerHTML).toBe(html)
    await act(() => void client.views.apply({ add: [tdone(client.views, 'c')], remove: [] }))
    expect(el.textContent).toBe('Write2 done3 labels')
    expect(renders.labels).toBe(1)
    await act(() => root.unmount())
    client.views.dispose(true)
  })

  it('hears a change made between a render and its subscription', async () => {
    const { views, open } = await setup()
    let changed = false
    function Reader() {
      const rows = useRows(open)
      // The first render changes the data before React subscribes.
      if (!changed) {
        changed = true
        views.apply({ add: [tdone(views, 'c')], remove: [] })
      }
      return createElement('p', null, rows.map((r) => r.label).join(','))
    }
    const el = dom()
    const root = createRoot(el)
    await act(() => root.render(createElement(Reader)))
    expect(el.textContent).toBe('Write')
    await act(() => root.unmount())
    views.dispose(true)
  })
})
